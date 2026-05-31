// Manual parity check: GMGN-computed indicators vs the Meridian endpoint, on the
// decisions that gate logic actually uses. NOT wired into the agent.
//
// Usage:
//   node scripts/validate-gmgn-indicators.js <mint> [<mint> ...]
//   node scripts/validate-gmgn-indicators.js            (pulls a live screen sample)
import "dotenv/config";
import { config } from "../config.js";
import { fetchGmgnIndicatorPayload } from "../tools/gmgn-indicators.js";

// Import the seam; we force source=meridian around the meridian fetch.
import { fetchChartIndicatorsForMint } from "../tools/chart-indicators.js";

const INTERVALS = ["5_MINUTE", "15_MINUTE"];

function rsiZone(v) {
  if (v == null) return "n/a";
  const os = config.indicators?.rsiOversold ?? 30;
  const ob = config.indicators?.rsiOverbought ?? 80;
  if (v <= os) return "oversold";
  if (v >= ob) return "overbought";
  return "neutral";
}
function bbPos(close, bb) {
  if (close == null || !bb) return "n/a";
  if (bb.upper != null && close > bb.upper) return "above";
  if (bb.lower != null && close < bb.lower) return "below";
  return "inside";
}
function decisions(latest) {
  const close = latest?.candle?.close ?? null;
  const st = latest?.supertrend || {};
  return {
    direction: st.direction ?? null,
    aboveST: close != null && st.value != null ? close >= st.value : null,
    breakUp: !!latest?.states?.supertrendBreakUp,
    rsiZone: rsiZone(latest?.rsi?.value ?? null),
    bbPos: bbPos(close, latest?.bollinger),
  };
}

async function meridianPayload(mint, interval) {
  const prev = config.gmgn.indicatorSource;
  config.gmgn.indicatorSource = "meridian";
  try {
    return await fetchChartIndicatorsForMint(mint, { interval, refresh: true });
  } finally {
    config.gmgn.indicatorSource = prev;
  }
}

async function getSampleMints() {
  if (process.argv.length > 2) return process.argv.slice(2);
  const { discoverGmgnPools } = await import("../tools/gmgn.js");
  const { pools } = await discoverGmgnPools({ limit: 15 });
  return pools.map((p) => p.base?.mint).filter(Boolean);
}

async function main() {
  const mints = await getSampleMints();
  if (mints.length === 0) {
    console.log("No mints to validate.");
    return;
  }

  const tally = {};
  const keys = ["direction", "aboveST", "breakUp", "rsiZone", "bbPos"];
  for (const k of keys) tally[k] = { agree: 0, total: 0 };

  for (const mint of mints) {
    for (const interval of INTERVALS) {
      let g, m;
      try {
        g = decisions(
          (await fetchGmgnIndicatorPayload(mint, { interval, rsiLength: config.indicators?.rsiLength ?? 2 })).latest,
        );
        m = decisions((await meridianPayload(mint, interval)).latest);
      } catch (e) {
        console.log(`skip ${mint.slice(0, 8)} ${interval}: ${e.message}`);
        continue;
      }
      for (const k of keys) {
        tally[k].total += 1;
        if (g[k] === m[k]) tally[k].agree += 1;
      }
      console.log(`${mint.slice(0, 8)} ${interval}: gmgn=${JSON.stringify(g)} meridian=${JSON.stringify(m)}`);
    }
  }

  console.log("\n=== Decision-level agreement ===");
  for (const k of keys) {
    const { agree, total } = tally[k];
    const pct = total ? ((agree / total) * 100).toFixed(1) : "n/a";
    console.log(`${k.padEnd(10)} ${agree}/${total} (${pct}%)`);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
