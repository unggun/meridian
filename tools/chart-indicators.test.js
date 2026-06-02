import { test } from "node:test";
import assert from "node:assert/strict";

// We test the dispatcher's fallback by pointing the GMGN path at a fetcher that throws,
// and stubbing the Meridian fetch via a global fetch override.
import { fetchChartIndicatorsForMint, evaluateSupertrendBbPullback } from "./chart-indicators.js";
import { __setKlineFetcherForTest, __clearKlineCacheForTest } from "./gmgn-indicators.js";
import { config } from "../config.js";

test("fetchChartIndicatorsForMint falls back to meridian when GMGN throws", async () => {
  __clearKlineCacheForTest();
  __setKlineFetcherForTest(async () => { throw new Error("simulated GMGN outage"); });
  const prevSource = config.gmgn.indicatorSource;
  config.gmgn.indicatorSource = "gmgn";

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async text() {
      return JSON.stringify({ latest: { candle: { close: 42 }, supertrend: { value: 1, direction: "bullish" } } });
    },
  });

  try {
    const payload = await fetchChartIndicatorsForMint("MINTX", { interval: "5_MINUTE" });
    assert.equal(payload.latest.candle.close, 42, "should have returned the meridian payload");
  } finally {
    globalThis.fetch = realFetch;
    config.gmgn.indicatorSource = prevSource;
    __setKlineFetcherForTest(null);
  }
});

test("fetchChartIndicatorsForMint uses meridian directly when source=meridian", async () => {
  const prevSource = config.gmgn.indicatorSource;
  config.gmgn.indicatorSource = "meridian";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async text() { return JSON.stringify({ latest: { candle: { close: 7 } } }); },
  });
  try {
    const payload = await fetchChartIndicatorsForMint("MINTY", { interval: "5_MINUTE" });
    assert.equal(payload.latest.candle.close, 7);
  } finally {
    globalThis.fetch = realFetch;
    config.gmgn.indicatorSource = prevSource;
  }
});

// 5m payload builder. `recent` optional → omit to exercise the degrade path.
const mk5 = ({ close, low, lower, middle, st, recent }) => ({
  latest: {
    candle: { close, low, high: close + 1, open: close },
    previousCandle: { close },
    rsi: { value: 50 },
    bollinger: { upper: middle + (middle - lower), middle, lower },
    supertrend: { value: st, direction: close >= st ? "bullish" : "bearish" },
    states: {},
  },
  ...(recent ? { recent } : {}),
});
const mk15 = (direction) => ({
  latest: {
    candle: { close: 100, low: 99, high: 101, open: 100 },
    previousCandle: { close: 100 },
    rsi: { value: 50 },
    bollinger: { upper: 110, middle: 100, lower: 90 },
    supertrend: { value: 90, direction },
    states: {},
  },
});
const PARAMS = { lookbackBars: 6, dipBand: "lower", reclaimBand: "middle" };

test("bb-pullback: 15m bullish + 5m pullback-and-reclaim in window → confirm", () => {
  const recent = [
    { close: 101, low: 90, bbLower: 95, bbMiddle: 100 }, // dip: low 90 <= lower 95
    { close: 103, low: 100, bbLower: 96, bbMiddle: 101 },
    { close: 105, low: 102, bbLower: 97, bbMiddle: 102 },
  ];
  const r = evaluateSupertrendBbPullback(
    mk5({ close: 105, low: 102, lower: 97, middle: 100, st: 95, recent }),
    mk15("bullish"), PARAMS);
  assert.equal(r.confirmed, true);
});

test("bb-pullback: dip but no reclaim (close below middle) → reject", () => {
  const recent = [{ close: 96, low: 90, bbLower: 95, bbMiddle: 100 }];
  const r = evaluateSupertrendBbPullback(
    mk5({ close: 98, low: 90, lower: 95, middle: 100, st: 95, recent }),
    mk15("bullish"), PARAMS);
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /reclaim/i);
});

test("bb-pullback: valid 5m setup but 15m bearish → reject", () => {
  const recent = [{ close: 101, low: 90, bbLower: 95, bbMiddle: 100 }];
  const r = evaluateSupertrendBbPullback(
    mk5({ close: 105, low: 102, lower: 97, middle: 100, st: 95, recent }),
    mk15("bearish"), PARAMS);
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /15m/i);
});

test("bb-pullback: veto when 5m close below supertrend → reject", () => {
  const recent = [{ close: 101, low: 90, bbLower: 95, bbMiddle: 100 }];
  const r = evaluateSupertrendBbPullback(
    mk5({ close: 92, low: 90, lower: 95, middle: 100, st: 95, recent }),
    mk15("bullish"), PARAMS);
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /veto/i);
});

test("bb-pullback: degrade path (no recent) uses single-bar check → confirm", () => {
  const r = evaluateSupertrendBbPullback(
    mk5({ close: 105, low: 95, lower: 95, middle: 100, st: 95 }), // low 95 <= lower 95
    mk15("bullish"), PARAMS);
  assert.equal(r.confirmed, true);
  assert.equal(r.degraded, true);
});

test("bb-pullback: dip outside lookback window → reject", () => {
  const recent = [
    { close: 101, low: 90, bbLower: 95, bbMiddle: 100 }, // dip, but oldest
    { close: 103, low: 101, bbLower: 96, bbMiddle: 101 },
    { close: 105, low: 102, bbLower: 97, bbMiddle: 102 },
  ];
  const r = evaluateSupertrendBbPullback(
    mk5({ close: 105, low: 102, lower: 97, middle: 100, st: 95, recent }),
    mk15("bullish"), { lookbackBars: 2, dipBand: "lower", reclaimBand: "middle" });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /pullback/i);
});
