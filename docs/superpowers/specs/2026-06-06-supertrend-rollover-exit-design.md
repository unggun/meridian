# Supertrend Rollover Exit — Design

**Date:** 2026-06-06
**Status:** Approved (brainstorm), pending implementation plan
**Topic:** Add three blow-off / trend-rollover exit strategies, combined under one toggleable preset.

---

## Goal

Add three new exit conditions to the agent, all sharing a **15m supertrend bearish** trend
filter and each triggering on a *blow-off top / trend rollover* signal on the **previous
closed 15m bar**:

1. **RSI exit** — `supertrend bearish 15m` AND the previous closed candle's RSI (length 2)
   closed **above 90**.
2. **MACD exit** — `supertrend bearish 15m` AND the previous closed candle is the **first
   green histogram** (its MACD histogram > 0 while the bar before it was ≤ 0).
3. **Bollinger exit** — `supertrend bearish 15m` AND the previous closed candle **closed
   above the upper Bollinger band**.

**Intent (confirmed with user):** catch a *trend rollover / blow-off top* and exit
**regardless of PnL** — not the underwater-only "sell into a relief bounce" case. All three
triggers are evaluated **on the 15m interval**, so no cross-interval composite is required.

**Behavior:** the three sub-triggers are OR'd — *any* enabled trigger firing (with the shared
15m-supertrend-bearish gate satisfied) confirms the exit. Each sub-trigger is individually
toggleable via config.

---

## Why the existing structure mostly fits

Exit strategies are already a first-class concept: a named **preset** evaluated by
`evaluatePreset(side, preset, payload)` in `tools/chart-indicators.js`, selected via
`config.indicators.exitPreset`, and consumed by the management cron. The cron already:

- evaluates exit presets every cycle (`index.js`),
- has a **PnL-independent** evaluation path (`supertrendExitEnabled` block, `index.js:335`)
  that runs a preset on 15m across **all** positions, and
- routes confirmed exits through a **2-cycle debounce** (`confirmChartExitDebounce`,
  `index.js:375`) so a single flaky read can't cut a position.

The cross-interval composite pattern already exists too (`confirmSupertrendBbExtension` /
`evaluateSupertrendBbExtension`, `chart-indicators.js`) — the new preset follows it, minus
the second interval (everything is 15m here).

### Gaps this design fills

1. **MACD does not exist.** The engine computes supertrend, RSI, Bollinger, Fibonacci only.
   MACD + a histogram **series** (for first-green detection) must be added.
2. **Previous-bar values aren't exposed.** The payload carries the latest closed bar's RSI
   and the previous bar's *close* only — not the previous bar's RSI or any MACD value. All
   three triggers read the **previous** closed bar.
3. **`config.indicators.exitPreset` is a single string** — only one exit preset is active at
   a time. The three triggers are folded into **one** combined preset so they can fire
   simultaneously (Approach A).

---

## Architecture

### 1. Indicator engine — `tools/gmgn-indicators.js`

Compute series once over the full anchored window (correct EMA/Wilder seeding), then attach
per-bar values to the existing `recent` array — the same mechanism the BB-extension entry
relies on.

- **`computeMacd(closes, { fast, slow, signal })`** — returns the MACD histogram **series**
  aligned to candles (plus latest `{ macd, signal, histogram }`). New params
  `macdFast=12`, `macdSlow=26`, `macdSignal=9` in `DEFAULT_INDICATOR_PARAMS`.
- **`computeRsiSeries(closes, length)`** — rolling Wilder RSI aligned to candles, reusing the
  existing `rsiLength` (=2), so any bar's RSI is available (not just the latest).
- **Enrich the `recent` series** (`buildRecentSeries`): each bar gains `rsi` and `macdHist`
  alongside the existing `close`/`high`/`low`/`bbLower`/`bbMiddle`/`bbUpper`. Also expose
  `latest.macd = { macd, signal, histogram }` for observability/logging.

Warmup: MACD(12/26/9) needs ~35 bars. 15m has enough on both the 1m→15m resample
(~66 closed bars) and the native path (~137), so **no fetch changes** are required.

### 2. Evaluator — `tools/chart-indicators.js`

New pure function `evaluateSupertrendRollover(payload, params)` mirroring
`evaluateSupertrendBbExtension`:

- **Shared gate:** `payload` 15m supertrend direction must be `bearish`; otherwise
  `{ confirmed: false }`.
