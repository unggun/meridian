import { test } from "node:test";
import assert from "node:assert/strict";

// We test the dispatcher's fallback by pointing the GMGN path at a fetcher that throws,
// and stubbing the Meridian fetch via a global fetch override.
import { fetchChartIndicatorsForMint, evaluateSupertrendBbExtension, evaluateSupertrendRollover, confirmSupertrendRolloverExit, confirmIndicatorPreset } from "./chart-indicators.js";
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
const mk5 = ({ close, high, low, lower, middle, upper, st, recent }) => ({
  latest: {
    candle: { close, high: high ?? close + 1, low: low ?? close - 1, open: close },
    previousCandle: { close },
    rsi: { value: 50 },
    bollinger: { upper, middle, lower },
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
const PARAMS = { lookbackBars: 6, tagBand: "upper", floorBand: "middle" };

test("bb-extension: 15m bullish + 5m upper-band tag in window, still above middle → confirm", () => {
  const recent = [
    { close: 108, high: 111, low: 105, bbLower: 90, bbMiddle: 100, bbUpper: 110 }, // tag: high 111 >= upper 110
    { close: 106, high: 108, low: 104, bbLower: 91, bbMiddle: 100, bbUpper: 110 },
    { close: 105, high: 107, low: 103, bbLower: 92, bbMiddle: 100, bbUpper: 110 },
  ];
  const r = evaluateSupertrendBbExtension(
    mk5({ close: 105, high: 107, low: 103, lower: 92, middle: 100, upper: 110, st: 95, recent }),
    mk15("bullish"), PARAMS);
  assert.equal(r.confirmed, true);
});

test("bb-extension: tag present but latest close below floor (pullback done) → reject", () => {
  const recent = [{ close: 108, high: 111, low: 105, bbLower: 90, bbMiddle: 100, bbUpper: 110 }];
  const r = evaluateSupertrendBbExtension(
    mk5({ close: 98, high: 100, low: 96, lower: 90, middle: 100, upper: 110, st: 95, recent }),
    mk15("bullish"), PARAMS);
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /floor/i);
});

test("bb-extension: valid 5m setup but 15m bearish → reject", () => {
  const recent = [{ close: 108, high: 111, low: 105, bbLower: 90, bbMiddle: 100, bbUpper: 110 }];
  const r = evaluateSupertrendBbExtension(
    mk5({ close: 105, high: 107, low: 103, lower: 92, middle: 100, upper: 110, st: 95, recent }),
    mk15("bearish"), PARAMS);
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /15m/i);
});

test("bb-extension: veto when 5m close below supertrend → reject", () => {
  const recent = [{ close: 108, high: 111, low: 105, bbLower: 90, bbMiddle: 100, bbUpper: 110 }];
  const r = evaluateSupertrendBbExtension(
    mk5({ close: 92, high: 111, low: 90, lower: 90, middle: 100, upper: 110, st: 95, recent }),
    mk15("bullish"), PARAMS);
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /veto/i);
});

test("bb-extension: no upper-band tag in window → reject", () => {
  const recent = [
    { close: 104, high: 106, low: 102, bbLower: 90, bbMiddle: 100, bbUpper: 110 }, // high 106 < upper 110
    { close: 105, high: 107, low: 103, bbLower: 91, bbMiddle: 100, bbUpper: 110 },
  ];
  const r = evaluateSupertrendBbExtension(
    mk5({ close: 105, high: 107, low: 103, lower: 91, middle: 100, upper: 110, st: 95, recent }),
    mk15("bullish"), PARAMS);
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /tag/i);
});

test("bb-extension: degrade path (no recent) uses single-bar tag → confirm", () => {
  const r = evaluateSupertrendBbExtension(
    mk5({ close: 105, high: 111, low: 104, lower: 90, middle: 100, upper: 110, st: 95 }), // high 111 >= upper 110
    mk15("bullish"), PARAMS);
  assert.equal(r.confirmed, true);
  assert.equal(r.degraded, true);
});

test("bb-extension: degrade path (no recent), no single-bar tag → reject", () => {
  // high=108 < upper=110: no tag on the single bar
  const r = evaluateSupertrendBbExtension(
    mk5({ close: 105, high: 108, low: 104, lower: 90, middle: 100, upper: 110, st: 95 }),
    mk15("bullish"), PARAMS);
  assert.equal(r.confirmed, false);
  assert.equal(r.degraded, true);
  assert.match(r.reason, /degrade/i);
});

