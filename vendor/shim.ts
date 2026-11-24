// Minimal agent-fun/replay/v2 wire shim, written for this entry.
// Speaks the harness protocol on stdin/stdout: one JSON line in per batch
// (hello / batch / done), exactly one reply line out per batch.
// No clock, no environment, no randomness: the strategy's decisions are a
// pure function of the batches, so two runs produce identical action logs.
//
// Wire summary (from the kit's protocol description):
// - hello: { type:'hello', protocol:'agent-fun/replay/v2', seed, universe,
//   capital:{lamports}, caps, latency_slots, fees }.
// - batch: { type:'batch', seq, slot, events, marks, fills, account }.
//   events are CreateEvent / TradeEvent / CompleteEvent records; marks carry
//   the latest reserves of held/pending mints; fills report how sent orders
//   resolved (filled / rejected / failed); harness closes arrive as sell
//   fills with client_id '_complete_<n>' / '_flatten_<n>' / '_writeoff_<n>'.
// - reply: { type:'reply', seq, orders } where each order is a buy
//   { side:'buy', client_id, mint, quote_lamports, max_slippage_bps } or a
//   sell { side:'sell', client_id, mint, token_amount, max_slippage_bps }.
// - done: { type:'done', seq, reason, account }; no reply is sent.

export const PROTOCOL = 'agent-fun/replay/v2';
export const MAX_HARNESS_LINE_BYTES = 1_048_576;
export const MAX_BOT_LINE_BYTES = 65_536;
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const BPS = 10_000n;
export const U64_MAX = 18_446_744_073_709_551_615n;

export type U64 = string;
export type Pubkey = string;

export interface Universe {
  program: string;
  quote: 'SOL';
  mayhem: 'excluded';
  exclude_cashback: true;
  sample: { hash: 'sha256'; modulus: number; residue: number };
}

export interface Caps {
  max_open_positions: number;
  max_order_bps_of_real_reserve: number;
  max_orders_per_batch: number;
  shorts: false;
  leverage: false;
}

export interface Fees {
  protocol_bps_fallback: number;
  creator_bps_fallback: number;
  base_fee_lamports: U64;
  priority_fee_lamports: U64;
  failed_tx_bps: number;
}

export interface Hello {
  type: 'hello';
  protocol: typeof PROTOCOL;
  seed: U64;
  universe: Universe;
  capital: { lamports: U64 };
  caps: Caps;
  latency_slots: number;
  fees: Fees;
}

export interface ChainMeta {
  slot: number;
  signature: string;
  block_time: number | null;
  chain_seq: number;
}

export interface TradeEventRecord extends ChainMeta {
  event: 'TradeEvent';
  mint: Pubkey;
  sol_amount: U64;
  token_amount: U64;
  is_buy: boolean;
  user: Pubkey;
  timestamp: string;
  virtual_sol_reserves: U64;
  virtual_token_reserves: U64;
  real_sol_reserves: U64;
  real_token_reserves: U64;
  creator: Pubkey;
  virtual_quote_reserves: U64;
  real_quote_reserves: U64;
  quote_mint: Pubkey;
}

export interface CreateEventRecord extends ChainMeta {
  event: 'CreateEvent';
  name: string;
  symbol: string;
  mint: Pubkey;
  bonding_curve: Pubkey;
  user: Pubkey;
  creator: Pubkey;
  timestamp: string;
  virtual_token_reserves: U64;
  virtual_sol_reserves: U64;
  real_token_reserves: U64;
  token_total_supply: U64;
  quote_mint: Pubkey;
  virtual_quote_reserves: U64;
  creator_fee_bps: U64;
  is_holder_reward: boolean;
  depth: number;
}

export interface CompleteEventRecord extends ChainMeta {
  event: 'CompleteEvent';
  user: Pubkey;
  mint: Pubkey;
  bonding_curve: Pubkey;
  timestamp: string;
  quote_mint: Pubkey;
}

export type ChainEvent = TradeEventRecord | CreateEventRecord | CompleteEventRecord;

export interface Mark {
  mint: Pubkey;
  slot: number;
  virtual_token_reserves: U64;
  virtual_quote_reserves: U64;
  real_token_reserves: U64;
  real_quote_reserves: U64;
}

