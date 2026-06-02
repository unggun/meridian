import { config } from "../config.js";
import { gmgnFetch } from "./gmgn-client.js";   // leaf client — NOT gmgn.js (avoids import cycle)

// Compute chart indicators from GMGN klines, matching the payload shape that
// tools/chart-indicators.js consumers expect. Pure functions + one cached fetch.

// Bucket ascending-by-time 1-minute OHLCV candles into N-minute candles, anchored to
// wall-clock boundaries (bucketStart = floor(time / N·60s) · N·60s) rather than array
// index. Clock alignment makes a given wall-clock period always group the same minutes,
// so a sliding 1m window no longer re-phases the resampled series on every refresh — the
// trailing CLOSED buckets are invariant to where the window happens to start. Each output
// candle's `time` is the aligned bucket start. Gaps are handled naturally (each minute
// lands in its own clock bucket).
//
// `dropInProgress`: drop the latest (highest-start) bucket — the still-forming current
// period — so the supertrend/RSI/Bollinger decision is taken on the last CLOSED bar and
// does not repaint as new 1m candles arrive within the period.
export function resampleKlines(klines1m, targetMinutes, { dropInProgress = false } = {}) {
  if (!Array.isArray(klines1m) || klines1m.length === 0) return [];
  const widthMs = Math.max(1, Math.floor(targetMinutes)) * 60_000;
  const buckets = new Map(); // bucketStart → aggregate
  for (const k of klines1m) {
    const t = Number(k.time);
    if (!Number.isFinite(t)) continue;
    const start = Math.floor(t / widthMs) * widthMs;
    const b = buckets.get(start);
    if (!b) {
      buckets.set(start, {
        time: start,
        firstTime: t,
        lastTime: t,
        open: k.open,
        close: k.close,
        high: k.high,
        low: k.low,
        volume: Number(k.volume) || 0,
      });
    } else {
      if (t < b.firstTime) { b.firstTime = t; b.open = k.open; }
      if (t >= b.lastTime) { b.lastTime = t; b.close = k.close; }
      if (k.high > b.high) b.high = k.high;
      if (k.low < b.low) b.low = k.low;
      b.volume += Number(k.volume) || 0;
    }
  }
  const out = [...buckets.values()]
    .sort((a, b) => a.time - b.time)
    .map(({ firstTime, lastTime, ...candle }) => candle);
  if (dropInProgress && out.length > 0) out.pop(); // latest period is still forming
  return out;
}

// Wilder's RSI of the final close. Returns null if insufficient data.
// Needs length+1 closes minimum; uses all available history for smoothing.
export function computeRsi(closes, length = 2) {
  if (!Array.isArray(closes) || closes.length < length + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  // Seed with the first `length` deltas (simple average).
  for (let i = 1; i <= length; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) avgGain += delta;
    else avgLoss -= delta;
  }
  avgGain /= length;
  avgLoss /= length;
  // Wilder-smooth across the rest.
  for (let i = length + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (length - 1) + gain) / length;
    avgLoss = (avgLoss * (length - 1) + loss) / length;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Bollinger Bands for the final candle. Population stddev. Null if insufficient data.
export function computeBollinger(closes, period = 20, stdDevMult = 2) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const window = closes.slice(-period);
  const mean = window.reduce((sum, v) => sum + v, 0) / period;
  const variance = window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return {
    middle: mean,
    upper: mean + stdDevMult * sd,
    lower: mean - stdDevMult * sd,
  };
}

// Per-bar Bollinger bands (plus close/high/low) for the last `n` candles. Each band is
// computed over the trailing `period` closes ending at that bar, so the series is
// non-repainting. Used to detect band interactions across a window of recently CLOSED
// bars — a lower-band dip OR an upper-band tag. Bars without enough history get null bands.
export function buildRecentSeries(candles, params, n) {
  const out = [];
  if (!Array.isArray(candles) || candles.length === 0) return out;
  const count = Math.max(0, Number.isFinite(n) ? Math.floor(n) : 1);
  if (count === 0) return out;
  const start = Math.max(0, candles.length - count);
  for (let i = start; i < candles.length; i++) {
    const closesUpToI = candles.slice(0, i + 1).map((c) => c.close);
    const bb = computeBollinger(closesUpToI, params.bollingerPeriod, params.bollingerStdDev);
    out.push({
      close: candles[i].close,
      high: candles[i].high,
      low: candles[i].low,
      bbLower: bb ? bb.lower : null,
      bbMiddle: bb ? bb.middle : null,
      bbUpper: bb ? bb.upper : null,
    });
  }
  return out;
}

