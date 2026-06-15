// Regression test for the trailing-TP phantom-peak bug (WOC-SOL 2026-06-14).
//
// A single RPC poll tick read +2.68% PnL on a position whose real PnL never
// exceeded ~0% (every 3-min snapshot was between 0% and -2%). Because the relay
// path accepts peaks immediately (no recheck), that one present-but-wrong tick
// set peak_pnl_pct=2.68, armed trailing TP (trigger 1.7%), and the very next
// tick (-4.37%) closed the position on a phantom 7.05% drawdown.
//
// The guard: a peak that leaps more than maxJumpPct above the last confirmed
// peak in a SINGLE tick must not be accepted immediately — it has to survive a
// re-poll first. peakJumpNeedsConfirmation() is that decision.
import { test } from "node:test";
import assert from "node:assert/strict";
import { peakJumpNeedsConfirmation } from "../peak-guard.js";

test("the WOC-SOL spike (0.05% -> 2.68%, threshold 1.5%) needs confirmation", () => {
  assert.equal(peakJumpNeedsConfirmation(0.05, 2.68, 1.5), true);
});

test("a normal small peak ratchet is accepted (no confirmation)", () => {
  assert.equal(peakJumpNeedsConfirmation(1.2, 1.5, 1.5), false); // jump 0.3
});

test("a jump exactly at the threshold is allowed (boundary is strict >)", () => {
  assert.equal(peakJumpNeedsConfirmation(0, 1.5, 1.5), false);
  assert.equal(peakJumpNeedsConfirmation(0, 1.51, 1.5), true);
});

test("null current peak is treated as 0% baseline", () => {
  assert.equal(peakJumpNeedsConfirmation(null, 2.0, 1.5), true);
  assert.equal(peakJumpNeedsConfirmation(null, 1.0, 1.5), false);
});

test("guard is disabled when maxJumpPct is null/0/negative", () => {
  assert.equal(peakJumpNeedsConfirmation(0, 99, null), false);
  assert.equal(peakJumpNeedsConfirmation(0, 99, 0), false);
  assert.equal(peakJumpNeedsConfirmation(0, 99, -1), false);
});

test("null/downward candidate never needs confirmation", () => {
  assert.equal(peakJumpNeedsConfirmation(0, null, 1.5), false);
  assert.equal(peakJumpNeedsConfirmation(0, -5, 1.5), false);
});
