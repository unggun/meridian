import { test } from "node:test";
import assert from "node:assert/strict";
import { resampleKlines, computeIndicators, DEFAULT_INDICATOR_PARAMS } from "./gmgn-indicators.js";

// Helper: build a 1m candle. time in ms.
const c = (time, open, high, low, close, volume) => ({ time, open, high, low, close, volume });

const min = 60_000;
const ALIGNED_5M = 1_700_000_400_000;  // divisible by 5min  (300_000ms): a clock boundary
const ALIGNED_15M = 1_700_000_100_000; // divisible by 15min (900_000ms): a clock boundary

test("resampleKlines buckets five 1m candles into one 5m candle", () => {
  const base = ALIGNED_5M;
  const ones = [
    c(base + 0 * min, 10, 12, 9, 11, 100),
    c(base + 1 * min, 11, 15, 10, 14, 200),
    c(base + 2 * min, 14, 14, 8, 9, 150),
    c(base + 3 * min, 9, 11, 7, 10, 50),
    c(base + 4 * min, 10, 13, 9, 12, 300),
  ];
  const out = resampleKlines(ones, 5);
  assert.equal(out.length, 1);
  assert.equal(out[0].time, base); // emits the aligned bucket-start, not the first candle's time
  assert.equal(out[0].open, 10);   // first candle's open
  assert.equal(out[0].close, 12);  // last candle's close
  assert.equal(out[0].high, 15);   // max high
  assert.equal(out[0].low, 7);     // min low
  assert.equal(out[0].volume, 800); // sum
});

test("resampleKlines keeps a partial trailing clock bucket when dropInProgress is off", () => {
  const base = ALIGNED_5M;
  // 7 one-minute candles → full 5m bucket [base, base+5m) + partial bucket [base+5m, base+10m)
  const ones = Array.from({ length: 7 }, (_, i) =>
    c(base + i * min, 10 + i, 20, 5, 10 + i, 10));
  const out = resampleKlines(ones, 5);
  assert.equal(out.length, 2);          // full bucket + partial bucket kept
  assert.equal(out[1].open, 15);        // 6th candle (index 5) opens the partial bucket
  assert.equal(out[1].volume, 20);      // two candles summed
});

test("resampleKlines groups by wall-clock boundary, not by array index", () => {
  const base = ALIGNED_5M;
  // Series STARTS mid-bucket at base+2min. Index bucketing would lump the first
  // five (base+2..base+6) into one bucket; clock bucketing splits at base+5min.
  const ones = [
    c(base + 2 * min, 1, 1, 1, 1, 1), // bucket [base, base+5m)
    c(base + 3 * min, 1, 1, 1, 1, 1),
    c(base + 4 * min, 1, 1, 1, 1, 1),
    c(base + 5 * min, 2, 2, 2, 2, 1), // bucket [base+5m, base+10m)
    c(base + 6 * min, 2, 2, 2, 2, 1),
  ];
  const out = resampleKlines(ones, 5);
  assert.equal(out.length, 2);
  assert.equal(out[0].time, base);            // first bucket aligned to base
  assert.equal(out[0].volume, 3);             // three candles
  assert.equal(out[1].time, base + 5 * min);  // second bucket aligned to base+5m
  assert.equal(out[1].volume, 2);
});

test("resampleKlines trailing closed buckets are invariant to where the window starts", () => {
  // The production bug: a sliding 1m window re-phased index buckets so every refresh
  // changed all 15m candles. Clock alignment must make the trailing CLOSED buckets
  // identical whether or not earlier candles are present.
  const base = ALIGNED_15M;
  const full = Array.from({ length: 120 }, (_, i) =>
    c(base + i * min, 100 + i, 105 + i, 95 + i, 100 + i, 7));
  const a = resampleKlines(full, 15, { dropInProgress: true });
  const b = resampleKlines(full.slice(9), 15, { dropInProgress: true }); // window slid 9 minutes
  // The last 3 closed buckets are fully covered in both windows (only b's earliest bucket
  // is partial after the slide), so they must be byte-identical.
  assert.deepEqual(b.slice(-3), a.slice(-3), "trailing closed buckets must match across a window slide");
});