test("bb-extension: tag outside lookback window → reject", () => {
  const recent = [
    { close: 108, high: 111, low: 105, bbLower: 90, bbMiddle: 100, bbUpper: 110 }, // tag, but oldest
    { close: 106, high: 108, low: 104, bbLower: 91, bbMiddle: 100, bbUpper: 110 },
    { close: 105, high: 107, low: 103, bbLower: 92, bbMiddle: 100, bbUpper: 110 },
  ];
  const r = evaluateSupertrendBbExtension(
    mk5({ close: 105, high: 107, low: 103, lower: 92, middle: 100, upper: 110, st: 95, recent }),
    mk15("bullish"), { lookbackBars: 2, tagBand: "upper", floorBand: "middle" });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /tag/i);
});

test("confirmIndicatorPreset bb-extension fails closed (skipped) when fetches error", async () => {
  const prev = {
    src: config.gmgn.indicatorSource,
    en: config.indicators.enabled,
    ep: config.indicators.entryPreset,
  };
  config.gmgn.indicatorSource = "gmgn";
  config.indicators.enabled = true;
  config.indicators.entryPreset = "supertrend_bb_extension";

  __clearKlineCacheForTest();
  __setKlineFetcherForTest(async () => { throw new Error("simulated GMGN outage"); });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, async text() { return ""; } });

  try {
    const res = await confirmIndicatorPreset({ mint: "MINTERR", side: "entry", refresh: true });
    assert.equal(res.preset, "supertrend_bb_extension");
    assert.equal(res.skipped, true);
    assert.equal(res.confirmed, true); // fail-open here → executor fails closed on `skipped`
    assert.equal(res.intervals.length, 2);
    assert.ok(res.intervals.every((i) => i.ok === false));
  } finally {
    globalThis.fetch = realFetch;
    __setKlineFetcherForTest(null);
    __clearKlineCacheForTest();
    config.gmgn.indicatorSource = prev.src;
    config.indicators.enabled = prev.en;
    config.indicators.entryPreset = prev.ep;
  }
});

test("confirmIndicatorPreset routes supertrend_bb_extension through the composite (degrade path)", async () => {
  const prev = {
    src: config.gmgn.indicatorSource,
    en: config.indicators.enabled,
    ep: config.indicators.entryPreset,
    lb: config.indicators.extensionLookbackBars,
    tb: config.indicators.extensionTagBand,
    fb: config.indicators.extensionFloorBand,
  };
  config.gmgn.indicatorSource = "meridian"; // no `recent` → exercise degrade + routing
  config.indicators.enabled = true;
  config.indicators.entryPreset = "supertrend_bb_extension";
  config.indicators.extensionLookbackBars = 3;
  config.indicators.extensionTagBand = "upper";
  config.indicators.extensionFloorBand = "middle";

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    async text() {
      const is15 = String(url).includes("15_MINUTE");
      return JSON.stringify(is15
        ? { latest: { candle: { close: 100, high: 101, low: 99 }, supertrend: { value: 90, direction: "bullish" }, bollinger: { lower: 80, middle: 90, upper: 100 }, rsi: { value: 50 } } }
        : { latest: { candle: { close: 105, high: 111, low: 104 }, supertrend: { value: 95, direction: "bullish" }, bollinger: { lower: 95, middle: 100, upper: 110 }, rsi: { value: 50 } } });
    },
  });
  try {
    const res = await confirmIndicatorPreset({ mint: "MINTZ", side: "entry", refresh: true });
    assert.equal(res.preset, "supertrend_bb_extension");
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
    config.indicators.extensionLookbackBars = prev.lb;
    config.indicators.extensionTagBand = prev.tb;
    config.indicators.extensionFloorBand = prev.fb;
  }
});

test("confirmIndicatorPreset disables a side via sentinel exitPreset (no fetch, enabled:false)", async () => {
  const prev = { en: config.indicators.enabled, xp: config.indicators.exitPreset };
  config.indicators.enabled = true; // entry gate stays live; only the exit side is sentinel-disabled
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("fetch must not be called for a disabled side"); };
  __setKlineFetcherForTest(async () => { throw new Error("kline fetch must not be called for a disabled side"); });
  try {
    for (const sentinel of ["none", "off", "disabled", "", null]) {
      config.indicators.exitPreset = sentinel;
      const res = await confirmIndicatorPreset({ mint: "MINTX", side: "exit", refresh: true });
      assert.equal(res.enabled, false, `sentinel ${JSON.stringify(sentinel)} should report enabled:false`);
      // enabled:false means the underwater chart-exit block (index.js) never acts on it.
    }
  } finally {
    globalThis.fetch = realFetch;
    __setKlineFetcherForTest(null);
    config.indicators.enabled = prev.en;
    config.indicators.exitPreset = prev.xp;
  }
});

