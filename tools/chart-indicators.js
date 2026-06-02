import { config } from "../config.js";
import { log } from "../logger.js";
import { fetchGmgnIndicatorPayload } from "./gmgn-indicators.js";

const DEFAULT_INTERVALS = ["5_MINUTE"];
const DEFAULT_CANDLES = 298;

function getApiBase() {
  return String(config.api.url || "https://api.agentmeridian.xyz/api").replace(/\/+$/, "");
}

function getHeaders() {
  const headers = {};
  if (config.api.publicApiKey) headers["x-api-key"] = config.api.publicApiKey;
  return headers;
}

export function normalizeIntervals(intervals) {
  const list = Array.isArray(intervals) ? intervals : DEFAULT_INTERVALS;
  return list
    .map((value) => String(value || "").trim().toUpperCase())
    .filter((value) => value === "5_MINUTE" || value === "15_MINUTE");
}

function safeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildSignalSummary(payload) {
  const latest = payload?.latest || {};
  const candle = latest?.candle || {};
  const previousCandle = latest?.previousCandle || {};
  const rsi = safeNum(latest?.rsi?.value);
  const bollinger = latest?.bollinger || {};
  const supertrend = latest?.supertrend || {};
  const fibonacciLevels = latest?.fibonacci?.levels || {};
  return {
    close: safeNum(candle.close),
    previousClose: safeNum(previousCandle.close),
    rsi,
    lowerBand: safeNum(bollinger.lower),
    middleBand: safeNum(bollinger.middle),
    upperBand: safeNum(bollinger.upper),
    supertrendValue: safeNum(supertrend.value),
    supertrendDirection: String(supertrend.direction || "unknown"),
    supertrendBreakUp: !!latest?.states?.supertrendBreakUp,
    supertrendBreakDown: !!latest?.states?.supertrendBreakDown,
    fib50: safeNum(fibonacciLevels["0.500"]),
    fib618: safeNum(fibonacciLevels["0.618"]),
    fib786: safeNum(fibonacciLevels["0.786"]),
  };
}