test("resampleKlines dropInProgress excludes the current (latest) period bucket", () => {
  const base = ALIGNED_15M;
  // 15 candles fill [base, base+15m); 3 more open the in-progress [base+15m, base+30m).
  const ones = Array.from({ length: 18 }, (_, i) =>
    c(base + i * min, 10, 12, 9, 11, 1));
  const kept = resampleKlines(ones, 15, { dropInProgress: true });
  const all = resampleKlines(ones, 15);
  assert.equal(all.length, 2, "both periods present without dropInProgress");
  assert.equal(kept.length, 1, "in-progress latest period dropped");
  assert.equal(kept[0].time, base, "only the closed [base, base+15m) bucket remains");
});

test("resampleKlines returns [] for empty input", () => {
  assert.deepEqual(resampleKlines([], 5), []);
});
import { computeRsi } from "./gmgn-indicators.js";

test("computeRsi returns 100 for a strictly rising close series", () => {
  const closes = [1, 2, 3, 4, 5, 6, 7, 8];
  const rsi = computeRsi(closes, 2);
  assert.ok(rsi > 99.9, `expected ~100, got ${rsi}`);
});

test("computeRsi returns 0 for a strictly falling close series", () => {
  const closes = [8, 7, 6, 5, 4, 3, 2, 1];
  const rsi = computeRsi(closes, 2);
  assert.ok(rsi < 0.1, `expected ~0, got ${rsi}`);
});

test("computeRsi returns null when not enough data", () => {
  assert.equal(computeRsi([1, 2], 2), null);
});
import { computeBollinger } from "./gmgn-indicators.js";

test("computeBollinger on a flat series has zero-width bands at the mean", () => {
  const closes = Array.from({ length: 20 }, () => 100);
  const bb = computeBollinger(closes, 20, 2);
  assert.equal(bb.middle, 100);
  assert.equal(bb.upper, 100);
  assert.equal(bb.lower, 100);
});

test("computeBollinger bands straddle the mean symmetrically", () => {
  const closes = [];
  for (let i = 0; i < 20; i++) closes.push(i % 2 === 0 ? 90 : 110); // mean 100
  const bb = computeBollinger(closes, 20, 2);
  assert.equal(bb.middle, 100);
  assert.ok(bb.upper > 100 && bb.lower < 100);
  assert.ok(Math.abs((bb.upper - 100) - (100 - bb.lower)) < 1e-9);
});

test("computeBollinger returns null when not enough data", () => {
  assert.equal(computeBollinger([1, 2, 3], 20, 2), null);
});
import { computeSupertrend } from "./gmgn-indicators.js";

const ohlc = (high, low, close) => ({ high, low, close, open: close });

test("computeSupertrend reports bullish on a sustained uptrend", () => {
  const candles = [];
  for (let i = 0; i < 30; i++) candles.push(ohlc(10 + i + 1, 10 + i - 1, 10 + i));
  const st = computeSupertrend(candles, 10, 3);
  assert.equal(st.direction, "bullish");
  assert.ok(st.value < candles[candles.length - 1].close, "supertrend sits below price in uptrend");
});

test("computeSupertrend reports bearish on a sustained downtrend", () => {
  const candles = [];
  for (let i = 0; i < 30; i++) candles.push(ohlc(100 - i + 1, 100 - i - 1, 100 - i));
  const st = computeSupertrend(candles, 10, 3);
  assert.equal(st.direction, "bearish");
  assert.ok(st.value > candles[candles.length - 1].close, "supertrend sits above price in downtrend");
});

test("computeSupertrend returns null when not enough data", () => {
  assert.equal(computeSupertrend([ohlc(1, 1, 1)], 10, 3), null);
});

