// Pump.fun Paper Sprint — broad launch sniper (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts
// and the wire shim in vendor/shim.ts (written for this entry, no deps).
// One buy per coin, fast take-profit / stop-loss / trailing exits, creator
// filter on entry. See strategy.ts and STRATEGY.md for the full reasoning.

import { runBot } from './vendor/shim.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
