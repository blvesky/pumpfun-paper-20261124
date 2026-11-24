// strategy.ts — Pump.fun paper sniper, V6 rules, written from the spec.
//
// The idea in one line: buy a coin only in its first few slots of life,
// only when the early tape looks like real buyers showed up behind an
// honest creator, and get out fast on fixed take-profit / stop-loss /
// trailing rules. Everything here is a pure function of the batches the
// harness sends: no clock, no environment, no randomness, so two runs of
// the same entry agree byte for byte.
//
// Prices are bonding-curve prices: virtual SOL reserves over virtual token
// reserves. Money is bigint lamports everywhere; ratios are compared by
// cross-multiplication so no float ever decides an order.

import type { Batch, BotState, OrderInput } from "./vendor/makefun-bot.ts";

// ------------------------------------------------------------------ sizing

const BUY_LAMPORTS = 120_000_000n; // 0.12 SOL per coin
const MIN_BUY_LAMPORTS = 12_000_000n; // 0.012 SOL: keeps the 0.01 SOL round-trip floor
const MAX_OPEN = 5; // at most five coins held at once
const MAX_ORDERS_HARD = 16; // per-batch order cap from the rules
const BUY_SLIPPAGE_BPS = 1000; // 10% tolerance on buys
const SELL_SLIPPAGE_BPS = 500; // 5% tolerance on sells: just get out

// ------------------------------------------------------------------ entry

const ENTRY_MIN_AGE = 1; // decide only in slots 1..8 after creation
const ENTRY_MAX_AGE = 8;

const CREATOR_BUY_MIN = 300_000_000n; // creator bought 0.3..3.0 SOL
const CREATOR_BUY_MAX = 3_000_000_000n;
const MIN_TRADES = 4; // at least four non-creator trades on the tape
const BUYERS_MIN = 2; // 2..12 distinct non-creator buyers
const BUYERS_MAX = 12;
const RESERVE_MIN = 200_000_000n; // real SOL reserve 0.2..30 SOL
const RESERVE_MAX = 30_000_000_000n;
const SINGLE_SELL_MAX_NUM = 3n; // one outsider sell is at most 30% of reserve
const SINGLE_SELL_MAX_DEN = 10n;
const PRICE_CEIL_NUM = 3n; // price vs creation price: up to +50% (3/2)
const PRICE_CEIL_DEN = 2n;

// ------------------------------------------------------------------- exit

const TAKE_PROFIT_NUM = 5n; // exit when the price is up 25% on the decision price
const TAKE_PROFIT_DEN = 4n;
const STOP_LOSS_NUM = 23n; // exit when the price is down 8% on the decision price
const STOP_LOSS_DEN = 25n;
const TRAIL_ARM_NUM = 13n; // trailing arms once the peak is up 30%
const TRAIL_ARM_DEN = 10n;
const TRAIL_DROP_NUM = 9n; // out on a 10% fall from the peak price
const TRAIL_DROP_DEN = 10n;
const MAX_HOLD_SLOTS = 60;
const DEAD_SLOTS = 120; // no trade for 120 slots counts as a dead coin

// ------------------------------------------------------------- per-coin tape

interface CoinNotes {
  creator: string;
  createdSlot: number | null;
  createQuote: bigint; // virtual SOL reserves at creation
  createTokens: bigint; // virtual token reserves at creation
  trades: number; // non-creator trades on the tape
  creatorBuyLamports: bigint;
  buyers: Set<string>;
  outsiderBuyLamports: bigint;
  outsiderSellLamports: bigint;
  biggestOutsiderSell: bigint;
  creatorDumped: boolean;
  lastTradeSlot: number;
  prevQuote: bigint; // virtual SOL reserves at the end of the previous batch
  prevTokens: bigint; // virtual token reserves at the end of the previous batch
}

function freshNotes(creator: string): CoinNotes {
  return {
    creator,
    createdSlot: null,
    createQuote: 0n,
    createTokens: 0n,
    trades: 0,
    creatorBuyLamports: 0n,
    buyers: new Set<string>(),
    outsiderBuyLamports: 0n,
    outsiderSellLamports: 0n,
    biggestOutsiderSell: 0n,
    creatorDumped: false,
    lastTradeSlot: -1,
    prevQuote: 0n,
    prevTokens: 0n,
  };
}

// ---------------------------------------------------------- an open position

interface OpenTrade {
  filledSlot: number; // slot the buy actually filled
  entryQuote: bigint; // virtual SOL reserves when the buy was decided
  entryTokens: bigint; // virtual token reserves when the buy was decided
  peakQuote: bigint; // virtual SOL reserves at the highest price since entry
  peakTokens: bigint; // virtual token reserves at the highest price since entry
}

// ------------------------------------------------------------------ strategy

export class PaperSniper {
  private notes = new Map<string, CoinNotes>();
  private open = new Map<string, OpenTrade>();
  private boughtOnce = new Set<string>();
  // Decision-time prices of buys still in flight, by mint.
  private pendingEntry = new Map<string, { quote: bigint; tokens: bigint }>();

