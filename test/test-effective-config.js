// Verify night-mode effective config resolution.
// Uses an injectable "now" so we don't depend on wall clock.
let exitCode = 0;
function fail(msg) { console.error("FAIL:", msg); exitCode = 1; }
function ok(msg)   { console.log("PASS:", msg); }

const { getEffectiveManagementConfig, config } = await import("../config.js");

if (typeof getEffectiveManagementConfig !== "function") {
  fail("getEffectiveManagementConfig is not exported");
  process.exit(1);
}

const saved = { ...config.management };
Object.assign(config.management, {
  stopLossPct: -12,
  maxVolatility: null,
  nightModeStartUtc: 17,
  nightModeEndUtc: 23,
  nightStopLossPct: -8,
  nightMaxVolatility: 2,
});

try {
  // Daytime: 10:00 UTC → day values
  const day = getEffectiveManagementConfig(new Date("2026-04-16T10:00:00Z"));
  if (day.stopLossPct !== -12) fail(`day SL expected -12, got ${day.stopLossPct}`);
  else ok("daytime uses day stopLossPct");
  if (day.maxVolatility !== null) fail(`day maxVolatility expected null, got ${day.maxVolatility}`);
  else ok("daytime uses day maxVolatility");
  if (day.isNight !== false) fail(`day isNight expected false, got ${day.isNight}`);
  else ok("daytime isNight=false");

  // Night window start boundary: exactly 17:00 UTC → night
  const nightStart = getEffectiveManagementConfig(new Date("2026-04-16T17:00:00Z"));
  if (nightStart.stopLossPct !== -8) fail(`night-start SL expected -8, got ${nightStart.stopLossPct}`);
  else ok("17:00 UTC is night (inclusive start)");

  // Middle of night: 20:00 UTC → night
  const mid = getEffectiveManagementConfig(new Date("2026-04-16T20:00:00Z"));
  if (mid.stopLossPct !== -8) fail(`night SL expected -8, got ${mid.stopLossPct}`);
  else ok("night stopLossPct override applied");
  if (mid.maxVolatility !== 2) fail(`night maxVolatility expected 2, got ${mid.maxVolatility}`);
  else ok("night maxVolatility override applied");
  if (mid.isNight !== true) fail(`mid isNight expected true, got ${mid.isNight}`);
  else ok("night isNight=true");

  // Night end exclusive: 23:00 UTC → day
  const endBoundary = getEffectiveManagementConfig(new Date("2026-04-16T23:00:00Z"));
  if (endBoundary.stopLossPct !== -12) fail(`23:00 UTC expected day (-12), got ${endBoundary.stopLossPct}`);
  else ok("23:00 UTC is day (exclusive end)");

  // With night mode disabled (start=null), always day
  config.management.nightModeStartUtc = null;
  const disabled = getEffectiveManagementConfig(new Date("2026-04-16T20:00:00Z"));
  if (disabled.stopLossPct !== -12) fail(`night-disabled SL expected -12, got ${disabled.stopLossPct}`);
  else ok("nightModeStartUtc=null disables night mode");
} finally {
  Object.assign(config.management, saved);
}
process.exit(exitCode);
