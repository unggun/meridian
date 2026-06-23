// Regression test for computeRealizedPnl (2026-06-23).
// Realized PnL = wallet SOL recovered at close − wallet SOL spent at deploy.
// Rent cancels (both legs carry it); pct is over the liquidity at risk (amountSol).
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRealizedPnl } from "../tools/realized-pnl.js";

test("QUEST close: recovered 1.1954, deployCost 1.2074, amount 1.15 → -0.0120 / -1.04%", () => {
  const r = computeRealizedPnl({ recovered: 1.1954, deployCostSol: 1.2074, amountSol: 1.15 });
  assert.ok(r !== null);
  assert.ok(Math.abs(r.realizedSol - -0.012) < 1e-9, `realizedSol=${r.realizedSol}`);
  assert.ok(Math.abs(r.realizedPct - -1.043478) < 1e-3, `realizedPct=${r.realizedPct}`);
});

test("missing deployCostSol → null (legacy position, mark-only fallback)", () => {
  assert.equal(computeRealizedPnl({ recovered: 1.2, deployCostSol: null, amountSol: 1.15 }), null);
});

test("missing recovered → null (wallet read failed)", () => {
  assert.equal(computeRealizedPnl({ recovered: null, deployCostSol: 1.2, amountSol: 1.15 }), null);
});

test("amountSol 0 → realizedSol computed, realizedPct null", () => {
  const r = computeRealizedPnl({ recovered: 1.0, deployCostSol: 1.05, amountSol: 0 });
  assert.ok(Math.abs(r.realizedSol - -0.05) < 1e-9);
  assert.equal(r.realizedPct, null);
});
