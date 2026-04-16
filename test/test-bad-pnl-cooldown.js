// Verify the bad-PnL cooldown fires after N deploys with low avg PnL.
// Backs up pool-memory.json before running, restores it on exit.
import fs from "fs";

const POOL_FILE = "./pool-memory.json";
const BACKUP = fs.readFileSync(POOL_FILE, "utf8");

let exitCode = 0;
function fail(msg) { console.error("FAIL:", msg); exitCode = 1; }
function ok(msg) { console.log("PASS:", msg); }

try {
  fs.writeFileSync(POOL_FILE, "{}");

  const { recordPoolDeploy, isPoolOnCooldown } = await import("../pool-memory.js");
  const { config } = await import("../config.js");

  // Pin config to known values for this test, independent of user-config.json
  const savedMgmt = { ...config.management };
  config.management.badPnlCooldownTriggerCount = 3;
  config.management.badPnlCooldownMinAvgPct = 1;
  config.management.badPnlCooldownHours = 24;
  config.management.winnerCooldownHours = 0; // isolate bad-PnL behavior from winner cooldown
  ok("config pinned to test values");

  const pool = "TEST_POOL_ADDR_123456789";
  const baseDeploy = {
    pool_name: "TESTPOOL-SOL",
    base_mint: "TEST_MINT",
    deployed_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    closed_at: new Date().toISOString(),
    range_efficiency: 100,
    minutes_held: 30,
    close_reason: "stop loss",
    strategy: "spot",
    volatility: 2.0,
  };

  // Two bad deploys — should NOT cool down yet (need 3)
  recordPoolDeploy(pool, { ...baseDeploy, pnl_pct: -5, pnl_usd: -1.5 });
  recordPoolDeploy(pool, { ...baseDeploy, pnl_pct: -3, pnl_usd: -0.9 });
  if (isPoolOnCooldown(pool)) fail("Should NOT be on cooldown after only 2 deploys");
  else ok("Not on cooldown after 2 deploys");

  // Third bad deploy — avg = (-5 + -3 + -7)/3 = -5%, below threshold of 1% — should cool down
  recordPoolDeploy(pool, { ...baseDeploy, pnl_pct: -7, pnl_usd: -2.1 });
  if (!isPoolOnCooldown(pool)) fail("SHOULD be on cooldown after 3 bad deploys");
  else ok("On cooldown after 3 bad deploys");

  // Verify cooldown reason and duration
  const db = JSON.parse(fs.readFileSync(POOL_FILE, "utf8"));
  const entry = db[pool];
  if (!entry.cooldown_reason?.includes("low avg pnl")) fail(`Expected reason "low avg pnl", got "${entry.cooldown_reason}"`);
  else ok(`Cooldown reason: "${entry.cooldown_reason}"`);
  const cooldownMs = new Date(entry.cooldown_until).getTime() - Date.now();
  const cooldownHours = cooldownMs / 3_600_000;
  if (cooldownHours < 23 || cooldownHours > 25) fail(`Cooldown duration ${cooldownHours.toFixed(1)}h, expected ~24h`);
  else ok(`Cooldown duration ~${cooldownHours.toFixed(1)}h`);

  // Now simulate a fresh pool with mixed deploys averaging > 1% — should NOT cool down
  const goodPool = "GOOD_POOL_ADDR";
  recordPoolDeploy(goodPool, { ...baseDeploy, pnl_pct: 5, pnl_usd: 1.5 });
  recordPoolDeploy(goodPool, { ...baseDeploy, pnl_pct: -1, pnl_usd: -0.3 });
  recordPoolDeploy(goodPool, { ...baseDeploy, pnl_pct: 3, pnl_usd: 0.9 });
  // avg = (5 + -1 + 3) / 3 = 2.33%, above threshold
  if (isPoolOnCooldown(goodPool)) fail("Profitable pool should NOT be on cooldown");
  else ok("Profitable pool not on cooldown (avg +2.33%)");

  // Edge case: avg exactly equal to threshold (1%) — should NOT trigger BAD-PNL cooldown.
  const edgePool = "EDGE_POOL_ADDR";
  recordPoolDeploy(edgePool, { ...baseDeploy, pnl_pct: 1, pnl_usd: 0.3 });
  recordPoolDeploy(edgePool, { ...baseDeploy, pnl_pct: 1, pnl_usd: 0.3 });
  recordPoolDeploy(edgePool, { ...baseDeploy, pnl_pct: 1, pnl_usd: 0.3 });
  if (isPoolOnCooldown(edgePool)) fail("Edge case avg==threshold should NOT cool down");
  else ok("Edge case avg==threshold not on cooldown");

  // Restore config
  Object.assign(config.management, savedMgmt);

} finally {
  fs.writeFileSync(POOL_FILE, BACKUP);
  console.log("\npool-memory.json restored");
}

if (exitCode !== 0) {
  console.error(`\n${exitCode > 0 ? "TESTS FAILED" : ""}`);
  process.exit(exitCode);
}
console.log("\nAll tests passed");
