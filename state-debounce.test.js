import { test } from "node:test";
import assert from "node:assert/strict";
import { chartExitDebounceDecision } from "./state.js";

const MAX = 35 * 60_000; // 35 min staleness window
const T = 1_700_000_000_000;

test("first active chart-exit signal arms the debounce but does not close", () => {
  const d = chartExitDebounceDecision({ pendingSince: null, signalActive: true, nowMs: T, maxAgeMs: MAX });
  assert.equal(d.close, false);
  assert.equal(d.nextPendingSince, T);
});

test("second consecutive active signal (within window) confirms the close", () => {
  const armed = T;
  const d = chartExitDebounceDecision({ pendingSince: armed, signalActive: true, nowMs: T + 10 * 60_000, maxAgeMs: MAX });
  assert.equal(d.close, true);
  assert.equal(d.nextPendingSince, null);
});

test("signal clearing before the second cycle disarms the debounce", () => {
  const d = chartExitDebounceDecision({ pendingSince: T, signalActive: false, nowMs: T + 10 * 60_000, maxAgeMs: MAX });
  assert.equal(d.close, false);
  assert.equal(d.nextPendingSince, null);
});

test("no signal and no pending stays disarmed", () => {
  const d = chartExitDebounceDecision({ pendingSince: null, signalActive: false, nowMs: T, maxAgeMs: MAX });
  assert.equal(d.close, false);
  assert.equal(d.nextPendingSince, null);
});

test("a stale pending re-arms instead of closing (e.g. after a long pause)", () => {
  const d = chartExitDebounceDecision({ pendingSince: T, signalActive: true, nowMs: T + MAX + 1, maxAgeMs: MAX });
  assert.equal(d.close, false, "too old to count as the immediately-preceding cycle");
  assert.equal(d.nextPendingSince, T + MAX + 1, "re-armed at now");
});