function evaluatePreset(side, preset, payload) {
  const summary = buildSignalSummary(payload);
  const oversold = Number(config.indicators.rsiOversold ?? 30);
  const overbought = Number(config.indicators.rsiOverbought ?? 80);
  const close = summary.close;
  const previousClose = summary.previousClose;
  const lowerBand = summary.lowerBand;
  const upperBand = summary.upperBand;
  const rsi = summary.rsi;
  const isBullish = summary.supertrendDirection === "bullish";
  const isBearish = summary.supertrendDirection === "bearish";
  // Veto entry confirmations whenever close < supertrendValue, regardless of
  // direction or `supertrendBreakUp`. The upstream break flag has been seen
  // sticky from an earlier candle after price already fell back through ST
  // (Stake-SOL 2026-05-25 16:09Z bearish-direction; grail-SOL 2026-05-26
  // 15:18Z non-bearish-direction with stale flag).
  const priceBelowST =
    close != null &&
    summary.supertrendValue != null &&
    close < summary.supertrendValue;
  const crossedUp = (level) =>
    level != null &&
    close != null &&
    previousClose != null &&
    previousClose < level &&
    close >= level;
  const crossedDown = (level) =>
    level != null &&
    close != null &&
    previousClose != null &&
    previousClose > level &&
    close <= level;

  switch (preset) {
    case "supertrend_break":
      if (side === "entry") {
        if (priceBelowST) {
          return {
            confirmed: false,
            reason: `Defensive veto: close ${close} < supertrend ${summary.supertrendValue} (direction=${summary.supertrendDirection}, breakUp=${summary.supertrendBreakUp}) — upstream break flag ignored`,
            signal: summary,
          };
        }
        return {
          confirmed: summary.supertrendBreakUp || (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue),
          reason: summary.supertrendBreakUp ? "Supertrend flipped bullish" : "Price is above bullish Supertrend",
          signal: summary,
        };
      }
      return {
        confirmed: summary.supertrendBreakDown || (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue),
        reason: summary.supertrendBreakDown ? "Supertrend flipped bearish" : "Price is below bearish Supertrend",
        signal: summary,
      };
    case "rsi_reversal":
      return side === "entry"
        ? {
            confirmed: rsi != null && rsi <= oversold,
            reason: `RSI ${rsi ?? "n/a"} <= oversold ${oversold}`,
            signal: summary,
          }
        : {
            confirmed: rsi != null && rsi >= overbought,
            reason: `RSI ${rsi ?? "n/a"} >= overbought ${overbought}`,
            signal: summary,
          };
    case "bollinger_reversion":
      return side === "entry"
        ? {
            confirmed: close != null && lowerBand != null && close <= lowerBand,
            reason: `Close ${close ?? "n/a"} <= lower band ${lowerBand ?? "n/a"}`,
            signal: summary,
          }
        : {
            confirmed: close != null && upperBand != null && close >= upperBand,
            reason: `Close ${close ?? "n/a"} >= upper band ${upperBand ?? "n/a"}`,
            signal: summary,
          };
    case "rsi_plus_supertrend":
      if (side === "entry" && priceBelowST) {
        return {
          confirmed: false,
          reason: `Defensive veto: close ${close} < supertrend ${summary.supertrendValue} (direction=${summary.supertrendDirection}, breakUp=${summary.supertrendBreakUp}) — upstream break flag ignored`,
          signal: summary,
        };
      }
      return side === "entry"
        ? {
            confirmed:
              (rsi != null && rsi <= oversold) &&
              (summary.supertrendBreakUp || isBullish),
            reason: `RSI oversold with bullish Supertrend context`,
            signal: summary,
          }
        : {
            confirmed:
              (rsi != null && rsi >= overbought) &&
              (summary.supertrendBreakDown || isBearish),
            reason: `RSI overbought with bearish Supertrend context`,
            signal: summary,
          };
    case "supertrend_or_rsi":
      return side === "entry"
        ? {
            confirmed:
              summary.supertrendBreakUp ||
              (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue) ||
              (rsi != null && rsi <= oversold),
            reason: "Supertrend bullish confirmation or RSI oversold",
            signal: summary,
          }
        : {
            confirmed:
              summary.supertrendBreakDown ||
              (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue) ||
              (rsi != null && rsi >= overbought),
            reason: "Supertrend bearish confirmation or RSI overbought",
            signal: summary,
          };
    case "bb_plus_rsi":
      return side === "entry"
        ? {
            confirmed:
              close != null &&
              lowerBand != null &&
              close <= lowerBand &&
              rsi != null &&
              rsi <= oversold,
            reason: "Close at/below lower band with RSI oversold",
            signal: summary,
          }
        : {
            confirmed:
              close != null &&
              upperBand != null &&
              close >= upperBand &&
              rsi != null &&
              rsi >= overbought,
            reason: "Close at/above upper band with RSI overbought",
            signal: summary,
          };
    case "fibo_reclaim":
      return side === "entry"
        ? {
            confirmed:
              crossedUp(summary.fib618) ||
              crossedUp(summary.fib50) ||
              crossedUp(summary.fib786),
            reason: "Price reclaimed a key Fibonacci level",
            signal: summary,
          }
        : {
            confirmed:
              crossedUp(summary.fib618) ||
              crossedUp(summary.fib50),
            reason: "Price reclaimed a key Fibonacci level upward",
            signal: summary,
          };
    case "fibo_reject":
      return side === "entry"
        ? {
            confirmed:
              crossedDown(summary.fib618) ||
              crossedDown(summary.fib50),
            reason: "Price rejected from a key Fibonacci level",
            signal: summary,
          }
        : {
            confirmed:
              crossedDown(summary.fib618) ||
              crossedDown(summary.fib50) ||
              crossedDown(summary.fib786),
            reason: "Price rejected below a key Fibonacci level",
            signal: summary,
          };
    default:
      return {
        confirmed: false,
        reason: `Unknown preset ${preset}`,
        signal: summary,
      };
  }
}

