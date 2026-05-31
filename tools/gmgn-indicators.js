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
