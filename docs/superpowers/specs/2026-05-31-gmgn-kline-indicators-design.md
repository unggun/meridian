# GMGN Kline Indicators — Design

**Date:** 2026-05-31
**Status:** Approved for implementation planning
**Author:** Meridian + Claude

## Problem

Chart indicators (supertrend / RSI / Bollinger) are currently sourced exclusively
from the Meridian endpoint `api.agentmeridian.xyz/api/chart-indicators/<mint>`, which
returns **precomputed** indicator values. We want the option to compute indicators
from **GMGN real-time klines** instead (the "option B" investigated in the
`gmgn-kline-indicators-option-b` memory note), because GMGN's latest candle updates
live (fresher than the cached Meridian feed), while keeping the existing endpoint as
a safe, default fallback.

Secondarily, the GMGN screening cycle makes two sequential pool-discovery round-trips
per candidate (one at the screening timeframe in `pickBestPool`, one at `24h` in the
fee/TVL gate). Consolidating these removes one sequential round-trip per candidate —
worthwhile given the real per-process throttle is `requestDelayMs: 2500`.

## Goals

- Add a GMGN-kline indicator source behind a config switch that **defaults to today's
  behavior** (Meridian endpoint).
- On **any** GMGN failure, transparently fall back to the Meridian endpoint
  (user-selected behavior). Worst case == current behavior.
- Keep all existing indicator consumers unchanged by preserving the payload shape.
- Validate decision-level parity (not numeric exactness) before trusting the switch.
- Consolidate the GMGN path's two pool-discovery fetches (the "#3" efficiency win).

## Non-Goals

- Numeric byte-for-byte parity with the Meridian endpoint. Impossible by construction:
  the two sources compute from different underlying candle data. We target
  **decision-level** agreement (direction, threshold crossings, zone).
- Exact Fibonacci-level parity. Computed best-effort, flagged approximate, excluded
  from pass/fail. The `fibo_*` presets are not in active use.
- Touching the Meteora screening source's indicator/24h logic beyond letting the 24h
  gate skip a re-fetch when the value is already stamped.
- Persisting klines to disk. All kline caching is in-memory and TTL-bounded.

## Architecture

### The indicator seam

The single chokepoint is `fetchChartIndicatorsForMint(mint, {interval, ...})` in
`tools/chart-indicators.js:248`. Every consumer
(`confirmIndicatorPreset`, `evaluateIntervalPreset`, and the screener's
`checkBounceSetup` via `fetchChartIndicatorsForMint`) reads
`payload.latest.{supertrend, rsi, bollinger, fibonacci, states, candle}` from it.

We introduce a **provider switch inside the seam**. Consumers are blind to the source.

```
fetchChartIndicatorsForMint(mint, opts)          [public, signature UNCHANGED]
   │
   ├─ config.gmgn.indicatorSource === "meridian" (default)
   │     └─ fetchMeridianIndicatorPayload(mint, opts)   [renamed existing body, UNTOUCHED logic]
   │
   └─ config.gmgn.indicatorSource === "gmgn"
         └─ try fetchGmgnIndicatorPayload(mint, opts)
            catch → fetchMeridianIndicatorPayload(mint, opts)   [auto-fallback]
            returns identical { latest: {...} } shape
```

- The current body of `fetchChartIndicatorsForMint` is renamed to a private
  `fetchMeridianIndicatorPayload` with identical logic.
- `fetchChartIndicatorsForMint` becomes the thin dispatcher above.
- Auto-fallback wraps the GMGN attempt in try/catch; any throw (rate-limit, network,
  empty/insufficient data treated as an error inside the GMGN module) routes to
  Meridian. A fallback event is logged so a cycle silently mixing sources is visible.

### New module: `tools/gmgn-indicators.js`

Standalone, mostly-pure, unit-testable. Responsibilities:

```
fetchGmgnKlines(mint, resolution, limit)  → raw OHLCV[]   (only network part)
   └─ reuses gmgnFetch + paceGmgnRequest from gmgn.js (shares the single throttle)
   └─ endpoint: GET /v1/market/token_kline  (chain=sol, address, resolution, limit)
   └─ response: data.list[] of {time(ms), open, high, low, close, volume, amount, source}
   └─ prices are USD strings → Number() them

resampleKlines(klines1m, targetMinutes)   → OHLCV[]       (pure)
   └─ buckets 1m candles into 5m / 15m: open=first, close=last, high=max, low=min, vol=sum

computeIndicators(ohlcv[], params)         → { latest }    (pure)
   ├─ supertrend(atrPeriod, multiplier) → { value, direction }, states.supertrendBreakUp/Down
   ├─ rsi(Wilder smoothing, length=2)   → { value }
   ├─ bollinger(period=20, stdDev=2)    → { upper, middle, lower }
   ├─ fibonacci(swing over fibLookbackBars) → { levels } [best-effort, approximate]
   └─ assembles latest.{candle, previousCandle, rsi, bollinger, supertrend, states, fibonacci}

fetchGmgnIndicatorPayload(mint, { interval, candles, rsiLength })  → { latest }
   └─ map "5_MINUTE"/"15_MINUTE" → minutes
   └─ fetchGmgnKlines(mint, "1m", 300)   [via per-mint per-cycle cache]
   └─ resampleKlines → computeIndicators → { latest: {...} }
```

**Efficiency: fetch 1m once, resample to both intervals.** Because the throttle is
2,500ms/call, we fetch **1m klines once per mint** (`limit=300`, enough for the 298
warmup) and resample locally to 5m and 15m. One GMGN call covers both intervals
instead of two.

**Per-cycle 1m cache.** `checkBounceSetup` calls the seam once for 5m and once for
15m for the same mint moments apart. An in-memory `Map<mint, {klines, ts}>` with a
short TTL (`klineCacheTtlSec`, default 30) lets the second call reuse the first
fetch, so a candidate evaluated on both intervals costs **one** GMGN call total.
In-memory only, TTL-bounded, no disk.

### Payload shape contract

`fetchGmgnIndicatorPayload` MUST return the same shape both consumers read. Reference
fields (from `chart-indicators.js` `buildSignalSummary` and `gmgn.js`
`evaluateBouncePayload`):

```
latest: {
  candle: { open, high, low, close },
  previousCandle: { close },
  rsi: { value },
  bollinger: { upper, middle, lower },
  supertrend: { value, direction },        // direction: "bullish" | "bearish"
  states: { supertrendBreakUp, supertrendBreakDown },
  fibonacci: { levels: { "0.500", "0.618", "0.786", ... } },  // best-effort
}
```

## Configuration

All new keys live in `gmgn-config.json` (already loaded into `config.gmgn` via
`gmgnUserConfig`, config.js:20). All default to today's behavior.

```jsonc
{
  // ... existing gmgn-config.json ...

  // NEW: indicator candle source. "meridian" (default) = existing endpoint, untouched.
  // "gmgn" = compute from GMGN klines, auto-falling back to meridian on any failure.
  "indicatorSource": "meridian",

  // NEW (optional): indicator math params. Omit to use reverse-fitted baked-in defaults.
  "indicatorParams": {
    "supertrendPeriod": 10,
    "supertrendMultiplier": 3,
    "bollingerPeriod": 20,
    "bollingerStdDev": 2,
    "fibLookbackBars": 55,
    "klineCacheTtlSec": 30
  }
}
```

Wiring in `config.js` (alongside existing gmgn keys, ~line 157):

```js
indicatorSource: gmgnValue("indicatorSource", "gmgnIndicatorSource", "meridian"),
indicatorParams: { ...BAKED_IN_INDICATOR_PARAMS, ...(gmgnUserConfig.indicatorParams || {}) },
```

- `gmgnValue()` precedence: `gmgn-config.json` → legacy `user-config.json` key → default.
- The switch can be flipped by editing `gmgn-config.json` **or** via
  `/setcfg gmgnIndicatorSource gmgn` (legacy-key path), which persists.
- RSI length (2) and candle count (298) keep coming from existing
  `config.indicators` / `config.gmgn` values so both sources stay consistent.
- **Fallback / safety switch:** set `"indicatorSource": "meridian"` (or delete the key).
  Instant, no code change.

**Legacy keys:** existing `klineResolution` and `klineLookbackMinutes` in
`gmgn-config.json` become irrelevant to this path (we always fetch 1m/limit=300).
They are left in place as dead/legacy keys rather than removed.

**Placement rationale:** `indicatorSource` lives in the gmgn block because it governs
"use GMGN klines" globally and keeps all kline config in one file. The management exit
check (`confirmIndicatorPreset`) reads the gmgn-namespaced toggle; this is acceptable
since the toggle is a global source selector. (Approved.)

## Parity Validation

Standalone dev tool `scripts/validate-gmgn-indicators.js` (not wired into the agent).

