// Regression test for formatCloseMessage (2026-06-23).
// Two PnL lines (mark + realized) when realized data is present; legacy single
// line when absent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCloseMessage } from "../telegram.js";

test("realized present → mark + realized lines, ◎ currency", () => {
  const msg = formatCloseMessage({
    pair: "QUEST-SOL", pnlUsd: 0.0085, pnlPct: 0.74,
    realizedSol: -0.012, realizedPct: -1.04,
    reason: "auto: Trailing TP", currency: "◎",
  });
  assert.match(msg, /PnL \(mark\): \+◎0\.0085 \(\+0\.74%\)/);
  assert.match(msg, /PnL \(realized\): -◎0\.0120 \(-1\.04%\)/);
  assert.match(msg, /Reason: auto: Trailing TP/);
});

test("realized absent → legacy single PnL line", () => {
  const msg = formatCloseMessage({
    pair: "FOO-SOL", pnlUsd: 1.5, pnlPct: 2.0, reason: "manual", currency: "$",
  });
  assert.match(msg, /PnL: \+\$1\.5000 \(\+2\.00%\)/);
  assert.doesNotMatch(msg, /realized/);
  assert.doesNotMatch(msg, /\(mark\)/);
});

test("realizedPct null → realized SOL only, no percent", () => {
  const msg = formatCloseMessage({
    pair: "BAR-SOL", pnlUsd: 0, pnlPct: 0,
    realizedSol: -0.05, realizedPct: null, currency: "◎",
  });
  assert.match(msg, /PnL \(realized\): -◎0\.0500$/m);
});
