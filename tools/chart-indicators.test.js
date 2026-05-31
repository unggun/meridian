import { test } from "node:test";
import assert from "node:assert/strict";

// We test the dispatcher's fallback by pointing the GMGN path at a fetcher that throws,
// and stubbing the Meridian fetch via a global fetch override.
import { fetchChartIndicatorsForMint } from "./chart-indicators.js";
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