test("computeSupertrend seeds direction from price on a short declining series", () => {
  // period+2 candles, every bar gently declining and closing at its low so each
  // close sits below its HL2 mid. The lower-band flip never triggers in this short
  // window, so direction is decided entirely by the initial seed. An unconditional
  // bullish seed wrongly reports "bullish" here; a price-derived seed reports "bearish".
  const period = 10;
  const candles = [];
  let price = 100;
  for (let i = 0; i < period + 2; i++) {
    const open = price;
    const close = price - 1;               // gentle 1-unit decline
    candles.push(ohlc(open, close, close)); // high=open, low=close => HL2 mid = close + 0.5 > close
    price = close;
  }
  const st = computeSupertrend(candles, period, 3);
  assert.equal(st.direction, "bearish", "first evaluated bar closes below its HL2 mid → bearish seed");
});
function syntheticCandles(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const close = 100 + Math.sin(i / 3) * 5 + i * 0.1;
    out.push({ time: 1_700_000_000_000 + i * 60_000, open: close, high: close + 1, low: close - 1, close, volume: 10 });
  }
  return out;
}

test("computeIndicators returns the full latest payload shape", () => {
  const candles = syntheticCandles(60);
  const { latest } = computeIndicators(candles, {
    supertrendPeriod: 10, supertrendMultiplier: 3,
    bollingerPeriod: 20, bollingerStdDev: 2,
    rsiLength: 2, fibLookbackBars: 55,
  });
  // Required fields every consumer reads:
  assert.ok(latest.candle && typeof latest.candle.close === "number");
  assert.ok(latest.previousCandle && typeof latest.previousCandle.close === "number");
  assert.ok(latest.rsi && typeof latest.rsi.value === "number");
  assert.ok(latest.bollinger && typeof latest.bollinger.upper === "number");
  assert.ok(typeof latest.bollinger.lower === "number");
  assert.ok(typeof latest.bollinger.middle === "number");
  assert.ok(latest.supertrend && typeof latest.supertrend.value === "number");
  assert.ok(["bullish", "bearish"].includes(latest.supertrend.direction));
  assert.ok(latest.states && typeof latest.states.supertrendBreakUp === "boolean");
  assert.ok(typeof latest.states.supertrendBreakDown === "boolean");
  assert.ok(latest.fibonacci && latest.fibonacci.levels);
  assert.ok("0.618" in latest.fibonacci.levels);
});

test("computeIndicators throws on insufficient candles", () => {
  assert.throws(() => computeIndicators(syntheticCandles(5), {
    supertrendPeriod: 10, supertrendMultiplier: 3,
    bollingerPeriod: 20, bollingerStdDev: 2, rsiLength: 2, fibLookbackBars: 55,
  }), /insufficient/i);
});
import { fetchGmgnIndicatorPayload, __setKlineFetcherForTest, __clearKlineCacheForTest } from "./gmgn-indicators.js";

function fakeKlines(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const close = 100 + Math.sin(i / 5) * 3 + i * 0.05;
    out.push({ time: 1_700_000_000_000 + i * 60_000, open: close, high: close + 0.5, low: close - 0.5, close, volume: 5 });
  }
  return out;
}

test("fetchGmgnIndicatorPayload reuses one fetch for 5m and 15m within TTL", async () => {
  __clearKlineCacheForTest();
  let calls = 0;
  __setKlineFetcherForTest(async () => { calls += 1; return fakeKlines(300); });

  const five = await fetchGmgnIndicatorPayload("MINT1", { interval: "5_MINUTE", rsiLength: 2 });
  const fifteen = await fetchGmgnIndicatorPayload("MINT1", { interval: "15_MINUTE", rsiLength: 2 });

  assert.equal(calls, 1, "second interval should hit the per-mint cache");
  assert.ok(five.latest.supertrend.value > 0);
  assert.ok(fifteen.latest.supertrend.value > 0);
  __setKlineFetcherForTest(null); // restore real fetcher
});

