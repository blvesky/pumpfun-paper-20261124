# Pump.fun Paper Sprint bot

Broad launch sniper for the make.fun `agent-fun/replay/v2` harness
(Pump.fun Paper Sprint: Any Bot Can Win).

- Entry: coins 1–6 slots after creation, creator self-buy 0.3–3.0 SOL,
  ≥4 trades, 2–12 distinct non-creator buyers, real SOL 0.2–30, no big
  early dump, price within −20%/+50% of create. One buy per coin,
  0.12 SOL stake.
- Exits: take profit +12%, stop loss −6%, trailing stop (arm +20%,
  trail −8%), max hold 8 slots, exit on creator sell, stale after
  120 slots without a trade.
- Deterministic: pure function of the harness batches — no clock, no
  randomness, no I/O. Two runs produce identical action logs.

Run by the grader as `node /bot/main.ts` (Node 22, TypeScript stripped,
zero dependencies). The wire shim is `vendor/shim.ts`, written for this
entry; the strategy is `strategy.ts`.

License: MIT.
