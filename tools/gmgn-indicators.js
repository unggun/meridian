// Compute chart indicators from GMGN klines, matching the payload shape that
// tools/chart-indicators.js consumers expect. Pure functions + one cached fetch.

// Bucket ascending-by-time 1-minute OHLCV candles into N-minute candles.
// Bucketing is by index (every `targetMinutes` candles), assuming contiguous 1m data.
// A trailing partial bucket (the in-progress candle window) is kept so the latest
// value reflects current price action.
export function resampleKlines(klines1m, targetMinutes) {
  if (!Array.isArray(klines1m) || klines1m.length === 0) return [];
  const size = Math.max(1, Math.floor(targetMinutes));
  const out = [];
  for (let i = 0; i < klines1m.length; i += size) {
    const bucket = klines1m.slice(i, i + size);
    if (bucket.length === 0) continue;
    out.push({
      time: bucket[0].time,
      open: bucket[0].open,
      close: bucket[bucket.length - 1].close,
      high: Math.max(...bucket.map((k) => k.high)),
      low: Math.min(...bucket.map((k) => k.low)),
      volume: bucket.reduce((sum, k) => sum + (Number(k.volume) || 0), 0),
    });
  }
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
  let direction = "bullish"; // 1 = bullish (uptrend), tracked as string at the end
  let dirNum = 1;
  let prevDirNum = 1;
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