export interface Position {
  mint: Pubkey;
  token_amount: U64;
  cost_lamports: U64;
}

export interface Account {
  cash_lamports: U64;
  positions: Position[];
}

export type Side = 'buy' | 'sell';

export type RejectReason =
  | 'max_slippage' | 'max_open_positions' | 'max_order_size'
  | 'max_orders_per_batch' | 'insufficient_cash' | 'insufficient_tokens'
  | 'not_in_universe' | 'token_complete' | 'zero_amount'
  | 'duplicate_client_id' | 'after_end';

export interface Fill {
  client_id: string;
  mint: Pubkey;
  side: Side;
  status: 'filled' | 'rejected' | 'failed';
  reason: RejectReason | null;
  decided_slot: number;
  slot: number;
  quote_lamports: U64;
  token_amount: U64;
  fee_lamports: U64;
  tx_fee_lamports: U64;
  fee_fallback: boolean;
}

export interface Batch {
  type: 'batch';
  seq: number;
  slot: number;
  events: ChainEvent[];
  marks: Mark[];
  fills: Fill[];
  account: Account;
}

export interface Done {
  type: 'done';
  seq: number;
  reason: 'end_of_data' | 'aborted';
  account: Account;
}

export type HarnessMessage = Hello | Batch | Done;

export interface BuyOrder {
  side: 'buy';
  client_id: string;
  mint: Pubkey;
  quote_lamports: U64;
  max_slippage_bps: number;
}

export interface SellOrder {
  side: 'sell';
  client_id: string;
  mint: Pubkey;
  token_amount: U64;
  max_slippage_bps: number;
}

export type Order = BuyOrder | SellOrder;

export interface Reply {
  type: 'reply';
  seq: number;
  orders: Order[];
}

export type Amount = bigint | string | number;

export interface BuyInput {
  side: 'buy';
  mint: Pubkey;
  quote_lamports: Amount;
  max_slippage_bps: number;
  client_id?: string;
}

export interface SellInput {
  side: 'sell';
  mint: Pubkey;
  token_amount: Amount;
  max_slippage_bps: number;
  client_id?: string;
}

export type OrderInput = BuyInput | SellInput;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export class OrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderError';
  }
}

export interface Curve {
  readonly mint: Pubkey;
  created_slot: number | null;
  virtual_token_reserves: bigint;
  virtual_quote_reserves: bigint;
  real_token_reserves: bigint;
  real_quote_reserves: bigint;
  reserves_slot: number;
  trades: number;
  complete: boolean;
}

export interface Holding {
  token_amount: bigint;
  cost_lamports: bigint;
}

export interface PendingOrder {
  readonly order: Order;
  readonly seq: number;
  readonly decided_slot: number;
}

const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/;

/** Everything the bot knows, kept current by runBot before each callback. */
export class BotState {
  readonly hello: Hello;
  seq = -1;
  slot = -1;
  account: Account;
  cash: bigint;
  readonly positions = new Map<Pubkey, Holding>();
  readonly curves = new Map<Pubkey, Curve>();
  readonly pending = new Map<string, PendingOrder>();
  #used = new Set<string>();
  #next = 1;

  constructor(hello: Hello) {
    this.hello = hello;
    this.account = { cash_lamports: hello.capital.lamports, positions: [] };
    this.cash = BigInt(hello.capital.lamports);
  }

  clientId(): string {
    const id = this.#freeId(null);
    this.#used.add(id);
    return id;
  }

  /** Base + priority fee every sent order pays, filled or not. */
  txFeeLamports(): bigint {
    return BigInt(this.hello.fees.base_fee_lamports) + BigInt(this.hello.fees.priority_fee_lamports);
  }

  /** Most this batch's buys on this mint may spend together; 0 when unknown/complete. */
  maxBuyLamports(mint: Pubkey): bigint {
    const c = this.curves.get(mint);
    if (c === undefined || c.complete) return 0n;
    return (c.real_quote_reserves * BigInt(this.hello.caps.max_order_bps_of_real_reserve)) / BPS;
  }

  /** Mints held plus mints with a buy pending: counts against max_open_positions. */
  committedPositionCount(): number {
    const mints = new Set<Pubkey>(this.positions.keys());
    for (const p of this.pending.values()) if (p.order.side === 'buy') mints.add(p.order.mint);
    return mints.size;
  }

