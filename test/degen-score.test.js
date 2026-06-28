// Tests for degenScore — a pool's liquidity-relative efficiency on a 0..100 scale
// (geometric mean of trading / LP / fee / liquidity sub-scores). Pins the invariants
// the opportunity poller relies on: zero-on-any-empty-dimension, saturation, range,
// and the 30m-reference timeframe normalization that keeps targets stable across 5m/1h/24h.
import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";
import { degenScore } from "../tools/screening.js";

// A pool whose normalized inputs sit at/above every default target → saturates each sub-score.
const SATURATED = {
  active_tvl: 30000,
  volume_active_tvl_ratio: 100,
  fee_active_tvl_ratio: 1.0,
  unique_lps: 200,
  positions_created: 200,
};

function withTimeframe(tf, fn) {
  const prev = config.screening.timeframe;
  config.screening.timeframe = tf;
  try { return fn(); } finally { config.screening.timeframe = prev; }
}

test("invalid / zero active_tvl scores 0", () => {
  assert.equal(degenScore({ active_tvl: 0 }), 0);
  assert.equal(degenScore({ active_tvl: -5 }), 0);
  assert.equal(degenScore({}), 0);
  assert.equal(degenScore({ active_tvl: "not-a-number" }), 0);
});

test("any empty dimension zeroes the whole score (geometric mean)", () => {
  // Has liquidity + trading + fees + LP except one missing dimension → 0.
  const base = { active_tvl: 30000, volume_active_tvl_ratio: 100, fee_active_tvl_ratio: 1.0, unique_lps: 200, positions_created: 200 };
  assert.equal(degenScore({ ...base, volume_active_tvl_ratio: 0, volume_window: 0 }), 0, "no trading → 0");
  assert.equal(degenScore({ ...base, fee_active_tvl_ratio: 0, fee_window: 0 }), 0, "no fees → 0");
  assert.equal(degenScore({ ...base, unique_lps: 0, positions_created: 0 }), 0, "no LP activity → 0");
});

test("a fully saturated pool scores 100, and the score stays in [0,100]", () => {
  withTimeframe("5m", () => {
    const s = degenScore(SATURATED);
    assert.ok(s > 99.999, `expected ~100, got ${s}`);
    assert.ok(s <= 100);
  });
});

test("a partially-strong pool scores strictly between 0 and 100", () => {
  withTimeframe("30m", () => {
    // At the 30m reference (tfScale=1), modest inputs that don't saturate any target.
    const s = degenScore({
      active_tvl: 20000,
      volume_active_tvl_ratio: 5,   // target 20
      fee_active_tvl_ratio: 0.05,   // target 0.20
      unique_lps: 5,
      positions_created: 5,         // 10 vs target 40
    });
    assert.ok(s > 0 && s < 100, `expected (0,100), got ${s}`);
  });
});

test("timeframe normalization: identical raw inputs score higher on a shorter window", () => {
  // Rate inputs are scaled by 30/tfMinutes; a 5m window (×6) reads stronger than 24h (×0.0208)
  // for the SAME measured ratios — that's the normalization keeping targets timeframe-stable.
  const pool = {
    active_tvl: 20000,
    volume_active_tvl_ratio: 2,
    fee_active_tvl_ratio: 0.02,
    unique_lps: 3,
    positions_created: 3,
  };
  const s5m = withTimeframe("5m", () => degenScore(pool));
  const s24h = withTimeframe("24h", () => degenScore(pool));
  assert.ok(s5m > s24h, `expected 5m (${s5m}) > 24h (${s24h})`);
});

test("explicit targets override defaults (lower targets → higher score)", () => {
  withTimeframe("30m", () => {
    const pool = { active_tvl: 20000, volume_active_tvl_ratio: 5, fee_active_tvl_ratio: 0.05, unique_lps: 10, positions_created: 10 };
    const strict = degenScore(pool); // default targets
    const lax = degenScore(pool, { targetVolRatio: 5, targetLpCount: 20, targetFeeRatio: 0.05, targetLiquidity: 20000 });
    assert.ok(lax > strict, `expected lax (${lax}) > strict (${strict})`);
  });
});