// ATR-based Supertrend over OHLC candles (ascending by time).
// Returns { value, direction, breakUp, breakDown } for the final candle, or null.
// direction: "bullish" | "bearish". breakUp/breakDown = direction flipped on the
// final candle relative to the prior one.
export function computeSupertrend(candles, period = 10, multiplier = 3) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;

  // True Range series.
  const tr = [];
  for (let i = 0; i < candles.length; i++) {
    const cur = candles[i];
    if (i === 0) {
      tr.push(cur.high - cur.low);
      continue;
    }
    const prevClose = candles[i - 1].close;
    tr.push(Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prevClose),
      Math.abs(cur.low - prevClose),
    ));
  }

  // Wilder ATR.
  const atr = new Array(candles.length).fill(null);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += tr[i];
  atr[period - 1] = seed / period;
  for (let i = period; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }

  // Supertrend bands + direction.
  // Seed the initial direction from the first evaluated bar's price position relative
  // to its basic mid-band (HL2) instead of assuming bullish: close >= mid → bullish,
  // else bearish. This avoids reporting bullish on a token whose early candles are in a
  // downtrend but haven't crossed the lower band yet.
  const seedIdx = period - 1;
  const seedMid = (candles[seedIdx].high + candles[seedIdx].low) / 2;
  let dirNum = candles[seedIdx].close >= seedMid ? 1 : -1;
  let prevDirNum = dirNum;
  let direction = dirNum === 1 ? "bullish" : "bearish";
  let finalUpper = null;
  let finalLower = null;
  let supertrend = null;

  for (let i = period - 1; i < candles.length; i++) {
    const mid = (candles[i].high + candles[i].low) / 2;
    const basicUpper = mid + multiplier * atr[i];
    const basicLower = mid - multiplier * atr[i];
    const close = candles[i].close;
    const prevClose = candles[i - 1].close;

    finalUpper = (finalUpper == null || prevClose > finalUpper)
      ? basicUpper
      : Math.min(basicUpper, finalUpper);
    finalLower = (finalLower == null || prevClose < finalLower)
      ? basicLower
      : Math.max(basicLower, finalLower);

    prevDirNum = dirNum;
    if (close > finalUpper) dirNum = 1;
    else if (close < finalLower) dirNum = -1;
    // else: direction unchanged

    supertrend = dirNum === 1 ? finalLower : finalUpper;
    direction = dirNum === 1 ? "bullish" : "bearish";
  }

  return {
    value: supertrend,
    direction,
    breakUp: prevDirNum === -1 && dirNum === 1,
    breakDown: prevDirNum === 1 && dirNum === -1,
  };
}

// Best-effort Fibonacci retracement levels from the swing high/low of the last N bars.
// Approximate by design (the upstream feed may anchor swings differently). Present so
// the payload shape is complete; the fibo_* presets are not in active use.
export function computeFibonacci(candles, lookbackBars = 55) {
  const window = candles.slice(-Math.max(2, lookbackBars));
  const high = Math.max(...window.map((c) => c.high));
  const low = Math.min(...window.map((c) => c.low));
  const span = high - low;
  const level = (ratio) => high - span * ratio;
  return {
    levels: {
      "0.236": level(0.236),
      "0.382": level(0.382),
      "0.500": level(0.5),
      "0.618": level(0.618),
      "0.786": level(0.786),
    },
  };
}

// Orchestrate all indicators into the payload shape consumers expect.
// Throws if there is insufficient data to compute the core indicators — the seam
// catches this and falls back to the Meridian endpoint.
export function computeIndicators(candles, params) {
  if (!Array.isArray(candles) || candles.length < 2) {
    throw new Error("insufficient kline data for indicators");
  }
  const closes = candles.map((c) => c.close);
  const supertrend = computeSupertrend(candles, params.supertrendPeriod, params.supertrendMultiplier);
  const bollinger = computeBollinger(closes, params.bollingerPeriod, params.bollingerStdDev);
  const rsi = computeRsi(closes, params.rsiLength);
  if (!supertrend || !bollinger || rsi == null) {
    throw new Error("insufficient kline data for indicators");
  }
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  return {
    latest: {
      candle: { open: last.open, high: last.high, low: last.low, close: last.close },
      previousCandle: { close: prev.close },
      rsi: { value: rsi },
      bollinger: { upper: bollinger.upper, middle: bollinger.middle, lower: bollinger.lower },
      supertrend: { value: supertrend.value, direction: supertrend.direction },
      states: {
        supertrendBreakUp: supertrend.breakUp,
        supertrendBreakDown: supertrend.breakDown,
      },
      fibonacci: computeFibonacci(candles, params.fibLookbackBars),
    },
    recent: buildRecentSeries(candles, params, params.recentSeriesBars || 16),
  };
}

const INTERVAL_MINUTES = { "5_MINUTE": 5, "15_MINUTE": 15 };