  /** Cash minus what pending orders will take if they fill (buy amounts + every tx fee). */
  freeCashLamports(): bigint {
    const tx = this.txFeeLamports();
    let free = this.cash;
    for (const p of this.pending.values()) {
      free -= tx;
      if (p.order.side === 'buy') free -= BigInt(p.order.quote_lamports);
    }
    return free;
  }

  /** Fold a batch in: fills, account, marks, then events (in that order). */
  applyBatch(batch: Batch): void {
    this.seq = batch.seq;
    this.slot = batch.slot;
    for (const f of batch.fills) this.pending.delete(f.client_id);
    this.#setAccount(batch.account);
    for (const m of batch.marks) {
      const c = this.curves.get(m.mint);
      if (c !== undefined && m.slot < c.reserves_slot) continue;
      const curve = c ?? this.#newCurve(m.mint, null, m.slot);
      curve.virtual_token_reserves = BigInt(m.virtual_token_reserves);
      curve.virtual_quote_reserves = BigInt(m.virtual_quote_reserves);
      curve.real_token_reserves = BigInt(m.real_token_reserves);
      curve.real_quote_reserves = BigInt(m.real_quote_reserves);
      curve.reserves_slot = m.slot;
    }
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const curve = this.#newCurve(e.mint, e.slot, e.slot);
        curve.virtual_token_reserves = BigInt(e.virtual_token_reserves);
        curve.virtual_quote_reserves = BigInt(e.virtual_quote_reserves);
        curve.real_token_reserves = BigInt(e.real_token_reserves);
        curve.real_quote_reserves = 0n;
      } else if (e.event === 'TradeEvent') {
        const curve = this.curves.get(e.mint) ?? this.#newCurve(e.mint, null, e.slot);
        curve.virtual_token_reserves = BigInt(e.virtual_token_reserves);
        curve.virtual_quote_reserves = BigInt(e.virtual_quote_reserves);
        curve.real_token_reserves = BigInt(e.real_token_reserves);
        curve.real_quote_reserves = BigInt(e.real_quote_reserves);
        curve.reserves_slot = e.slot;
        curve.trades += 1;
      } else {
        const curve = this.curves.get(e.mint) ?? this.#newCurve(e.mint, null, e.slot);
        curve.complete = true;
      }
    }
  }

  applyDone(done: Done): void {
    this.seq = done.seq;
    this.#setAccount(done.account);
  }

  /** Validate what onBatch returned and turn it into wire orders. */
  toOrders(result: unknown): Order[] {
    if (result === undefined || result === null) return [];
    if (!Array.isArray(result)) throw new OrderError(`batch ${this.seq}: onBatch must return an array of orders`);
    const cap = Math.min(16, this.hello.caps.max_orders_per_batch);
    if (result.length > cap) {
      throw new OrderError(`batch ${this.seq}: ${result.length} orders, over max_orders_per_batch (${cap})`);
    }
    const checked = result.map((o: unknown, i: number) => checkOrder(o, `batch ${this.seq} order ${i}`));
    const taken = new Set<string>();
    for (const o of checked) {
      if (o.client_id === undefined) continue;
      if (taken.has(o.client_id) || this.#used.has(o.client_id)) {
        throw new OrderError(`batch ${this.seq}: duplicate client_id "${o.client_id}"`);
      }
      taken.add(o.client_id);
    }
    return checked.map((o) => {
      const client_id = o.client_id ?? this.#freeId(taken);
      taken.add(client_id);
      return o.side === 'buy'
        ? { side: 'buy', client_id, mint: o.mint, quote_lamports: o.amount, max_slippage_bps: o.max_slippage_bps }
        : { side: 'sell', client_id, mint: o.mint, token_amount: o.amount, max_slippage_bps: o.max_slippage_bps };
    });
  }

  /** Record orders as sent: they stay pending until their fill arrives. */
  recordOrders(orders: readonly Order[]): void {
    for (const order of orders) {
      this.#used.add(order.client_id);
      this.pending.set(order.client_id, { order, seq: this.seq, decided_slot: this.slot });
    }
  }

  #freeId(taken: Set<string> | null): string {
    for (;;) {
      const id = `o${this.#next++}`;
      if (!this.#used.has(id) && (taken === null || !taken.has(id))) return id;
    }
  }

  #newCurve(mint: Pubkey, created: number | null, slot: number): Curve {
    const curve: Curve = {
      mint,
      created_slot: created,
      virtual_token_reserves: 0n,
      virtual_quote_reserves: 0n,
      real_token_reserves: 0n,
      real_quote_reserves: 0n,
      reserves_slot: slot,
      trades: 0,
      complete: false,
    };
    this.curves.set(mint, curve);
    return curve;
  }

  #setAccount(account: Account): void {
    this.account = account;
    this.cash = BigInt(account.cash_lamports);
    this.positions.clear();
    for (const p of account.positions) {
      const tokens = BigInt(p.token_amount);
      if (tokens > 0n) this.positions.set(p.mint, { token_amount: tokens, cost_lamports: BigInt(p.cost_lamports) });
    }
  }
}

