// Regression: OOR-to-the-right must not be recorded as a "bad" pattern lesson.
//
// This agent deploys single-sided SOL with `bins_below` only (active bin = TOP of
// range). The ONLY way it goes out of range is price rising ABOVE the range
// (`active_bin > upper_bin`) — the close reasons "pumped far above range" / "OOR".
// That exit returns ~100% SOL with ZERO impermanent loss: a neutral-to-good event,
// not a failure. Yet the lesson engine used to mint an
//   `AVOID: <pool>-type pools ... went OOR X% of the time. Consider wider bin_range`
// lesson (tagged "oor") for any low-range-efficiency loss — polarity-wrong for this
// strategy: widening a bins-below range only accumulates MORE token on the eventual
// dump, and the "oor" tag biases future screening away from perfectly fine pools.
//
// Fix: an above-range OOR close is not itself the failure. When a losing close's
// reason is an above-range OOR, record it as an honest FAILED note (attributing the
// PnL) WITHOUT the "widen the range / avoid" prescription and WITHOUT the "oor" tag.
// A genuine non-OOR loss (e.g. stop loss) still yields the AVOID lesson.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAboveRangeOorReason, derivLesson } from "../lessons.js";

test("isAboveRangeOorReason recognizes the above-range OOR close reasons", () => {
  assert.equal(isAboveRangeOorReason("pumped far above range"), true);
  assert.equal(isAboveRangeOorReason("OOR"), true);
  assert.equal(isAboveRangeOorReason("out of range too long"), true);
});

test("isAboveRangeOorReason rejects non-OOR close reasons", () => {
  assert.equal(isAboveRangeOorReason("stop loss"), false);
  assert.equal(isAboveRangeOorReason("low yield"), false);
  assert.equal(isAboveRangeOorReason(""), false);
  assert.equal(isAboveRangeOorReason(null), false);
});

// Minimal "bad outcome" perf (pnl_pct=-8 → outcome "bad"), low range efficiency
// (price left the range) — the exact shape that used to trigger AVOID-went-OOR.
function badPerf(overrides = {}) {
  return {
    pool_name: "CATWIF-SOL",
    strategy: "single_sided_reseed",
    bin_step: 100,
    volatility: 3,
    fee_tvl_ratio: 0.4,
    organic_score: 70,
    bin_range: 30,
    initial_value_usd: 100,
    fees_earned_usd: 0,
    pnl_pct: -8,
    range_efficiency: 20,
    close_reason: "pumped far above range",
    ...overrides,
  };
}

test("an above-range OOR loss is recorded as FAILED, not an AVOID-widen-range lesson", () => {
  const lesson = derivLesson(badPerf());
  assert.ok(lesson, "expected a lesson to be derived for a bad outcome");
  assert.ok(lesson.rule.startsWith("FAILED"), `expected FAILED note, got: ${lesson.rule}`);
  assert.ok(!lesson.rule.includes("AVOID"), `must not prescribe AVOID, got: ${lesson.rule}`);
  assert.ok(!lesson.rule.includes("wider bin_range"), `must not prescribe widening the range, got: ${lesson.rule}`);
  assert.ok(!lesson.tags.includes("oor"), `must not tag an above-range OOR exit as "oor", got: ${lesson.tags}`);
});

test("a genuine non-OOR loss (stop loss) still yields the AVOID lesson", () => {
  const lesson = derivLesson(badPerf({ close_reason: "stop loss" }));
  assert.ok(lesson, "expected a lesson to be derived");
  assert.ok(lesson.rule.startsWith("AVOID"), `expected AVOID, got: ${lesson.rule}`);
});
