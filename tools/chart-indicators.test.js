import { test } from "node:test";
import assert from "node:assert/strict";

// We test the dispatcher's fallback by pointing the GMGN path at a fetcher that throws,
// and stubbing the Meridian fetch via a global fetch override.
import { fetchChartIndicatorsForMint, evaluateSupertrendBbPullback, confirmIndicatorPreset } from "./chart-indicators.js";
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

test("bb-pullback: degrade path (no recent), no single-bar dip → reject", () => {
  // low=102 > lower=95: no dip on the single bar
  const r = evaluateSupertrendBbPullback(
    mk5({ close: 105, low: 102, lower: 95, middle: 100, st: 95 }),
    mk15("bullish"), PARAMS);
  assert.equal(r.confirmed, false);
  assert.equal(r.degraded, true);
  assert.match(r.reason, /degrade/i);
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

test("confirmIndicatorPreset routes supertrend_bb_pullback through the composite (degrade path)", async () => {
  const prev = {
    src: config.gmgn.indicatorSource,
    en: config.indicators.enabled,
    ep: config.indicators.entryPreset,
    lb: config.indicators.pullbackLookbackBars,
    db: config.indicators.pullbackDipBand,
    rb: config.indicators.pullbackReclaimBand,
  };
  config.gmgn.indicatorSource = "meridian"; // no `recent` → exercise degrade + routing
  config.indicators.enabled = true;
  config.indicators.entryPreset = "supertrend_bb_pullback";
  config.indicators.pullbackLookbackBars = 6;
  config.indicators.pullbackDipBand = "lower";
  config.indicators.pullbackReclaimBand = "middle";

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    async text() {
      const is15 = String(url).includes("15_MINUTE");
      return JSON.stringify(is15
        ? { latest: { candle: { close: 100, low: 99 }, supertrend: { value: 90, direction: "bullish" }, bollinger: { lower: 80, middle: 90, upper: 100 }, rsi: { value: 50 } } }
        : { latest: { candle: { close: 105, low: 95 }, supertrend: { value: 95, direction: "bullish" }, bollinger: { lower: 95, middle: 100, upper: 110 }, rsi: { value: 50 } } });
    },
  });
  try {
    const res = await confirmIndicatorPreset({ mint: "MINTZ", side: "entry", refresh: true });
    assert.equal(res.preset, "supertrend_bb_pullback");
    assert.equal(res.confirmed, true);
    assert.equal(res.enabled, true);
    assert.equal(res.skipped, false);
    assert.equal(res.intervals.length, 2);
    assert.ok(res.intervals.every((i) => i.ok));
  } finally {
    globalThis.fetch = realFetch;
    config.gmgn.indicatorSource = prev.src;
    config.indicators.enabled = prev.en;
    config.indicators.entryPreset = prev.ep;
    config.indicators.pullbackLookbackBars = prev.lb;
    config.indicators.pullbackDipBand = prev.db;
    config.indicators.pullbackReclaimBand = prev.rb;
  }
});
