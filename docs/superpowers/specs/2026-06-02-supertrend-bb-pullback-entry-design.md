# Supertrend + BB Pullback Entry — Design

**Date:** 2026-06-02
**Status:** Approved for implementation planning
**Author:** Meridian + Claude

## Problem

The entry gate currently supports a single `config.indicators.entryPreset` evaluated
across a list of intervals (`confirmIndicatorPreset` → `evaluatePreset`, combined with
AND/OR via `requireAllIntervals`). The active entry thesis (`supertrend_break`) is a
trend-following breakout: it enters whenever the supertrend is bullish / flips up. For
an LP position that is poor *timing* — we deploy into strength, near a local high,
maximizing immediate impermanent loss.

We want a "buy-the-dip-in-an-uptrend" entry: use the supertrend as a **trend filter**
and a Bollinger-band **pullback** as the entry *timing*, so we deploy near a local low
in a confirmed uptrend (less immediate IL, capture the resume leg).

This also resolves an open question about the existing 15m supertrend requirement:
rather than keep it as a standalone gate or drop it, we **repurpose it as the
higher-timeframe trend filter** inside the new composite.

### The staleness constraint (why this isn't a one-bar check)

Indicators evaluate on the **last *closed* 5m bar** (`dropInProgress: true`,
clock-aligned buckets). A given 5m bar is the "latest closed bar" for only ~5 minutes.
The entry gate runs inside the screener, whose cadence (`screeningIntervalMin`) defaults
to **30 min**. A strict single-bar pullback condition (`close ≤ lowerBand` on the latest
bar) is therefore visible to the screener only ~1 in 6 windows — missed roughly 5 times
out of 6. The pullback must instead be a **durable state** that persists across the
resume leg, so a 30-min sample reliably catches it.

## Goals

- Add a new selectable entry preset `supertrend_bb_pullback` (composite, cross-interval).
- Confirm entry when: **15m supertrend bullish** AND **5m pullback-and-reclaim within
  the last N closed 5m bars** AND latest 5m **close ≥ supertrend value** (defensive veto).
- Make the pullback a durable, lookback-based state (survives the 30-min screen cadence).
- Keep all existing presets, the exit side, and current behavior untouched. The new
  preset is opt-in by setting `entryPreset`.
- Make strategy parameters (lookback N, dip band, reclaim band) config-driven and
  live-tunable via `/setcfg`.
- Faithful path uses the GMGN-computed `recent` series; degrade gracefully when only
  the meridian `latest`-only payload is available.

## Non-Goals

- Multi-strategy "OR" entry (several independent entry triggers active at once). The
  chosen thesis is a single composite; old presets remain selectable but only one entry
  preset is active at a time.
- Catching the exact tick of the local low. The thesis is "uptrend that recently dipped
  and is now resuming," not precise bottom-picking.
- A source restriction. The gate is source-agnostic (applies to both `gmgn` and
  `meteora` screening) by construction — no per-source guard is added.
- Touching the exit side (`supertrendExitEnabled` / `supertrendExitInterval` /
  `exitPreset`) at all.

## Design

### 1. New preset, not a new subsystem

Add `supertrend_bb_pullback` as a value for `config.indicators.entryPreset` and a button
in the settings UI (alongside `supertrend_break`, `supertrend_or_rsi`). No multi-strategy
machinery. Switching to it is the only activation step (plus `indicators.enabled: true`).

### 2. Entry condition (cross-interval)

A candidate confirms when **all** hold:

1. **15m supertrend bullish** — `latest.supertrend.direction === "bullish"` on `15_MINUTE`
   (HTF trend filter; this is the repurposed 15m supertrend).
2. **5m pullback within last N closed bars** — some bar in the last N closed 5m bars had
   `low ≤ bbLower` (dip band configurable: lower or middle).
3. **5m reclaim now** — latest 5m `close ≥ bbMiddle` (reclaim band configurable).
4. **Defensive veto** — latest 5m `close ≥ supertrendValue` (retained from existing
   `supertrend_break`; guards against a sticky upstream break flag after price fell back
   through ST).

Bearish 15m supertrend, dip-without-reclaim, or veto failure → reject.

### 3. Cross-interval evaluator

The existing `confirmIndicatorPreset` loop evaluates **one** preset across an interval
list and AND/ORs the results — it cannot express "supertrend on 15m AND bands on 5m."
So the composite gets a **dedicated async evaluator** (mirroring `evaluateIntervalPreset`)
that performs **two fetches** (5m + 15m) and combines them. `confirmIndicatorPreset`
**branches** to this evaluator when `preset === "supertrend_bb_pullback"`, bypassing the
per-interval AND/OR loop; all other presets keep the current path unchanged.

