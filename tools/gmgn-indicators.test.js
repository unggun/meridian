import { test } from "node:test";
import assert from "node:assert/strict";
import { resampleKlines, computeIndicators, DEFAULT_INDICATOR_PARAMS, computeRsi, computeRsiSeries, computeMacd } from "./gmgn-indicators.js";

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
import { fetchGmgnIndicatorPayload, __setKlineFetcherForTest, __setNativeKlineFetcherForTest, __clearKlineCacheForTest } from "./gmgn-indicators.js";
import { config } from "../config.js";

function fakeKlines(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const close = 100 + Math.sin(i / 5) * 3 + i * 0.05;
    out.push({ time: 1_700_000_000_000 + i * 60_000, open: close, high: close + 0.5, low: close - 0.5, close, volume: 5 });
  }
  return out;
}

test("fetchGmgnIndicatorPayload reuses one fetch for 5m and 15m within TTL", async () => {
  // Legacy 1m→resample path: native off so both intervals share the single 1m fetch,
  // independent of whatever gmgn-config.json enables live.
  await withNativeIntervals([], async () => {
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
  await withNativeIntervals([], async () => { // legacy resample path under test
    const base = await dir(full);
    for (const k of [15, 30, 45, 60, 90]) {
      assert.equal(
        await dir(full.slice(k)),
        base,
        `direction must not change when the window starts ${k} minutes later`,
      );
    }
  });
  __setKlineFetcherForTest(null);
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __testdir = dirname(fileURLToPath(import.meta.url));
const cumFixture = JSON.parse(
  readFileSync(join(__testdir, "../test/fixtures/cum-1m-klines-at-deploy.json"), "utf8"),
);
const berriesNative = JSON.parse(
  readFileSync(join(__testdir, "../test/fixtures/berries-native-15m-klines.json"), "utf8"),
);

// Run `fn` with config.gmgn.indicatorParams.nativeFetchIntervals set, then restore.
async function withNativeIntervals(intervals, fn) {
  const orig = config.gmgn;
  config.gmgn = { ...(orig || {}), indicatorParams: { ...(orig?.indicatorParams || {}), nativeFetchIntervals: intervals } };
  try { return await fn(); }
  finally { config.gmgn = orig; }
}

test("fetchGmgnIndicatorPayload: CUM 15m at deploy reads bearish, matching the GMGN chart", async () => {
  // Regression for the seed/warmup-starvation false positive. CUM-SOL's last deploy
  // (2026-06-01T03:07Z) passed the entry gate because the 15m warmup window seeded
  // bullish, while GMGN's TradingView supertrend(10,3) read 0.0005067 with price BELOW
  // it (bearish) on the same 10:00 UTC+7 bar. With sufficient warmup the agent's 15m
  // converges to GMGN's value and the gate correctly rejects.
  // Evidence + threshold: scripts/sweep-warmup-parity.js.
  __clearKlineCacheForTest();
  __setKlineFetcherForTest(async () => cumFixture.klines);
  // Pin the legacy 1m→resample path: this regression is about the 66-bar warmup, not native.
  const pl = await withNativeIntervals([], () =>
    fetchGmgnIndicatorPayload(cumFixture.mint, { interval: "15_MINUTE", rsiLength: 2 }));
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

test("computeIndicators emits a recent series with close/high/low/bbLower/bbMiddle/bbUpper", () => {
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
  assert.equal(last.high, 131);
  assert.equal(last.low, 127);
  assert.ok(Number.isFinite(last.bbLower), "bbLower finite");
  assert.ok(Number.isFinite(last.bbMiddle), "bbMiddle finite");
  assert.ok(Number.isFinite(last.bbUpper), "bbUpper finite");
  assert.ok(last.bbUpper > last.bbMiddle && last.bbMiddle > last.bbLower, "bands ordered");
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

test("nativeFetchIntervals routes 15m to a native-resolution fetch and leaves 5m on the 1m feed", async () => {
  __clearKlineCacheForTest();
  const nativeCalls = [];
  let oneMinCalls = 0;
  __setNativeKlineFetcherForTest(async (_mint, resolution) => { nativeCalls.push(resolution); return berriesNative.klines; });
  __setKlineFetcherForTest(async () => { oneMinCalls += 1; return fakeKlines(1000); });

  await withNativeIntervals(["15_MINUTE"], async () => {
    const fifteen = await fetchGmgnIndicatorPayload(berriesNative.mint, { interval: "15_MINUTE", rsiLength: 2 });
    const five = await fetchGmgnIndicatorPayload(berriesNative.mint, { interval: "5_MINUTE", rsiLength: 2 });
    assert.deepEqual(nativeCalls, ["15m"], "15m must fetch native 15m candles");
    assert.equal(oneMinCalls, 1, "5m must still use the 1m feed; 15m must NOT touch it");
    assert.ok(fifteen.latest.supertrend.value > 0);
    assert.ok(five.latest.supertrend.value > 0);
  });

  __setNativeKlineFetcherForTest(null);
  __setKlineFetcherForTest(null);
});

test("Berries 15m native deep-history reads bullish (GMGN chart), where the 1m-resample window-cap read bearish", async () => {
  // 2026-06-02 deploy-check bar: the 1m feed caps at ~66 closed 15m bars and, inside the
  // supertrend seed-flap zone, read bearish/0.000597 — wrongly vetoing a bins-below entry.
  // GMGN's TradingView supertrend(10,3) read bullish/0.0004236 on the same bar. Native 15m
  // candles carry the deeper history (nativeWarmupBars=120) and converge to the chart.
  // Drop the fixture's last `divergenceEndpointDropLast` bars to land on that bar.
  __clearKlineCacheForTest();
  const atDeployBar = berriesNative.klines.slice(0, berriesNative.klines.length - berriesNative.divergenceEndpointDropLast);
  __setNativeKlineFetcherForTest(async () => atDeployBar);

  const pl = await withNativeIntervals(["15_MINUTE"], () =>
    fetchGmgnIndicatorPayload(berriesNative.mint, { interval: "15_MINUTE", rsiLength: 2 }));
  __setNativeKlineFetcherForTest(null);

  const { supertrend, candle } = pl.latest;
  assert.equal(supertrend.direction, berriesNative.native120Direction, "native 15m must read bullish, matching the chart");
  assert.ok(candle.close > supertrend.value,
    `price (${candle.close}) must sit above supertrend (${supertrend.value}) → bullish, entry gate passes`);
  const drift = Math.abs(supertrend.value - berriesNative.gmgn15mSupertrend) / berriesNative.gmgn15mSupertrend;
  assert.ok(drift < 0.05,
    `native 15m ST ${supertrend.value} should track GMGN's ${berriesNative.gmgn15mSupertrend} (drift ${(drift * 100).toFixed(2)}%)`);

  // Same bar through the legacy capped window (66 resampled bars) reproduces the bug: bearish.
  const closed = resampleKlines(atDeployBar, 15, { dropInProgress: true });
  const legacy = computeSupertrend(closed.slice(-DEFAULT_INDICATOR_PARAMS.warmupBars));
  assert.equal(legacy.direction, berriesNative.legacy66Direction,
    "the 66-bar resample window reproduces the bearish false-veto the native path fixes");
});

test("computeRsiSeries is candle-aligned and its final value matches computeRsi", () => {
  const closes = [10, 11, 10.5, 12, 13, 12.5, 14, 13, 15, 16, 15.5, 17];
  const series = computeRsiSeries(closes, 2);
  assert.equal(series.length, closes.length);          // aligned to candles
  assert.equal(series[0], null);                        // no RSI before warmup
  assert.equal(series[1], null, "no RSI at the second warmup slot either (length=2)");
  assert.ok(series[2] !== null, "first RSI appears at index `length`");
  assert.ok(Math.abs(series[2] - computeRsi(closes.slice(0, 3), 2)) < 1e-9, "intermediate slot matches prefix computeRsi");
  const pointwise = computeRsi(closes, 2);
  assert.ok(Math.abs(series[series.length - 1] - pointwise) < 1e-9,
    `series tail ${series[series.length - 1]} should equal point RSI ${pointwise}`);
});

test("computeRsiSeries returns all-null / empty for insufficient or non-array input", () => {
  assert.deepEqual(computeRsiSeries([10, 11], 2), [null, null]);
  assert.deepEqual(computeRsiSeries(null, 2), []);
});

test("computeMacd returns a candle-aligned histogram series with a first-green crossover", () => {
  // Flat warmup, then a sharp sustained drop (histogram goes clearly negative),
  // then a sharp rise (MACD overtakes signal → a genuine first-green cross).
  const flat = Array.from({ length: 30 }, () => 100);
  const drop = Array.from({ length: 20 }, (_, i) => 100 - (i + 1) * 3); // 97 -> 40
  const rise = Array.from({ length: 30 }, (_, i) => 40 + (i + 1) * 2);  // 42 -> 100
  const closes = [...flat, ...drop, ...rise]; // length 80
  const macd = computeMacd(closes, { fast: 12, slow: 26, signal: 9 });

  assert.equal(macd.histogramSeries.length, closes.length, "histogram series is candle-aligned");
  assert.ok(Number.isFinite(macd.histogram), "latest histogram should be finite");

  const defined = macd.histogramSeries.filter((v) => v != null);
  const minHist = Math.min(...defined);
  assert.ok(minHist < -1e-2, `histogram must go clearly negative during the drop (min=${minHist})`);

  const EPS = 1e-3;
  let firstGreenIdx = -1;
  for (let i = 1; i < macd.histogramSeries.length; i++) {
    const a = macd.histogramSeries[i - 1];
    const b = macd.histogramSeries[i];
    if (a != null && b != null && a < -EPS && b > EPS) { firstGreenIdx = i; break; }
  }
  assert.ok(firstGreenIdx > 50,
    `expected a genuine negative->positive histogram cross in the rise region (idx>50), got ${firstGreenIdx}`);
});

test("computeMacd returns null when there is insufficient data", () => {
  assert.equal(computeMacd([1, 2, 3], { fast: 12, slow: 26, signal: 9 }), null);
});