// 15m payload with a `recent` series for the rollover exit. recent[-1]=latest closed bar,
// recent[-2]=previous bar (what the triggers read), recent[-3]=the bar before that.
const mkRollover = ({ direction, recent }) => ({
  latest: {
    candle: { close: 100, high: 101, low: 99, open: 100 },
    previousCandle: { close: 100 },
    rsi: { value: 50 },
    bollinger: { upper: 110, middle: 100, lower: 90 },
    supertrend: { value: 105, direction },
    states: {},
  },
  ...(recent ? { recent } : {}),
});
const rbar = ({ close = 100, bbUpper = 110, rsi = 50, macdHist = 0 } = {}) =>
  ({ close, high: close + 1, low: close - 1, bbLower: 90, bbMiddle: 100, bbUpper, rsi, macdHist });
const ALL = { rsiEnabled: true, macdEnabled: true, bbEnabled: true, rsiUpper: 90 };

test("rollover: bullish 15m supertrend vetoes every trigger", () => {
  const r = evaluateSupertrendRollover(
    mkRollover({ direction: "bullish", recent: [rbar({ rsi: 95 }), rbar({ rsi: 95 })] }), ALL);
  assert.equal(r.confirmed, false);
  assert.equal(r.skipped, false);
});

test("rollover: RSI>90 on the just-closed bar fires when 15m ST is bearish", () => {
  // recent[-1] is the just-closed bar.
  const r = evaluateSupertrendRollover(
    mkRollover({ direction: "bearish", recent: [rbar({ rsi: 50 }), rbar({ rsi: 95 })] }), ALL);
  assert.equal(r.confirmed, true);
});

test("rollover: RSI trigger reads the just-closed bar, not the bar before it", () => {
  // hot RSI on the older bar (recent[-2]), calm on the just-closed bar (recent[-1]) -> must NOT fire.
  const r = evaluateSupertrendRollover(
    mkRollover({ direction: "bearish", recent: [rbar({ rsi: 95 }), rbar({ rsi: 50 })] }),
    { ...ALL, macdEnabled: false, bbEnabled: false });
  assert.equal(r.confirmed, false);
});

test("rollover: just-closed bar closing above the upper band fires", () => {
  const r = evaluateSupertrendRollover(
    mkRollover({ direction: "bearish", recent: [rbar({ close: 100 }), rbar({ close: 120, bbUpper: 110 })] }),
    { ...ALL, rsiEnabled: false, macdEnabled: false });
  assert.equal(r.confirmed, true);
});

test("rollover: just-closed bar = first green histogram fires", () => {
  // recent[-2] hist<=0, recent[-1] hist>0 -> first green on the just-closed bar.
  const r = evaluateSupertrendRollover(
    mkRollover({ direction: "bearish", recent: [rbar({ macdHist: -1 }), rbar({ macdHist: 2 })] }),
    { ...ALL, rsiEnabled: false, bbEnabled: false });
  assert.equal(r.confirmed, true);
});

test("rollover: macd does not fire when the bar before was already green", () => {
  // recent[-2] already green -> just-closed bar is not the FIRST green.
  const r = evaluateSupertrendRollover(
    mkRollover({ direction: "bearish", recent: [rbar({ macdHist: 1 }), rbar({ macdHist: 2 })] }),
    { ...ALL, rsiEnabled: false, bbEnabled: false });
  assert.equal(r.confirmed, false);
});

test("rollover: a disabled sub-trigger does not fire", () => {
  const r = evaluateSupertrendRollover(
    mkRollover({ direction: "bearish", recent: [rbar({ rsi: 50 }), rbar({ rsi: 95 })] }),
    { rsiEnabled: false, macdEnabled: false, bbEnabled: false, rsiUpper: 90 });
  assert.equal(r.confirmed, false);
});

test("rollover: missing recent series degrades to skipped (no exit)", () => {
  const r = evaluateSupertrendRollover(mkRollover({ direction: "bearish", recent: undefined }), ALL);
  assert.equal(r.confirmed, false);
  assert.equal(r.skipped, true);
});

test("confirmSupertrendRolloverExit returns skipped when payload has no recent series", async () => {
  const prevSource = config.gmgn.indicatorSource;
  config.gmgn.indicatorSource = "meridian"; // meridian payload has no `recent` → degrade path
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async text() {
      return JSON.stringify({
        latest: {
          candle: { close: 100 },
          previousCandle: { close: 100 },
          rsi: { value: 50 },
          bollinger: { upper: 110, middle: 100, lower: 90 },
          supertrend: { value: 105, direction: "bearish" },
          states: {},
        },
      });
    },
  });
  try {
    const r = await confirmSupertrendRolloverExit({ mint: "MINTROLL" });
    assert.equal(r.skipped, true);
    assert.equal(r.confirmed, false);
    assert.equal(r.preset, "supertrend_rollover_exit");
  } finally {
    globalThis.fetch = realFetch;
    config.gmgn.indicatorSource = prevSource;
  }
});