- **OR of enabled sub-triggers, reading the previous closed bar (`recent[-2]`):**
  - `rsiExit`  → `prev.rsi > rolloverRsiUpper` (default 90)
  - `bbExit`   → `prev.close > prev.bbUpper`
  - `macdExit` → first green histogram on prev bar: `prev.macdHist > 0 && recent[-3].macdHist <= 0`
- **Params** (pre-coerced by the caller): `{ rsiEnabled, macdEnabled, bbEnabled, rsiUpper }`.
- **Degrade:** if no `recent` series is present (meridian fallback) the series-based triggers
  can't be evaluated → return `{ skipped: true }`. For an exit this means **no close** — the
  cron requires `confirmed && !skipped` (`index.js:320`), so missing data never forces an
  exit (fail-safe).
- **Return shape:** `{ confirmed, reason, signal, degraded/skipped }` — matching the existing
  composite so cron/executor consumers work unchanged. `reason` names which sub-trigger(s)
  fired.

Routing: `confirmIndicatorPreset` special-cases `supertrend_rollover_exit` (like
`supertrend_bb_extension`) — it performs its own single 15m fetch via
`fetchChartIndicatorsForMint` and bypasses the per-interval `intervals`/`requireAllIntervals`
loop.

### 3. Wiring — `index.js`

Add a **PnL-independent** management block modeled on the existing `supertrendExitEnabled`
block (`index.js:335`), gated by `config.indicators.rolloverExitEnabled`:

- Candidates = all positions with a `base_mint`, not already in `exitMap` /
  `indicatorExitMap`.
- For each, `confirmIndicatorPreset({ mint, side: "exit", preset: "supertrend_rollover_exit",
  refresh: true })`.
- On `confirmed && !skipped`, write the reason into `indicatorExitMap`.

This reuses the existing **2-cycle debounce → CLOSE (`rule: chart_exit`)** path unchanged.

**Debounce decision (signed off):** trigger reads the *previous* closed bar **and** the
2-cycle debounce stays in place. Deliberately conservative/laggy (worst case ~2 bars + 2
cycles) in exchange for robustness against single-read artifacts. Not skipping the debounce
for this path.

### 4. Config — `config.js` (+ `gmgn-config.json` for MACD math)

New keys under `config.indicators`:

| Key | Default | Purpose |
|-----|---------|---------|
| `rolloverExitEnabled` | `false` | Master toggle for the PnL-independent rollover-exit block |
| `rolloverRsi` | `true` | Enable the RSI sub-trigger |
| `rolloverMacd` | `true` | Enable the MACD first-green-histogram sub-trigger |
| `rolloverBb` | `true` | Enable the upper-band-close sub-trigger |
| `rolloverRsiUpper` | `90` | RSI upper limit for the RSI sub-trigger |

A dedicated `rolloverRsiUpper` (90) avoids clobbering the existing `rsiOverbought` (80) used
by other presets. MACD math params (`macdFast/macdSlow/macdSignal`) live in `gmgn-config.json`
under `indicatorParams` (baked defaults in `DEFAULT_INDICATOR_PARAMS`).

Also: register the new keys with `/setcfg` validation / `update_config` key mapping, and add
them to the config-key table in `CLAUDE.md`.

### 5. Tests

- **`tools/gmgn-indicators.test.js`:** `computeMacd` against a known series; RSI/MACD series
  alignment to candles; `recent` carries `rsi` + `macdHist`; first-green detection fixture
  (`hist[-2] > 0 && hist[-3] <= 0`).
- **`tools/chart-indicators.test.js`:** each sub-trigger fires **only** when 15m supertrend is
  bearish; bullish supertrend vetoes all three; each toggle gates its trigger; previous-bar
  (not latest-bar) semantics verified; degrade with no `recent` series → `skipped` (no exit).

---

## Out of scope (YAGNI)

- A general multi-preset selector / exit-rules registry (Approach C) — rejected as a refactor
  that diverges from the established preset pattern.
- Running these triggers on intervals other than 15m, or as a cross-interval composite.
- Changing the existing underwater-only chart-exit harness or the `supertrendExitEnabled`
  path.

---

## Open questions

None outstanding. Polarity (trend rollover, regardless of PnL), interval (all 15m),
combine-mode (OR of toggleable sub-triggers), and the debounce behavior are all confirmed.