```
for each mint in sample (pulled from a live screen, or passed as args):
   meridian = fetchMeridianIndicatorPayload(mint, 5m & 15m)
   gmgn     = fetchGmgnIndicatorPayload(mint, 5m & 15m)
   compare latest.* on the decisions gate logic actually uses:
      - supertrend.direction (bullish/bearish agree?)
      - states.supertrendBreakUp / supertrendBreakDown
      - close >= supertrend.value  (the requireAboveSupertrend gate)
      - RSI zone (oversold / neutral / overbought via configured thresholds)
      - BB position (above / inside / below)
   report: per-signal agreement %, plus numeric deltas for context
```

- **Acceptance target:** direction + above/below-supertrend + BB-position agree on the
  large majority of sampled tokens (the signals `indicatorRules` actually use). RSI-zone
  agreement is secondary (rules have `minRsi`/`maxRsi: null`).
- Doubles as the **reverse-fit harness**: adjust baked-in `indicatorParams` while
  maximizing agreement, then lock as defaults.
- Numeric exactness explicitly NOT required (different underlying candles).
- Fib reported for context, excluded from pass/fail.
- Re-runnable as a **drift canary**.

## Efficiency: pickBestPool + 24h fee/TVL consolidation (the "#3" win)

GMGN source only. Today:

- `pickBestPool` (gmgn.js:355) fetches pool-discovery detail at the screening
  timeframe in Stage 5.
- `getTopCandidates` (screening.js:649) fetches pool-discovery detail again at `24h`
  for the same pools in a later phase.

Two sequential round-trips to the same API per pool. The API returns one timeframe per
request (cannot merge into one HTTP call), but they can fire **concurrently**.

**Change:**

1. In `pickBestPool`, when fetching the chosen pool's detail, also fetch `timeframe=24h`
   in the same `Promise.all`, and stamp `fee_tvl_ratio_24h` onto the candidate.
2. The `getTopCandidates` 24h gate **reads the already-stamped value** when present,
   and keeps its existing per-candidate fetch only as a fallback for candidates lacking
   the stamp (i.e. the unchanged Meteora source path).

Net: the 24h number rides along with the detail fetch already happening, removing one
sequential round-trip per candidate from the GMGN cycle. Meteora path unchanged.

**Scope guard:** only the GMGN source is optimized. The Meteora 24h gate is untouched
beyond skipping the re-fetch when the value is already present.

## Testing

- **Unit (pure functions):** `resampleKlines` (bucket boundaries, partial buckets),
  `computeIndicators` (supertrend direction flips, RSI Wilder, BB bands) against fixed
  OHLCV fixtures with known expected outputs.
- **Shape contract:** `fetchGmgnIndicatorPayload` output has every field
  `buildSignalSummary` and `evaluateBouncePayload` read.
- **Fallback:** simulate a GMGN throw → assert seam returns the Meridian payload and
  logs the fallback.
- **Parity script:** decision-level agreement on a live sample (manual, pre-flip).
- **Cache:** two seam calls (5m then 15m) for one mint within TTL → one
  `fetchGmgnKlines` call.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| JS indicators diverge from upstream and flip gate decisions | Parity script + reverse-fit before flipping; default stays meridian |
| Added GMGN call volume worsens the 2,500ms-throttled cycle | 1 fetch per mint (1m→resample), per-cycle cache, GMGN only for candidates already in the pipeline |
| Silent source mixing on fallback | Log every fallback event |
| Empty kline response treated as success (athfilter-silent-bypass pattern) | Treat empty/insufficient `list` as an error inside the GMGN module → triggers fallback, never silently passes |
| Disk growth | In-memory TTL cache only; no kline persistence |

## Files Touched

- `tools/chart-indicators.js` — rename body to `fetchMeridianIndicatorPayload`; add
  dispatcher + fallback in `fetchChartIndicatorsForMint`.
- `tools/gmgn-indicators.js` — NEW module (fetch / resample / compute / payload + cache).
- `tools/gmgn.js` — export `gmgnFetch`/`paceGmgnRequest` for reuse (or extract to a shared
  helper); `pickBestPool` concurrent 24h fetch + stamp.
- `tools/screening.js` — 24h gate reads stamped value, fetch only as fallback.
- `config.js` — `indicatorSource` + `indicatorParams` wiring.
- `gmgn-config.json` — new keys (defaults preserve current behavior).
- `scripts/validate-gmgn-indicators.js` — NEW dev/validation tool.
- `CLAUDE.md` — document the indicator source switch.