// Pure decision for the supertrend_bb_pullback composite entry (no I/O).
// payload5m / payload15m: { latest, recent? } payloads. params is pre-coerced:
//   { lookbackBars:number, dipBand:"lower"|"middle", reclaimBand:"middle"|"lower" }.
// Thesis: 15m supertrend bullish (trend filter) + a 5m pullback to a band within the
// last N closed bars that has reclaimed back above the reclaim band now (timing), with
// the standard close>=supertrend veto. Degrades to a single-bar check when no `recent`
// series is present (meridian fallback). Returns { confirmed, reason, signal5m, signal15m, degraded }.
export function evaluateSupertrendBbPullback(payload5m, payload15m, params) {
  const s5 = buildSignalSummary(payload5m);
  const s15 = buildSignalSummary(payload15m);
  const lookbackBars = Math.max(1, Math.floor(params.lookbackBars) || 8);
  const dipBand = params.dipBand === "middle" ? "middle" : "lower";
  const reclaimBand = params.reclaimBand === "lower" ? "lower" : "middle";
  const base = { signal5m: s5, signal15m: s15, degraded: false };

  // 1. HTF trend filter — 15m supertrend must be bullish.
  if (s15.supertrendDirection !== "bullish") {
    return { ...base, confirmed: false, reason: `15m supertrend ${s15.supertrendDirection} (need bullish)` };
  }
  // 2. Defensive veto — 5m close must be at/above its supertrend.
  if (s5.close != null && s5.supertrendValue != null && s5.close < s5.supertrendValue) {
    return { ...base, confirmed: false, reason: `Veto: 5m close ${s5.close} < supertrend ${s5.supertrendValue}` };
  }
  // 3. Reclaim — latest 5m close back above the reclaim band.
  const reclaimLevel = reclaimBand === "lower" ? s5.lowerBand : s5.middleBand;
  if (s5.close == null || reclaimLevel == null || s5.close < reclaimLevel) {
    return { ...base, confirmed: false, reason: `No reclaim: 5m close ${s5.close} < ${reclaimBand} band ${reclaimLevel}` };
  }
  // 4. Pullback — a dip to the dip band within the lookback window.
  const recent = Array.isArray(payload5m?.recent) ? payload5m.recent : null;
  let dipped = false;
  let degraded = false;
  if (recent && recent.length > 0) {
    const lookbackWindow = recent.slice(-lookbackBars);
    dipped = lookbackWindow.some((bar) => {
      const level = dipBand === "middle" ? bar.bbMiddle : bar.bbLower;
      return level != null && bar.low != null && bar.low <= level;
    });
  } else {
    // Degrade: no series (meridian fallback) → single-bar check on the latest 5m bar.
    degraded = true;
    const dipLevel = dipBand === "middle" ? s5.middleBand : s5.lowerBand;
    const rawLow = payload5m?.latest?.candle?.low;
    const low5 = rawLow != null ? safeNum(rawLow) : s5.close;
    dipped = dipLevel != null && low5 != null && low5 <= dipLevel;
  }
  if (!dipped) {
    return {
      ...base, degraded, confirmed: false,
      reason: degraded
        ? `Degrade: no single-bar pullback to ${dipBand} band`
        : `No pullback to ${dipBand} band in last ${lookbackBars} bars`,
    };
  }
  return {
    ...base, degraded, confirmed: true,
    reason: degraded
      ? "Degraded confirm: 15m bullish + single-bar 5m pullback-reclaim"
      : `15m bullish + 5m pullback to ${dipBand} reclaimed ${reclaimBand} (last ${lookbackBars} bars)`,
  };
}

// Fetch one interval and evaluate a single preset, independent of the global
// `config.indicators.enabled` gate. The caller decides whether to invoke this.
// Returns { confirmed, reason, signal } from evaluatePreset.
export async function evaluateIntervalPreset({ mint, side, preset, interval, refresh = false }) {
  const normalized = normalizeIntervals([interval]);
  const target = normalized[0] || "15_MINUTE";
  const payload = await fetchChartIndicatorsForMint(mint, { interval: target, refresh });
  return evaluatePreset(side, preset, payload);
}

// Source-dispatching entry point. Default "meridian" preserves the existing endpoint
// path exactly. "gmgn" computes from GMGN klines and falls back to meridian on ANY
// failure (rate-limit, network, empty/insufficient data) so worst case == prior behavior.
export async function fetchChartIndicatorsForMint(mint, opts = {}) {
  const source = String(config.gmgn?.indicatorSource || "meridian").toLowerCase();
  if (source === "gmgn") {
    try {
      return await fetchGmgnIndicatorPayload(mint, {
        interval: opts.interval,
        rsiLength: opts.rsiLength ?? config.indicators?.rsiLength ?? 2,
      });
    } catch (error) {
      log("indicators_warn", `GMGN indicator source failed for ${String(mint).slice(0, 8)} ${opts.interval || ""}: ${error.message} — falling back to meridian`);
    }
  }
  return fetchMeridianIndicatorPayload(mint, opts);
}

async function fetchMeridianIndicatorPayload(
  mint,
  {
    interval,
    candles = config.indicators.candles ?? DEFAULT_CANDLES,
    rsiLength = config.indicators.rsiLength ?? 2,
    refresh = false,
  } = {},
) {
  const normalizedInterval = String(interval || "15_MINUTE").trim().toUpperCase();
  const search = new URLSearchParams({
    interval: normalizedInterval,
    candles: String(candles),
    rsiLength: String(rsiLength),
  });
  if (refresh) search.set("refresh", "1");

  const res = await fetch(`${getApiBase()}/chart-indicators/${mint}?${search.toString()}`, {
    headers: getHeaders(),
  });
  const text = await res.text().catch(() => "");
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    throw new Error(payload?.error || `chart indicators ${res.status}`);
  }
  return payload;
}