// Default indicator params; overridden by config.gmgn.indicatorParams.
export const DEFAULT_INDICATOR_PARAMS = {
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  bollingerPeriod: 20,
  bollingerStdDev: 2,
  fibLookbackBars: 55,
  klineCacheTtlSec: 30,
  // How many 1m candles to fetch per mint. Must give the COARSEST interval enough
  // warmup after resampling. GMGN hard-caps a single token_kline call at ~1000 1m bars
  // (verified: requesting 5000 returns 1000), i.e. ~66 closed 15m bars (~17h) — the
  // ceiling for 15m parity. Fetch the full 1000 so the 15m warmup below can be filled.
  // (900 yielded only ~60 closed 15m bars, just inside the seed-flap zone.)
  klineLimit: 1000,
  // Anchor the indicator window to a FIXED number of most-recent CLOSED resampled bars.
  // The 1m fetch is a sliding window, so without this the oldest bar (and thus the
  // supertrend seed) moved every refresh and could flip direction at the same instant.
  // Pinning to the last N closed buckets makes the seed advance only when a bar actually
  // closes — one controlled step, never per-fetch jitter.
  //
  // VALUE (66, not 50): the supertrend seed only washes out once the window contains the
  // last trend-defining band cross. On range-bound tokens a 50-bar 15m window (~12.5h) can
  // miss it and report the seed's guess instead of the true carried state — CUM-SOL's last
  // deploy seeded bullish at 50 bars while GMGN's TradingView ST read bearish (price below
  // 0.0005067). Convergence to GMGN is non-monotonic and only stabilizes from ~58 bars up,
  // so anchor to 66 — essentially all bars a 1000-kline fetch yields for 15m, safely clear
  // of the flap zone. See scripts/sweep-warmup-parity.js and the CUM 15m regression in
  // gmgn-indicators.test.js.
  warmupBars: 66,
  // How many most-recent CLOSED bars to expose in the payload's `recent` series.
  // Consumed by the supertrend_bb_extension entry preset to detect an upper-band tag across
  // a window of closed bars (a durable signal, vs a single-bar event that the 30-min
  // screener would usually miss). Keep >= the largest expected extensionLookbackBars.
  recentSeriesBars: 16,
};

function indicatorParams() {
  return { ...DEFAULT_INDICATOR_PARAMS, ...(config.gmgn?.indicatorParams || {}) };
}

// Per-mint 1m-kline cache: Map<mint, { klines, ts }>. In-memory, TTL-bounded, no disk.
const klineCache = new Map();

// Injectable fetcher for tests. When null, the real GMGN fetch is used.
let klineFetcher = null;
export function __setKlineFetcherForTest(fn) { klineFetcher = fn; }
export function __clearKlineCacheForTest() { klineCache.clear(); }

async function realFetch1mKlines(mint) {
  const limit = Math.max(300, Number(indicatorParams().klineLimit) || 900);
  const payload = await gmgnFetch("/v1/market/token_kline", {
    params: { chain: "sol", address: mint, resolution: "1m", limit },
  });
  const list =
    payload?.data?.list ?? payload?.list ?? payload?.data ?? [];
  if (!Array.isArray(list)) return [];
  // Normalize to numbers, ascending by time.
  return list
    .map((k) => ({
      time: Number(k.time),
      open: Number(k.open),
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
      volume: Number(k.volume),
    }))
    .filter((k) => Number.isFinite(k.time) && Number.isFinite(k.close))
    .sort((a, b) => a.time - b.time);
}

async function getCached1mKlines(mint) {
  const ttlMs = Math.max(0, Number(indicatorParams().klineCacheTtlSec)) * 1000;
  const hit = klineCache.get(mint);
  if (hit && ttlMs > 0 && Date.now() - hit.ts < ttlMs) return hit.klines;
  const fetcher = klineFetcher || realFetch1mKlines;
  const klines = await fetcher(mint);
  // Only cache a usable (non-empty) result. A transient empty GMGN response must not
  // poison the cache for the whole TTL window and suppress the GMGN path.
  if (Array.isArray(klines) && klines.length > 0) {
    klineCache.set(mint, { klines, ts: Date.now() });
  }
  return klines;
}

// Top-level: produce the Meridian-shaped { latest } payload from GMGN klines.
// Throws on insufficient data or fetch failure — caller (the seam) falls back.
export async function fetchGmgnIndicatorPayload(mint, { interval, rsiLength } = {}) {
  const minutes = INTERVAL_MINUTES[String(interval || "").trim().toUpperCase()] || 5;
  const klines1m = await getCached1mKlines(mint);
  if (!Array.isArray(klines1m) || klines1m.length === 0) {
    throw new Error("GMGN returned empty kline list");
  }
  const params = { ...indicatorParams(), rsiLength: Number(rsiLength) || 2 };
  // Clock-aligned, in-progress bar excluded → decision taken on the last CLOSED bar.
  const closed = resampleKlines(klines1m, minutes, { dropInProgress: true });
  // Anchor to the last N closed bars so the supertrend seed is stable across fetches.
  const warmupBars = Math.max(params.bollingerPeriod, params.supertrendPeriod) + 1;
  const window = closed.slice(-Math.max(warmupBars, Number(params.warmupBars) || 0));
  return computeIndicators(window, params);
}
