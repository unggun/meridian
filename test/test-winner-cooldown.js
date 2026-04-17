// Verify winner cooldown fires after a winning close above the threshold.
// Backs up pool-memory.json before running, restores on exit.
import fs from "fs";

const POOL_FILE = "./pool-memory.json";
const BACKUP = fs.readFileSync(POOL_FILE, "utf8");

let exitCode = 0;
function fail(msg) { console.error("FAIL:", msg); exitCode = 1; }
function ok(msg)   { console.log("PASS:", msg); }

try {
  fs.writeFileSync(POOL_FILE, "{}");

  const { recordPoolDeploy, isPoolOnCooldown } = await import("../pool-memory.js");
  const { config } = await import("../config.js");

  if (typeof config.management.winnerCooldownHours !== "number") fail(`winnerCooldownHours should be a number, got ${config.management.winnerCooldownHours}`);
  if (typeof config.management.winnerCooldownMinPnlPct !== "number") fail(`winnerCooldownMinPnlPct should be a number, got ${config.management.winnerCooldownMinPnlPct}`);
  ok("config keys loaded");

  const winPool  = "WIN_POOL_ADDR_111111111111";
  const lossPool = "LOSS_POOL_ADDR_22222222222";

  // Winner case — single +5% close should trigger winner cooldown
  recordPoolDeploy(winPool, {
    pool_name: "WIN-SOL", base_mint: "WIN_MINT",
    pnl_pct: 5, close_reason: "Take profit", strategy: "spot",
  });
  if (!isPoolOnCooldown(winPool)) fail("Winner pool SHOULD be on cooldown after +5% close");
  else ok("winner cooldown fires on +5% close");

  // Loss case — single -10% close should NOT trigger winner cooldown
  recordPoolDeploy(lossPool, {
    pool_name: "LOSS-SOL", base_mint: "LOSS_MINT",
    pnl_pct: -10, close_reason: "Stop loss", strategy: "spot",
  });
  if (isPoolOnCooldown(lossPool)) fail("Loss pool should NOT be on winner cooldown");
  else ok("winner cooldown does NOT fire on losing close");

  // Edge case — pnl_pct == winnerCooldownMinPnlPct should NOT trigger (strict greater-than)
  const edgePool = "EDGE_POOL_ADDR_33333333333";
  recordPoolDeploy(edgePool, {
    pool_name: "EDGE-SOL", base_mint: "EDGE_MINT",
    pnl_pct: 0, close_reason: "flat", strategy: "spot",
  });
  if (isPoolOnCooldown(edgePool)) fail("Edge pnl==threshold should NOT cool down");
  else ok("winner cooldown uses strict > threshold");
} finally {
  fs.writeFileSync(POOL_FILE, BACKUP);
}
process.exit(exitCode);