  /** One batch, one reply: exits first, entries second. */
  decide(state: BotState, batch: Batch): OrderInput[] {
    this.absorbFills(state, batch);
    this.absorbEvents(batch);
    const cap = Math.min(MAX_ORDERS_HARD, state.hello.caps.max_orders_per_batch);
    const orders: OrderInput[] = [];
    this.planExits(state, batch, orders, cap);
    this.planEntries(state, batch, orders, cap);
    // Snapshot every curve's price for the next batch's momentum read.
    for (const curve of state.curves.values()) {
      const note = this.notes.get(curve.mint) ?? freshNotes("");
      note.prevQuote = curve.virtual_quote_reserves;
      note.prevTokens = curve.virtual_token_reserves;
      this.notes.set(curve.mint, note);
    }
    return orders;
  }

  // ------------------------------------------------------------ fill intake

  private absorbFills(state: BotState, batch: Batch): void {
    for (const fill of batch.fills) {
      if (fill.side === "buy" && fill.status === "filled") {
        const decided = this.pendingEntry.get(fill.mint);
        this.pendingEntry.delete(fill.mint);
        const curve = state.curves.get(fill.mint);
        const entryQuote = decided?.quote ?? curve?.virtual_quote_reserves ?? 0n;
        const entryTokens = decided?.tokens ?? curve?.virtual_token_reserves ?? 0n;
        this.open.set(fill.mint, {
          filledSlot: fill.decided_slot,
          entryQuote,
          entryTokens,
          peakQuote: entryQuote,
          peakTokens: entryTokens,
        });
      } else if (fill.side === "buy") {
        // Rejected or failed: the decision-time price is void.
        this.pendingEntry.delete(fill.mint);
      }
    }
    // A trade is over once the account no longer holds the mint. That
    // covers our own sells and the harness's own closes alike (its
    // `_complete_` / `_flatten_` / `_writeoff_` fills): only clear the
    // local record when the local position is actually gone.
    for (const mint of [...this.open.keys()]) {
      if (!state.positions.has(mint)) this.open.delete(mint);
    }
  }

  // ----------------------------------------------------------- event intake

  private absorbEvents(batch: Batch): void {
    for (const event of batch.events) {
      if (event.event === "CreateEvent") {
        const note = this.notes.get(event.mint) ?? freshNotes(event.creator);
        note.creator = event.creator;
        note.createdSlot = event.slot;
        note.createQuote = BigInt(event.virtual_quote_reserves);
        note.createTokens = BigInt(event.virtual_token_reserves);
        // The creation price is the "previous" price for the first batch.
        note.prevQuote = BigInt(event.virtual_quote_reserves);
        note.prevTokens = BigInt(event.virtual_token_reserves);
        this.notes.set(event.mint, note);
      } else if (event.event === "TradeEvent") {
        const note = this.notes.get(event.mint) ?? freshNotes(event.creator);
        note.creator = event.creator;
        const sol = BigInt(event.sol_amount);
        if (event.user !== event.creator) note.trades += 1;
        note.lastTradeSlot = event.slot;
        if (event.is_buy) {
          if (event.user === event.creator) {
            note.creatorBuyLamports += sol;
          } else {
            note.buyers.add(event.user);
            note.outsiderBuyLamports += sol;
          }
        } else if (event.user === event.creator) {
          note.creatorDumped = true;
        } else {
          note.outsiderSellLamports += sol;
          if (sol > note.biggestOutsiderSell) note.biggestOutsiderSell = sol;
        }
        this.notes.set(event.mint, note);
      }
      // CompleteEvent needs no note of its own: the curve's `complete`
      // flag already bars entries, and the harness closes the position.
    }
  }

  // ------------------------------------------------------------------ exits

  private planExits(state: BotState, batch: Batch, orders: OrderInput[], cap: number): void {
    for (const [mint, holding] of state.positions) {
      if (orders.length >= cap) break;
      // Never stack a second sell on one that is still in flight.
      if (this.hasPending(state, mint, "sell")) continue;
      const trade = this.open.get(mint);
      if (trade === undefined) continue;
      const note = this.notes.get(mint);
      const slot = batch.slot;

      let leave = false;
      // The creator selling is an instant exit.
      if (note !== undefined && note.creatorDumped) leave = true;
      // Time exits need no price at all, so they still fire when the
      // mark or the curve data is missing for this mint.
      if (note !== undefined && note.createdSlot !== null && slot - note.createdSlot >= MAX_HOLD_SLOTS) leave = true;
      if (note !== undefined && note.lastTradeSlot >= 0 && slot - note.lastTradeSlot >= DEAD_SLOTS) {
        leave = true;
      }

      const value = this.priceNow(state, mint, trade);
      if (value !== null) {
        const [curQuote, curTokens] = value;
        // Track the highest price since entry, by direct ratio compare.
        if (curQuote * trade.peakTokens > trade.peakQuote * curTokens) {
          trade.peakQuote = curQuote;
          trade.peakTokens = curTokens;
        }
        // Take-profit: price up 25% on the decision price.
        if (curQuote * trade.entryTokens * TAKE_PROFIT_DEN >= trade.entryQuote * curTokens * TAKE_PROFIT_NUM) {
          leave = true;
        }
        // Stop-loss: price down 8% on the decision price.
        if (curQuote * trade.entryTokens * STOP_LOSS_DEN <= trade.entryQuote * curTokens * STOP_LOSS_NUM) {
          leave = true;
        }
        // Trailing: armed at +30%, out on a 10% fall from the peak price.
        const armed = trade.peakQuote * trade.entryTokens * TRAIL_ARM_DEN >= trade.entryQuote * trade.peakTokens * TRAIL_ARM_NUM;
        const dropped = curQuote * trade.peakTokens * TRAIL_DROP_DEN <= trade.peakQuote * curTokens * TRAIL_DROP_NUM;
        if (armed && dropped) leave = true;
      }

      if (leave) {
        orders.push({
          side: "sell",
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
          client_id: state.clientId(),
        });
      }
    }
  }

