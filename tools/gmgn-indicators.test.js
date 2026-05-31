import { test } from "node:test";
import assert from "node:assert/strict";
import { resampleKlines } from "./gmgn-indicators.js";

// Helper: build a 1m candle. time in ms.
const c = (time, open, high, low, close, volume) => ({ time, open, high, low, close, volume });

test("resampleKlines buckets five 1m candles into one 5m candle", () => {
  const base = 1_700_000_000_000; // arbitrary ms aligned to a 5m boundary for the test
  const min = 60_000;
  const ones = [
    c(base + 0 * min, 10, 12, 9, 11, 100),
    c(base + 1 * min, 11, 15, 10, 14, 200),
    c(base + 2 * min, 14, 14, 8, 9, 150),
    c(base + 3 * min, 9, 11, 7, 10, 50),
    c(base + 4 * min, 10, 13, 9, 12, 300),
  ];
  const out = resampleKlines(ones, 5);
  assert.equal(out.length, 1);
  assert.equal(out[0].open, 10);   // first candle's open
  assert.equal(out[0].close, 12);  // last candle's close
  assert.equal(out[0].high, 15);   // max high
  assert.equal(out[0].low, 7);     // min low
  assert.equal(out[0].volume, 800); // sum
});

test("resampleKlines drops an incomplete trailing bucket only if it has zero candles", () => {
  const base = 1_700_000_000_000;
  const min = 60_000;
  // 7 one-minute candles → one full 5m bucket + a partial (2-candle) bucket which we KEEP
  const ones = Array.from({ length: 7 }, (_, i) =>
    c(base + i * min, 10 + i, 20, 5, 10 + i, 10));
  const out = resampleKlines(ones, 5);
  assert.equal(out.length, 2);          // full bucket + partial bucket kept
  assert.equal(out[1].open, 15);        // 6th candle (index 5) opens the partial bucket
  assert.equal(out[1].volume, 20);      // two candles summed
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
import { computeIndicators } from "./gmgn-indicators.js";

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

test("fetchGmgnIndicatorPayload throws when the feed returns too few candles", async () => {
  __clearKlineCacheForTest();
  __setKlineFetcherForTest(async () => fakeKlines(3));
  await assert.rejects(
    () => fetchGmgnIndicatorPayload("MINT2", { interval: "5_MINUTE", rsiLength: 2 }),
    /insufficient/i,
  );
  __setKlineFetcherForTest(null);
});