interface CheckedOrder {
  side: Side;
  client_id: string | undefined;
  mint: Pubkey;
  amount: U64;
  max_slippage_bps: number;
}

const BUY_KEYS = new Set(['side', 'client_id', 'mint', 'quote_lamports', 'max_slippage_bps']);
const SELL_KEYS = new Set(['side', 'client_id', 'mint', 'token_amount', 'max_slippage_bps']);

function checkOrder(value: unknown, where: string): CheckedOrder {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OrderError(`${where}: expected an order object`);
  }
  const o = value as Record<string, unknown>;
  if (o.side !== 'buy' && o.side !== 'sell') throw new OrderError(`${where}: side must be "buy" or "sell"`);
  const allowed = o.side === 'buy' ? BUY_KEYS : SELL_KEYS;
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) throw new OrderError(`${where}: unknown key "${k}" on a ${o.side} order`);
  }
  if (typeof o.mint !== 'string' || !PUBKEY_RE.test(o.mint)) throw new OrderError(`${where}: mint must be a base58 address`);
  const amountKey = o.side === 'buy' ? 'quote_lamports' : 'token_amount';
  const amount = toU64(o[amountKey], `${where}: ${amountKey}`);
  const bps = o.max_slippage_bps;
  if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new OrderError(`${where}: max_slippage_bps must be an integer 0..10000`);
  }
  let client_id: string | undefined;
  if (o.client_id !== undefined) {
    if (typeof o.client_id !== 'string' || !CLIENT_ID_RE.test(o.client_id)) {
      throw new OrderError(`${where}: client_id must be 1-64 of [A-Za-z0-9_-] not starting with _`);
    }
    client_id = o.client_id;
  }
  return { side: o.side, client_id, mint: o.mint, amount, max_slippage_bps: bps };
}

export function toU64(value: unknown, what = 'amount'): U64 {
  let n: bigint | null = null;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === 'string' && U64_RE.test(value)) n = BigInt(value);
  if (n === null || n < 0n || n > U64_MAX) throw new OrderError(`${what} must be a u64`);
  return n.toString();
}

function describe(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return JSON.stringify(value.length > 80 ? `${value.slice(0, 77)}...` : value);
  if (value === null || typeof value !== 'object') return String(value);
  return Array.isArray(value) ? 'an array' : 'an object';
}

export async function* readLines(
  input: AsyncIterable<Uint8Array | string>,
  maxBytes = MAX_HARNESS_LINE_BYTES,
): AsyncGenerator<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let parts: Uint8Array[] = [];
  let size = 0;
  let lineNo = 0;
  const take = (last: Uint8Array): string => {
    let bytes: Uint8Array = last;
    if (parts.length > 0) {
      bytes = new Uint8Array(size);
      let at = 0;
      for (const p of [...parts, last]) {
        bytes.set(p, at);
        at += p.byteLength;
      }
    }
    parts = [];
    size = 0;
    lineNo++;
    if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 0x0d) bytes = bytes.subarray(0, bytes.byteLength - 1);
    try {
      return decoder.decode(bytes);
    } catch {
      throw new ProtocolError(`input line ${lineNo} is not valid UTF-8`);
    }
  };
  for await (const chunk of input) {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    let start = 0;
    for (;;) {
      const nl = bytes.indexOf(0x0a, start);
      if (nl === -1) break;
      const piece = bytes.subarray(start, nl);
      if (size + piece.byteLength > maxBytes) throw new ProtocolError(`input line ${lineNo + 1} is over ${maxBytes} bytes`);
      size += piece.byteLength;
      yield take(piece);
      start = nl + 1;
    }
    if (start < bytes.byteLength) {
      const rest = new Uint8Array(bytes.subarray(start));
      size += rest.byteLength;
      if (size > maxBytes) throw new ProtocolError(`input line ${lineNo + 1} is over ${maxBytes} bytes`);
      parts.push(rest);
    }
  }
  if (size > 0) yield take(new Uint8Array(0));
}

