// main.ts — entrypoint for the Pump.fun paper sprint bot.
//
// The harness speaks agent-fun/replay/v2 on stdin/stdout; the vendored
// official SDK owns that wire. This file only builds the strategy and
// hands it the batches, one reply per batch, in slot order.

import { runBot } from "./vendor/makefun-bot.ts";
import { PaperSniper } from "./strategy.ts";

const sniper = new PaperSniper();

await runBot({
  onBatch: (state, batch) => sniper.decide(state, batch),
});