  // ---------------------------------------------------------------- entries

  private planEntries(state: BotState, batch: Batch, orders: OrderInput[], cap: number): void {
    const txFee = state.txFeeLamports();
    let plannedSpend = 0n;
    let plannedBuys = 0;
    for (const curve of state.curves.values()) {
      if (orders.length >= cap) break;
      if (state.committedPositionCount() + plannedBuys >= MAX_OPEN) break;
      const mint = curve.mint;
      const note = this.notes.get(mint);
      if (note === undefined || note.createdSlot === null) continue;
      const age = batch.slot - note.createdSlot;
      if (age < ENTRY_MIN_AGE || age > ENTRY_MAX_AGE) continue;
      if (this.boughtOnce.has(mint)) continue;
      if (state.positions.has(mint)) continue;
      if (this.hasPending(state, mint, "buy")) continue;
      if (curve.complete) continue;
      if (note.creatorBuyLamports < CREATOR_BUY_MIN || note.creatorBuyLamports > CREATOR_BUY_MAX) continue;
      if (note.trades < MIN_TRADES) continue;
      if (note.buyers.size < BUYERS_MIN || note.buyers.size > BUYERS_MAX) continue;
      const reserve = curve.real_quote_reserves;
      if (reserve < RESERVE_MIN || reserve > RESERVE_MAX) continue;
      if (note.outsiderSellLamports * 2n > note.outsiderBuyLamports) continue;
      if (note.biggestOutsiderSell * SINGLE_SELL_MAX_DEN > reserve * SINGLE_SELL_MAX_NUM) continue;
      if (note.creatorDumped) continue;
      // Momentum: the price must have risen since the previous batch.
      if (note.prevTokens <= 0n) continue;
      if (curve.virtual_quote_reserves * note.prevTokens <= note.prevQuote * curve.virtual_token_reserves) {
        continue;
      }
      if (!this.priceInWindow(note, curve)) continue;

      // Never spend more than 1% of the real reserve on one buy; skip
      // the coin entirely when even that cap falls under the floor.
      const allowance = state.maxBuyLamports(mint);
      const size = BUY_LAMPORTS < allowance ? BUY_LAMPORTS : allowance;
      if (size < MIN_BUY_LAMPORTS) continue;
      if (state.freeCashLamports() - plannedSpend < size + txFee) continue;

      orders.push({
        side: "buy",
        mint,
        quote_lamports: size.toString(),
        max_slippage_bps: BUY_SLIPPAGE_BPS,
        client_id: state.clientId(),
      });
      this.pendingEntry.set(mint, {
        quote: curve.virtual_quote_reserves,
        tokens: curve.virtual_token_reserves,
      });
      this.boughtOnce.add(mint);
      plannedBuys += 1;
      plannedSpend += size + txFee;
    }
  }

  // ---------------------------------------------------------------- helpers

  /** Current curve price as a (quote, tokens) pair, or null when unknown. */
  private priceNow(state: BotState, mint: string, trade: OpenTrade): [bigint, bigint] | null {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.virtual_token_reserves <= 0n) return null;
    if (trade.entryTokens <= 0n) return null;
    return [curve.virtual_quote_reserves, curve.virtual_token_reserves];
  }

  /** Current price sits between the creation price and +50% above it. */
  private priceInWindow(
    note: CoinNotes,
    curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint },
  ): boolean {
    if (note.createQuote <= 0n || note.createTokens <= 0n) return false;
    if (curve.virtual_quote_reserves <= 0n || curve.virtual_token_reserves <= 0n) return false;
    // Compare current price against creation price by cross-multiplication:
    // now = curQuote / curTokens, then = createQuote / createTokens.
    const nowScaled = curve.virtual_quote_reserves * note.createTokens;
    const thenScaled = note.createQuote * curve.virtual_token_reserves;
    if (nowScaled < thenScaled) return false; // dipped below creation: out
    if (nowScaled * PRICE_CEIL_DEN > thenScaled * PRICE_CEIL_NUM) return false; // over +50%
    return true;
  }

  private hasPending(state: BotState, mint: string, side: "buy" | "sell"): boolean {
    for (const pending of state.pending.values()) {
      if (pending.order.mint === mint && pending.order.side === side) return true;
    }
    return false;
  }
}