export interface LineWriter {
  write(chunk: string): unknown;
  once?(event: 'drain', listener: () => void): unknown;
}

export interface BotIO {
  input?: AsyncIterable<Uint8Array | string>;
  output?: LineWriter;
}

export type OrdersResult = readonly OrderInput[] | void | null | undefined;

export interface Bot {
  onHello?(state: BotState): void | Promise<void>;
  onBatch(state: BotState, batch: Batch): OrdersResult | Promise<OrdersResult>;
  onDone?(state: BotState, done: Done): void | Promise<void>;
}

export interface RunResult {
  state: BotState;
  done: Done;
  batches: number;
}

/** Speak agent-fun/replay/v2 on stdin/stdout until done. */
export async function runBot(bot: Bot, io: BotIO = {}): Promise<RunResult> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const encoder = new TextEncoder();
  let state: BotState | null = null;
  let batches = 0;
  let lineNo = 0;
  for await (const line of readLines(input)) {
    lineNo++;
    if (line.trim() === '') continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      throw new ProtocolError(`input line ${lineNo} is not JSON`);
    }
    const type = typeof msg === 'object' && msg !== null && !Array.isArray(msg) ? (msg as { type?: unknown }).type : undefined;
    if (type === 'hello') {
      const hello = msg as Hello;
      if (state !== null) throw new ProtocolError(`input line ${lineNo}: a second hello`);
      if (hello.protocol !== PROTOCOL) throw new ProtocolError(`the harness speaks ${describe(hello.protocol)}; this shim speaks ${PROTOCOL}`);
      state = new BotState(hello);
      await bot.onHello?.(state);
    } else if (type === 'batch') {
      const batch = msg as Batch;
      if (state === null) throw new ProtocolError(`input line ${lineNo}: a batch before hello`);
      checkBatch(batch, lineNo);
      state.applyBatch(batch);
      const orders = state.toOrders(await bot.onBatch(state, batch));
      const reply: Reply = { type: 'reply', seq: batch.seq, orders };
      const text = JSON.stringify(reply);
      const bytes = encoder.encode(text).byteLength;
      if (bytes > MAX_BOT_LINE_BYTES) throw new OrderError(`batch ${batch.seq}: reply is ${bytes} bytes (max ${MAX_BOT_LINE_BYTES})`);
      state.recordOrders(orders);
      const ok = output.write(`${text}\n`);
      if (ok === false && typeof output.once === 'function') {
        await new Promise<void>((resolve) => (output.once as (e: 'drain', l: () => void) => void)('drain', resolve));
      }
      batches++;
    } else if (type === 'done') {
      const done = msg as Done;
      if (state === null) throw new ProtocolError(`input line ${lineNo}: done before hello`);
      state.applyDone(done);
      await bot.onDone?.(state, done);
      return { state, done, batches };
    } else {
      throw new ProtocolError(`input line ${lineNo}: unknown message type ${describe(type)}`);
    }
  }
  throw new ProtocolError(state === null ? 'input ended before hello' : `input ended before done (after ${batches} batches)`);
}

function checkBatch(batch: Batch, lineNo: number): void {
  const ok =
    Number.isSafeInteger(batch.seq) &&
    Number.isSafeInteger(batch.slot) &&
    Array.isArray(batch.events) &&
    Array.isArray(batch.marks) &&
    Array.isArray(batch.fills) &&
    typeof batch.account === 'object' &&
    batch.account !== null &&
    Array.isArray(batch.account.positions);
  if (!ok) throw new ProtocolError(`input line ${lineNo}: malformed batch`);
}