### 4. Payload extension (the durable-lookback enabler)

`computeIndicators` (tools/gmgn-indicators.js) currently returns only `latest`. Extend it
to also return a `recent` series: the last N closed bars, each as
`{ close, low, bbLower, bbMiddle }`. `computeIndicators` already iterates a window to
compute Bollinger, so this is a localized addition. `N` is bounded by the warmup window
already fetched.

The `recent` series is what makes the pullback a durable state rather than a one-bar
event.

### 5. Degrade path

The `recent` series exists only on the **GMGN** path. The `meridian` fallback
(api.agentmeridian.xyz) returns `latest` only, and is reached solely on GMGN failure
(rate-limit / network / empty). When the series is unavailable:

- **Degrade to a single-bar check** on `latest`: `low ≤ bbLower` AND `close ≥ bbMiddle`
  AND 15m supertrend bullish AND veto. If it doesn't confirm, **wait** for the next
  cycle (no deploy). This matches the user-chosen "fall back to single bar, wait."

For the current config (`indicatorSource: "gmgn"`), the faithful lookback is the normal
path; the degrade only triggers on a GMGN outage.

### 6. Configuration

New keys under `config.indicators` (defaults in config.js; live-tunable via `/setcfg`):

| Key | Meaning | Default |
|-----|---------|---------|
| `pullbackLookbackBars` | N closed 5m bars scanned for the dip | 8 |
| `pullbackDipBand` | which band the dip must reach: `"lower"` or `"middle"` | `"lower"` |
| `pullbackReclaimBand` | which band the latest close must reclaim: `"middle"` or `"lower"` | `"middle"` |

The composite reads the supertrend filter on `15_MINUTE` and the bands on `5_MINUTE`
internally; it does **not** rely on `config.indicators.intervals` / `requireAllIntervals`
(those continue to govern the other presets).

### 7. Cadence coupling (operational note)

For the durable window to survive sampling, `N × 5min` must exceed the screening interval
plus one bar. With `screeningIntervalMin = 30`, use **N = 8** (40 min window). If the
user later drops `screeningIntervalMin` to 15, **N = 6** suffices. This is a tuning
relationship, documented for the operator — not enforced in code.

### 8. Source-agnostic application

The entry gate lives in `getTopCandidates()` (screening.js:819) **after** the
source dispatch; both `gmgn` and `meteora` discovery paths converge into the same
`eligible` array, and the gate keys only on `pool.base.mint`. The new preset therefore
applies to **both** screening sources with no additional code.

## Data Flow

```
screener cycle (every screeningIntervalMin)
  getTopCandidates(source)
    discover pools (gmgn | meteora) → eligible[]
    if indicators.enabled:
      for each candidate:
        confirmIndicatorPreset(side:entry)
          preset == supertrend_bb_pullback ?
            evaluateSupertrendBbPullback(mint):
              fetch 15m payload → supertrend.direction bullish?
              fetch 5m payload  → recent[] available?
                yes → dip in last N bars AND latest reclaim AND veto
                no  → single-bar dip+reclaim AND veto (degrade)
          else → existing per-interval loop
    drop rejected candidates
  → deploy survivors (deploy-time entry freshness re-check, executor.js:879, unchanged)
```

## Error Handling

- GMGN fetch failure on either interval → meridian fallback for that interval → degrade
  path applies. No deploy without a confirmed entry signal (wait next cycle).
- Missing/NaN bands or supertrend value → treat condition as not met (reject), consistent
  with existing `safeNum` guarding in `buildSignalSummary`.
- Insufficient bars for the `recent` series (fewer than N closed bars) → use as many as
  available; if fewer than 2, the existing `computeIndicators` "insufficient kline data"
  throw drives the degrade path.

## Testing

Unit tests for the new evaluator with synthetic payloads:

- bullish 15m + valid 5m pullback-and-reclaim in window → **confirm**
- 5m dip present but no reclaim (latest close still below reclaim band) → **reject**
- valid 5m pullback-reclaim but 15m supertrend bearish → **reject**
- veto: latest 5m close < supertrend value → **reject** (even if bands satisfied)
- degrade path: `recent` absent → single-bar check exercised (confirm + reject cases)
- lookback boundary: dip on the oldest in-window bar → confirm; dip just outside window
  → reject

Plus a `computeIndicators` test asserting the `recent` series shape/length.

## Open Questions

None outstanding. (Source data = GMGN with meridian fallback; rule applies to both
screening sources; fork = Option 1 with single-bar degrade — all confirmed.)
