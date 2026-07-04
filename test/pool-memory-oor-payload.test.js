// Regression: the get_pool_memory payload must not present benign above-range OOR
// closes as losses.
//
// This agent deploys single-sided SOL with `bins_below` only (active bin = TOP of
// range). The ONLY way a position leaves the range is price rising ABOVE it
// (close_reason "pumped far above range" / "OOR" / "out of range"): it exits to
// ~100% SOL with ZERO impermanent loss — principal preserved, not a loss.
//
// Yet getPoolMemory used to hand the screener LLM a RAW `win_rate` (every OOR close
// counted as a non-win) plus a `history` of OOR-stamped closes, so a pool that only
// ever exited above-range looked like a catastrophic ~0% win-rate failure. The LLM
// then rejected the pool ("POOL MEMORY FAILURE ... win rate 0.5% ... OOR 2/2").
//
// Fix (scoped to above-range OOR only): lead with the adjusted win rate (which
// excludes benign OOR exits), demote the raw rate, annotate above-range OOR history
// entries as benign, and — critically — report win_rate as null (not 0%) when every
// prior deploy was a benign OOR exit so there is no win/loss basis. Genuine non-OOR
// losses are untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAboveRangeOorReason, buildPoolMemorySummary } from "../pool-memory.js";

function oorDeploy(overrides = {}) {
  return {
    deployed_at: "2026-07-01T00:00:00.000Z",
    closed_at: "2026-07-01T00:08:00.000Z",
    pnl_pct: -0.3, // minor fees/slippage, NOT impermanent loss
    close_reason: "pumped far above range",
    strategy: "single_sided_reseed",
    ...overrides,
  };
}

function lossDeploy(overrides = {}) {
  return {
    deployed_at: "2026-07-01T00:00:00.000Z",
    closed_at: "2026-07-01T02:00:00.000Z",
    pnl_pct: -12, // real downside loss
    close_reason: "stop loss",
    strategy: "single_sided_reseed",
    ...overrides,
  };
}

// Mirrors how recordPerformance recomputes aggregates so fixtures are realistic.
function entryFrom(deploys, extra = {}) {
  const withPnl = deploys.filter((d) => d.pnl_pct != null);
  const adjusted = withPnl.filter((d) => !isAboveRangeOorReason(d.close_reason));
  const last = deploys[deploys.length - 1];
  return {
    name: "YEP-SOL",
    base_mint: "5pYB12kE",
    deploys,
    total_deploys: deploys.length,
    avg_pnl_pct: withPnl.length
      ? Math.round((withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length) * 100) / 100
      : 0,
    win_rate: withPnl.length
      ? Math.round((withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length) * 100) / 100
      : 0,
    adjusted_win_rate: adjusted.length
      ? Math.round((adjusted.filter((d) => d.pnl_pct >= 0).length / adjusted.length) * 10000) / 100
      : 0,
    adjusted_win_rate_sample_count: adjusted.length,
    last_outcome: (last?.pnl_pct ?? 0) >= 0 ? "profit" : "loss",
    notes: [],
    ...extra,
  };
}

test("isAboveRangeOorReason recognizes above-range OOR close reasons", () => {
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

test("above-range OOR history entries are annotated benign; genuine losses are not", () => {
  const entry = entryFrom([oorDeploy(), lossDeploy()]);
  const summary = buildPoolMemorySummary(entry, "poolX");

  const oorEntry = summary.history.find((h) => h.close_reason === "pumped far above range");
  const lossEntry = summary.history.find((h) => h.close_reason === "stop loss");

  assert.equal(oorEntry.oor_benign, true, "above-range OOR entry must be flagged benign");
  assert.ok(/zero impermanent loss/i.test(oorEntry.oor_note), "benign note must state zero IL");

  assert.equal(lossEntry.oor_benign, undefined, "a genuine loss must NOT be flagged benign");
  assert.equal(lossEntry.oor_note, undefined, "a genuine loss must carry no benign note");
});

test("all-OOR pool reports win_rate null (not 0%) with a not-a-failure note", () => {
  // The exact CATWIF/yep case: every prior deploy exited above-range.
  const entry = entryFrom([oorDeploy(), oorDeploy({ minutes_held: 8 })]);
  const summary = buildPoolMemorySummary(entry, "poolY");

  assert.equal(summary.win_rate, null, "no non-OOR deploy → win_rate must be null, not 0");
  assert.equal(summary.win_rate_sample_count, 0);
  assert.equal(summary.above_range_oor_count, 2);
  assert.ok(summary.win_rate_note, "must explain the null win rate");
  assert.ok(
    /not a losing|not a failed/i.test(summary.win_rate_note),
    `note must say this is not a failed pool, got: ${summary.win_rate_note}`,
  );
});

test("genuine non-OOR losses still drive win_rate (fix is scoped to OOR)", () => {
  // One benign OOR exit + one real loss + one win: adjusted win rate = 1 win / 2
  // non-OOR deploys = 50%. The real loss must remain visible.
  const entry = entryFrom([
    oorDeploy(),
    lossDeploy(),
    { pnl_pct: 20, close_reason: "take profit", strategy: "single_sided_reseed" },
  ]);
  const summary = buildPoolMemorySummary(entry, "poolZ");

  assert.equal(summary.win_rate, 50, "adjusted win rate must reflect the genuine loss");
  assert.equal(summary.win_rate_sample_count, 2);
  assert.equal(summary.above_range_oor_count, 1);
  assert.equal(summary.raw_win_rate_incl_oor, entry.win_rate, "raw rate preserved for transparency");
});

test("last_outcome carries a benign note when the last close was above-range OOR", () => {
  const entry = entryFrom([lossDeploy(), oorDeploy()]);
  const summary = buildPoolMemorySummary(entry, "poolW");
  assert.equal(summary.last_outcome, "loss", "raw last_outcome unchanged for honesty");
  assert.ok(
    summary.last_outcome_note && /above-range oor/i.test(summary.last_outcome_note),
    `expected a benign last_outcome note, got: ${summary.last_outcome_note}`,
  );
});