test("fetchGmgnIndicatorPayload supertrend direction is invariant to where the sliding window starts", async () => {
  // Reproduces the production bug: with a sliding 1m window, prepending/dropping leading
  // candles changed the 15m supertrend direction at the SAME latest bar (entry saw bullish,
  // the exit check minutes later saw bearish). Anchoring the warmup to a fixed set of closed
  // clock buckets must make direction depend only on the recent closed price, not the window
  // start. This series (range-bound chop) flips direction under the old index/full-series path.
  __clearKlineCacheForTest();
  const ALIGNED = 1_700_000_100_000; // 15m boundary
  const series = (n) => Array.from({ length: n }, (_, i) => {
    const p = 100 + Math.sin(i / 11) * 2 + Math.sin(i / 3.3) * 0.8;
    return {
      time: ALIGNED + i * 60_000,
      open: p,
      high: p + Math.abs(Math.sin(i / 2)) * 0.4,
      low: p - Math.abs(Math.cos(i / 2)) * 0.4,
      close: p,
      volume: 1,
    };
  });
  const full = series(1100); // ends on the same latest candle for every slice below
  const dir = async (klines) => {
    __clearKlineCacheForTest();
    __setKlineFetcherForTest(async () => klines);
    const pl = await fetchGmgnIndicatorPayload("MINV", { interval: "15_MINUTE", rsiLength: 2 });
    return pl.latest.supertrend.direction;
  };
  const base = await dir(full);
  for (const k of [15, 30, 45, 60, 90]) {
    assert.equal(
      await dir(full.slice(k)),
      base,
      `direction must not change when the window starts ${k} minutes later`,
    );
  }
  __setKlineFetcherForTest(null);
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __testdir = dirname(fileURLToPath(import.meta.url));
const cumFixture = JSON.parse(
  readFileSync(join(__testdir, "../test/fixtures/cum-1m-klines-at-deploy.json"), "utf8"),
);

test("fetchGmgnIndicatorPayload: CUM 15m at deploy reads bearish, matching the GMGN chart", async () => {
  // Regression for the seed/warmup-starvation false positive. CUM-SOL's last deploy
  // (2026-06-01T03:07Z) passed the entry gate because the 15m warmup window seeded
  // bullish, while GMGN's TradingView supertrend(10,3) read 0.0005067 with price BELOW
  // it (bearish) on the same 10:00 UTC+7 bar. With sufficient warmup the agent's 15m
  // converges to GMGN's value and the gate correctly rejects.
  // Evidence + threshold: scripts/sweep-warmup-parity.js.
  __clearKlineCacheForTest();
  __setKlineFetcherForTest(async () => cumFixture.klines);
  const pl = await fetchGmgnIndicatorPayload(cumFixture.mint, { interval: "15_MINUTE", rsiLength: 2 });
  __setKlineFetcherForTest(null);

  const { candle, supertrend } = pl.latest;
  assert.equal(supertrend.direction, "bearish",
    "15m supertrend must match GMGN's bearish read at the deploy bar");
  assert.ok(candle.close < supertrend.value,
    `price (${candle.close}) must sit below supertrend (${supertrend.value}) → gate rejects`);
  // Parity: the converged value matches the GMGN chart (0.0005067) within tolerance.
  const drift = Math.abs(supertrend.value - cumFixture.gmgn15mSupertrend) / cumFixture.gmgn15mSupertrend;
  assert.ok(drift < 0.05,
    `agent 15m ST ${supertrend.value} should track GMGN's ${cumFixture.gmgn15mSupertrend} (drift ${(drift * 100).toFixed(2)}%)`);
});

test("fetchGmgnIndicatorPayload: CUM 5m at deploy stays bullish (fix is surgical, not over-rejecting)", async () => {
  // The warmup bump targets the 15m starvation only. The 5m had ample bars and agreed
  // with the chart at every warmup; it must remain bullish so the stricter gate does not
  // start rejecting genuinely-bullish 5m structure.
  __clearKlineCacheForTest();
  __setKlineFetcherForTest(async () => cumFixture.klines);
  const pl = await fetchGmgnIndicatorPayload(cumFixture.mint, { interval: "5_MINUTE", rsiLength: 2 });
  __setKlineFetcherForTest(null);
  assert.equal(pl.latest.supertrend.direction, "bullish");
});

test("fetchGmgnIndicatorPayload throws when the feed returns too few candles", async () => {
  __clearKlineCacheForTest();
  __setKlineFetcherForTest(async () => fakeKlines(3));
  await assert.rejects(
    () => fetchGmgnIndicatorPayload("MINT2", { interval: "5_MINUTE", rsiLength: 2 }),
    /insufficient/i,
  );
  __setKlineFetcherForTest(null);
});

test("fetchGmgnIndicatorPayload does not cache a transient empty kline list", async () => {
  __clearKlineCacheForTest();
  let calls = 0;
  // First fetch returns [] (transient empty), second returns real data.
  __setKlineFetcherForTest(async () => {
    calls += 1;
    return calls === 1 ? [] : fakeKlines(300);
  });

  // First call rejects because the feed was empty...
  await assert.rejects(
    () => fetchGmgnIndicatorPayload("MINTEMPTY", { interval: "5_MINUTE", rsiLength: 2 }),
    /empty/i,
  );
  // ...and because the empty result was NOT cached, the second call re-fetches and succeeds.
  const payload = await fetchGmgnIndicatorPayload("MINTEMPTY", { interval: "5_MINUTE", rsiLength: 2 });
  assert.equal(calls, 2, "second call must re-fetch (empty result not cached)");
  assert.ok(payload.latest.supertrend.value > 0);

  __setKlineFetcherForTest(null);
});

test("computeIndicators emits a recent series with close/low/bbLower/bbMiddle", () => {
  // 30 ascending candles so bollinger/supertrend/rsi are all computable.
  const candles = Array.from({ length: 30 }, (_, i) => ({
    time: ALIGNED_5M + i * 5 * min,
    open: 100 + i, high: 102 + i, low: 98 + i, close: 100 + i,
  }));
  const params = { ...DEFAULT_INDICATOR_PARAMS, recentSeriesBars: 6, rsiLength: 2 };
  const payload = computeIndicators(candles, params);
  assert.ok(Array.isArray(payload.recent), "recent should be an array");
  assert.equal(payload.recent.length, 6);
  const last = payload.recent[payload.recent.length - 1];
  assert.equal(last.close, 129);
  assert.equal(last.low, 127);
  assert.ok(Number.isFinite(last.bbLower), "bbLower finite");
  assert.ok(Number.isFinite(last.bbMiddle), "bbMiddle finite");
});

test("computeIndicators recent series emits null bands for bars lacking full BB history", () => {
  // 30 ascending candles; ask for 25 recent bars so the earliest ones have < bollingerPeriod (20) closes.
  const candles = Array.from({ length: 30 }, (_, i) => ({
    time: ALIGNED_5M + i * 5 * min,
    open: 100 + i, high: 102 + i, low: 98 + i, close: 100 + i,
  }));
  const params = { ...DEFAULT_INDICATOR_PARAMS, recentSeriesBars: 25, rsiLength: 2 };
  const payload = computeIndicators(candles, params);
  assert.equal(payload.recent.length, 25);
  // Earliest recent bar (candle index 5 → 6 closes < period 20) has null bands.
  assert.equal(payload.recent[0].bbLower, null, "insufficient history → null bbLower");
  assert.equal(payload.recent[0].bbMiddle, null, "insufficient history → null bbMiddle");
  // Latest bar has full history → finite bands.
  assert.ok(Number.isFinite(payload.recent[payload.recent.length - 1].bbLower), "last bar finite band");
});