// Cross-interval confirmation for the supertrend_bb_pullback composite entry. Fetches
// 5m (bands + veto) and 15m (trend filter) payloads and evaluates them together — the
// per-interval loop in confirmIndicatorPreset can't express "different conditions per
// interval". Returns the standard confirmation shape so executor/screener consumers and
// the maxEntryRsi veto keep working unchanged.
async function confirmSupertrendBbPullback({ mint, refresh = false }) {
  const params = {
    lookbackBars: Number(config.indicators.pullbackLookbackBars) || 8,
    dipBand: String(config.indicators.pullbackDipBand || "lower").toLowerCase(),
    reclaimBand: String(config.indicators.pullbackReclaimBand || "middle").toLowerCase(),
  };
  const results = [];
  let p5 = null;
  let p15 = null;
  for (const interval of ["5_MINUTE", "15_MINUTE"]) {
    try {
      const payload = await fetchChartIndicatorsForMint(mint, { interval, refresh });
      if (interval === "5_MINUTE") p5 = payload; else p15 = payload;
      results.push({
        interval, ok: true, confirmed: null, reason: null,
        signal: buildSignalSummary(payload), latest: payload?.latest || null,
      });
    } catch (error) {
      log("indicators_warn", `BB-pullback fetch failed for ${mint.slice(0, 8)} ${interval}: ${error.message}`);
      results.push({ interval, ok: false, confirmed: null, reason: error.message, signal: null, latest: null });
    }
  }

  // Fail open like the generic path: if either interval is missing, mark skipped so the
  // deploy-time check fails closed (executor.js) rather than committing capital blind.
  if (!p5 || !p15) {
    return {
      enabled: true, confirmed: true, skipped: true,
      preset: "supertrend_bb_pullback", side: "entry",
      reason: "Indicator API unavailable; falling back to existing logic",
      intervals: results,
    };
  }

  const evaln = evaluateSupertrendBbPullback(p5, p15, params);
  for (const r of results) {
    if (!r.ok) continue;
    r.confirmed = r.interval === "15_MINUTE"
      ? evaln.signal15m.supertrendDirection === "bullish"
      : evaln.confirmed;
  }
  return {
    enabled: true, confirmed: !!evaln.confirmed, skipped: false,
    preset: "supertrend_bb_pullback", side: "entry",
    reason: evaln.reason, intervals: results,
  };
}

export async function confirmIndicatorPreset({
  mint,
  side,
  preset = side === "entry" ? config.indicators.entryPreset : config.indicators.exitPreset,
  intervals = config.indicators.intervals,
  refresh = false,
} = {}) {
  if (!config.indicators.enabled || !mint || !preset) {
    return { enabled: false, confirmed: true, reason: "Indicators disabled or not configured", intervals: [] };
  }

  if (side === "entry" && preset === "supertrend_bb_pullback") {
    return await confirmSupertrendBbPullback({ mint, refresh });
  }

  const targets = normalizeIntervals(intervals);
  if (targets.length === 0) {
    return { enabled: false, confirmed: true, reason: "No indicator intervals configured", intervals: [] };
  }

  const results = [];
  for (const interval of targets) {
    try {
      const payload = await fetchChartIndicatorsForMint(mint, { interval, refresh });
      const evaluation = evaluatePreset(side, preset, payload);
      results.push({
        interval,
        ok: true,
        confirmed: !!evaluation.confirmed,
        reason: evaluation.reason,
        signal: evaluation.signal,
        latest: payload?.latest || null,
      });
    } catch (error) {
      log("indicators_warn", `Indicator fetch failed for ${mint.slice(0, 8)} ${interval}: ${error.message}`);
      results.push({
        interval,
        ok: false,
        confirmed: null,
        reason: error.message,
        signal: null,
        latest: null,
      });
    }
  }

  const successful = results.filter((entry) => entry.ok);
  if (successful.length === 0) {
    return {
      enabled: true,
      confirmed: true,
      skipped: true,
      preset,
      side,
      reason: "Indicator API unavailable; falling back to existing logic",
      intervals: results,
    };
  }

  const requireAll = !!config.indicators.requireAllIntervals;
  const confirmed = requireAll
    ? successful.every((entry) => entry.confirmed)
    : successful.some((entry) => entry.confirmed);

  return {
    enabled: true,
    confirmed,
    skipped: false,
    preset,
    side,
    requireAllIntervals: requireAll,
    reason: confirmed
      ? `${preset} confirmed on ${successful.filter((entry) => entry.confirmed).map((entry) => entry.interval).join(", ")}`
      : `${preset} not confirmed on ${successful.map((entry) => entry.interval).join(", ")}`,
    intervals: results,
  };
}
