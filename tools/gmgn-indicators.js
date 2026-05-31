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
