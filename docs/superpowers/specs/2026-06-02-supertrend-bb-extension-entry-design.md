# Supertrend + BB Extension Entry — Design (supersedes the pullback entry)

**Date:** 2026-06-02
**Status:** Approved for implementation
**Author:** Meridian + Claude

## Why this supersedes `supertrend_bb_pullback`

The previously shipped `supertrend_bb_pullback` preset entered on a **lower-band dip +
reclaim** (near a local low). That used a *trader's* "buy low" framing, which is the
**wrong polarity** for how this agent actually provides liquidity.

This agent deploys **single-sided SOL, `bins_below` only, with the active bin as the TOP
of the range** (`tools/dlmm.js`: `amount_x=0`, `bins_above=0` enforced). Consequences:

- At deploy, price sits at the **top edge** of the position. SOL fills bins *below* price.
- The position earns fees + accumulates the base token **only as price trades DOWN
  through the bins**.
- Any **upward** move puts the position **out of range → 100% SOL, zero fees**.

Therefore the correct deploy timing is when price is **elevated (upper band) and about to
pull back DOWN into the below-price liquidity** — the bid-ask / DCA-in mechanic. The
lower-band-reclaim entry got the worst of both: in the bullish case price rises away from
the bins (no fees), in the bearish case it still takes IL.

## Goals

- Replace `supertrend_bb_pullback` with `supertrend_bb_extension` (rename + invert logic).
- Confirm a deploy when: **15m supertrend bullish** (trend filter, so the post-pullback
  recovery is likely) AND price **tagged the upper 5m Bollinger band within the last N
  closed bars AND the latest close is still above the middle band** (still elevated, the
  pullback hasn't already completed) AND the `close ≥ 5m supertrend` veto holds.
- Reuse all existing infrastructure: the `recent` series, cross-interval wrapper, the
  standard confirmation shape, fail-closed-on-outage, config-driven + `/setcfg` tunable.

## Non-Goals

- Keeping the pullback preset (explicitly replaced).
- A blow-off-top upper guard. Residual risk (price tags the upper band then dumps and
  never recovers → IL) is mitigated by the 15m trend filter + the `close ≥ supertrend`
  veto, not eliminated. The (now-fixed) `maxEntryRsi` ceiling can be re-enabled as an
  optional overbought guard if desired.
- Touching exit-side logic.

## Design

### 1. Entry condition (cross-interval)

Confirm when **all** hold:

1. **15m supertrend bullish** — `latest.supertrend.direction === "bullish"` on 15m.
2. **Upper-band tag within window** — some bar in the last `extensionLookbackBars` closed
   5m bars has `high ≥ bbUpper` (tag band configurable via `extensionTagBand`).
3. **Still elevated** — latest 5m `close ≥ bbMiddle` (floor band configurable via
   `extensionFloorBand`; "middle" default, "lower" allowed).
4. **Veto** — latest 5m `close ≥ supertrendValue`.

Bearish 15m, no recent upper-band tag, price already fallen below the floor band, or veto
failure → reject.

### 2. Recent series extension

`buildRecentSeries` / `computeIndicators` (tools/gmgn-indicators.js) must also emit
per-bar `high` and `bbUpper` (it currently emits `close, low, bbLower, bbMiddle`). New
shape per bar: `{ close, high, low, bbLower, bbMiddle, bbUpper }`. `computeBollinger`
already returns `upper`.

### 3. Evaluator + wrapper + routing (tools/chart-indicators.js)

- Rename `evaluateSupertrendBbPullback` → `evaluateSupertrendBbExtension`, invert the
  band logic per §1. Degrade path (no `recent` series, meridian fallback) → single-bar
  check: latest `high ≥ bbUpper` AND `close ≥ bbMiddle` AND veto AND 15m bullish.
- Rename `confirmSupertrendBbPullback` → `confirmSupertrendBbExtension`; read the new
  config keys (coerced). Return shape unchanged (`enabled/confirmed/skipped/preset/side/
  reason/intervals[]` with `intervals[].signal.rsi`). Fail-open→skipped on missing payloads.
- Routing branch: `side === "entry" && preset === "supertrend_bb_extension"`.

### 4. Config (config.js + executor.js CONFIG_MAP)

Replace the `pullback*` keys with:

| Key | Meaning | Default |
|-----|---------|---------|
| `extensionLookbackBars` | closed 5m bars scanned for the upper-band tag | 3 |
| `extensionTagBand` | band the bar high must reach: `"upper"` | `"upper"` |
| `extensionFloorBand` | band the latest close must stay above: `"middle"`/`"lower"` | `"middle"` |

Time-sensitivity note: upper-band entry wants to fire *while still near the high*, so N is
small (default 3 ≈ 15 min). For reliable capture at a 30-min screener cadence, lower
`screeningIntervalMin` toward ~10–15.

### 5. UI + docs

- `index.js` entry-preset button → `cfg:set:indicatorEntryPreset:supertrend_bb_extension`.
- CLAUDE.md: replace the `supertrend_bb_pullback` paragraph with the extension description
  + the LP-mechanics rationale (bins-below → deploy at the high to catch the pullback).

### 6. user-config.json migration

`entryPreset: "supertrend_bb_extension"`; replace `pullback*` keys with `extension*`
(`extensionLookbackBars: 3`, `extensionTagBand: "upper"`, `extensionFloorBand: "middle"`).

## Testing

Evaluator unit tests (synthetic payloads):
- 15m bullish + upper-band tag in window + close above middle + veto ok → confirm
- tag present but latest close below middle (pullback already done) → reject
- no upper-band tag in window → reject
- 15m bearish → reject
- veto: close < supertrend → reject
- degrade path (no `recent`): single-bar high ≥ upper + close ≥ middle → confirm; and a reject case
- routing through `confirmIndicatorPreset` (degrade/meridian) → preset/confirmed/intervals shape
- fail-closed (skipped) on fetch error
- `computeIndicators` recent series includes `high` and `bbUpper`
