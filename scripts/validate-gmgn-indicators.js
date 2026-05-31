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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The Meridian endpoint 504s intermittently on thin/fresh tokens (slow to compute
// indicators from scratch under refresh=1). Retry with backoff so a transient timeout
// doesn't drop the whole comparison row to n/a.
async function meridianPayload(mint, interval, { retries = 3, backoffMs = 3000 } = {}) {
  const prev = config.gmgn.indicatorSource;
  config.gmgn.indicatorSource = "meridian";
  try {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fetchChartIndicatorsForMint(mint, { interval, refresh: true });
      } catch (e) {
        lastErr = e;
        if (attempt < retries) await sleep(backoffMs * attempt);
      }
    }
    throw lastErr;
  } finally {
    config.gmgn.indicatorSource = prev;
  }
}

async function getSampleMints() {
  if (process.argv.length > 2) return process.argv.slice(2);
  const { discoverGmgnPools } = await import("../tools/gmgn.js");
  // Disable the Stage-4 bounce/indicator filter while sampling — otherwise it can cull
  // every candidate to 0 and we get no mints to compare. We just want tokens that have
  // a real DLMM pool (Stages 1-3); their indicator decisions are what we're measuring.
  const prevFilter = config.gmgn.indicatorFilter;
  config.gmgn.indicatorFilter = false;
  try {
    const { pools } = await discoverGmgnPools({ limit: 15 });
    return pools.map((p) => p.base?.mint).filter(Boolean);
  } finally {
    config.gmgn.indicatorFilter = prevFilter;
  }
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
  let gmgnFails = 0;
  let meridianFails = 0;

  for (const mint of mints) {
    for (const interval of INTERVALS) {
      // Report which side failed, so a Meridian 504 isn't mistaken for a GMGN problem.
      let g, m;
      try {
        g = decisions(
          (await fetchGmgnIndicatorPayload(mint, { interval, rsiLength: config.indicators?.rsiLength ?? 2 })).latest,
        );
      } catch (e) {
        gmgnFails += 1;
        console.log(`skip ${mint.slice(0, 8)} ${interval}: GMGN failed — ${e.message}`);
        continue;
      }
      try {
        m = decisions((await meridianPayload(mint, interval)).latest);
      } catch (e) {
        meridianFails += 1;
        console.log(`skip ${mint.slice(0, 8)} ${interval}: MERIDIAN failed — ${e.message} (gmgn was ${JSON.stringify(g)})`);
        continue;
      }
      for (const k of keys) {
        tally[k].total += 1;
        if (g[k] === m[k]) tally[k].agree += 1;
      }
      console.log(`${mint.slice(0, 8)} ${interval}: gmgn=${JSON.stringify(g)} meridian=${JSON.stringify(m)}`);
    }
    // Be gentle on the Meridian endpoint between tokens.
    await sleep(1000);
  }

  console.log("\n=== Decision-level agreement ===");
  for (const k of keys) {
    const { agree, total } = tally[k];
    const pct = total ? ((agree / total) * 100).toFixed(1) : "n/a";
    console.log(`${k.padEnd(10)} ${agree}/${total} (${pct}%)`);
  }
  console.log(`\nfetch failures: gmgn=${gmgnFails} meridian=${meridianFails}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
