# Supertrend + BB Pullback Entry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a composite entry preset `supertrend_bb_pullback` that deploys when the 15m supertrend is bullish AND price has pulled back to a Bollinger band and reclaimed it on the 5m chart within a lookback window.

**Architecture:** A new payload field (`recent` series of per-bar Bollinger bands) makes the pullback a *durable* state that survives the 30-min screener cadence. A pure decision function (`evaluateSupertrendBbPullback`) holds the logic; an async wrapper fetches both intervals (5m + 15m) and `confirmIndicatorPreset` branches to it. The `meridian` fallback (no `recent` series) degrades to a single-bar check. All existing presets, the exit side, and current behavior are untouched.

**Tech Stack:** Node.js (ESM), `node:test` + `node:assert/strict`. No new dependencies.

---

## Background the engineer needs

- **Indicators evaluate on the last *closed* bar.** `resampleKlines(..., { dropInProgress: true })` (tools/gmgn-indicators.js) buckets 1m klines by wall-clock boundary and drops the in-progress bar.
- **Data source.** `config.gmgn.indicatorSource` is `"gmgn"` (computes from GMGN klines via `computeIndicators`) with `"meridian"` (remote API, `latest`-only payload) as the failure fallback. Set in `gmgn-config.json`.
- **The entry gate runs in two places**, both calling `confirmIndicatorPreset({ side: "entry" })`:
  1. Screener: `tools/screening.js:819-857` (filters candidates).
  2. Deploy-time freshness re-check: `tools/executor.js:875-907`.
- **Return-shape contract** (consumed by executor.js:887-916): the object must have `enabled` (bool), `confirmed` (bool), `skipped` (bool — when true the deploy fails closed), `reason` (string), and `intervals` (array of `{ interval, ok, confirmed, reason, signal, latest }`). `signal` must carry `.rsi` because the independent `maxEntryRsi` veto reads `i.signal.rsi`.
- **`update_config` stores values as-is** (strings) unless the key is a bin key (tools/executor.js:467-480). So any numeric config key must be `Number(...)`-coerced when read, and string keys normalized with `String(...).toLowerCase()`.
- **Tests are run directly**, not via `npm test` (which is syntax-only). Run unit tests with `node --test tools/<file>.test.js`. Existing harness: `__setKlineFetcherForTest` / `__clearKlineCacheForTest` (gmgn) and `globalThis.fetch` override (meridian).

---

## File Structure

- **Modify** `tools/gmgn-indicators.js` — add `recentSeriesBars` param, `buildRecentSeries()` helper, and a `recent` field on the `computeIndicators` payload.
- **Modify** `tools/gmgn-indicators.test.js` — test for the `recent` series.
- **Modify** `tools/chart-indicators.js` — add pure `evaluateSupertrendBbPullback()`, async `confirmSupertrendBbPullback()`, and the branch in `confirmIndicatorPreset()`.
- **Modify** `tools/chart-indicators.test.js` — tests for the pure evaluator and the routing/degrade path.
- **Modify** `config.js` — three new `indicators.*` defaults.
- **Modify** `tools/executor.js` — register the three keys in `CONFIG_MAP`.
- **Modify** `index.js` — add the settings-UI button.
- **Modify** `CLAUDE.md` — document the new preset.

---

## Task 1: `recent` series on the indicator payload

**Files:**
- Modify: `tools/gmgn-indicators.js` (DEFAULT_INDICATOR_PARAMS ~line 226; helper near `computeBollinger` ~line 92; `computeIndicators` return ~line 207)
- Test: `tools/gmgn-indicators.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tools/gmgn-indicators.test.js` (extend the existing import on line 3 and append the test):

```js
// change line 3 from:
//   import { resampleKlines } from "./gmgn-indicators.js";
// to:
import { resampleKlines, computeIndicators, DEFAULT_INDICATOR_PARAMS } from "./gmgn-indicators.js";

test("computeIndicators emits a recent series with close/low/bbLower/bbMiddle", () => {
  // 30 ascending candles so bollinger/supertrend/rsi are all computable.
  const candles = Array.from({ length: 30 }, (_, i) => ({
    time: ALIGNED_5M + i * 5 * min,
    open: 100 + i, high: 102 + i, low: 98 + i, close: 100 + i,
  }));
  const params = { ...DEFAULT_INDICATOR_PARAMS, recentSeriesBars: 6, rsiLength: 2 };
  const payload = computeIndicators(candles, params);
  assert.ok(Array.isArray(payload.recent), "recent should be an array");
  assert.equal(payload.recent.length, 6);
  const last = payload.recent[payload.recent.length - 1];
  assert.equal(last.close, 129);
  assert.equal(last.low, 127);
  assert.ok(Number.isFinite(last.bbLower), "bbLower finite");
  assert.ok(Number.isFinite(last.bbMiddle), "bbMiddle finite");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/gmgn-indicators.test.js`
Expected: FAIL — `payload.recent` is `undefined` (`recent should be an array`).

- [ ] **Step 3: Add the `recentSeriesBars` param**

In `tools/gmgn-indicators.js`, inside `DEFAULT_INDICATOR_PARAMS` (after `warmupBars: 66,` ~line 253):

```js
  warmupBars: 66,
  // How many most-recent CLOSED bars to expose in the payload's `recent` series.
  // Consumed by the supertrend_bb_pullback entry preset to detect a pullback across a
  // window of closed bars (a durable signal, vs a single-bar event that the 30-min
  // screener would usually miss). Keep >= the largest expected pullbackLookbackBars.
  recentSeriesBars: 16,
```

- [ ] **Step 4: Add the `buildRecentSeries` helper**

In `tools/gmgn-indicators.js`, immediately after `computeBollinger` (after line 92):

```js
// Per-bar Bollinger lower/middle (plus close/low) for the last `n` candles.
// Each band is computed over the trailing `period` closes ending at that bar, so the
// series is non-repainting. Used to detect a pullback to a band across a window of
// recently CLOSED bars. Bars without enough history get null bands.
export function buildRecentSeries(candles, params, n) {
  const out = [];
  if (!Array.isArray(candles) || candles.length === 0) return out;
  const count = Math.max(1, Math.floor(n) || 1);
  const start = Math.max(0, candles.length - count);
  for (let i = start; i < candles.length; i++) {
    const closesUpToI = candles.slice(0, i + 1).map((c) => c.close);
    const bb = computeBollinger(closesUpToI, params.bollingerPeriod, params.bollingerStdDev);
    out.push({
      close: candles[i].close,
      low: candles[i].low,
      bbLower: bb ? bb.lower : null,
      bbMiddle: bb ? bb.middle : null,
    });
  }
  return out;
}
```

- [ ] **Step 5: Emit `recent` from `computeIndicators`**

In `tools/gmgn-indicators.js`, change the `computeIndicators` return (the object starting line 207) to add a `recent` field after the `latest` object closes (after line 219 `},`):

```js
    },
    recent: buildRecentSeries(candles, params, params.recentSeriesBars || 16),
  };
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test tools/gmgn-indicators.test.js`
Expected: PASS (all tests, including the existing `resampleKlines` ones).

- [ ] **Step 7: Commit**

```bash
git add tools/gmgn-indicators.js tools/gmgn-indicators.test.js
git commit -m "feat: expose per-bar recent BB series in indicator payload"
```

---

## Task 2: Pure `evaluateSupertrendBbPullback` decision function

**Files:**
- Modify: `tools/chart-indicators.js` (add exported function after `evaluatePreset`, ~line 237)
- Test: `tools/chart-indicators.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tools/chart-indicators.test.js` (add the import to the existing import group at the top):

```js
import { evaluateSupertrendBbPullback } from "./chart-indicators.js";

// 5m payload builder. `recent` optional → omit to exercise the degrade path.
const mk5 = ({ close, low, lower, middle, st, recent }) => ({
  latest: {
    candle: { close, low, high: close + 1, open: close },
    previousCandle: { close },
    rsi: { value: 50 },
    bollinger: { upper: middle + (middle - lower), middle, lower },
    supertrend: { value: st, direction: close >= st ? "bullish" : "bearish" },
    states: {},
  },
  ...(recent ? { recent } : {}),
});
const mk15 = (direction) => ({
  latest: {
    candle: { close: 100, low: 99, high: 101, open: 100 },
    previousCandle: { close: 100 },
    rsi: { value: 50 },
    bollinger: { upper: 110, middle: 100, lower: 90 },
    supertrend: { value: 90, direction },
    states: {},
  },
});
const PARAMS = { lookbackBars: 6, dipBand: "lower", reclaimBand: "middle" };

test("bb-pullback: 15m bullish + 5m pullback-and-reclaim in window → confirm", () => {
  const recent = [
    { close: 101, low: 90, bbLower: 95, bbMiddle: 100 }, // dip: low 90 <= lower 95
    { close: 103, low: 100, bbLower: 96, bbMiddle: 101 },
    { close: 105, low: 102, bbLower: 97, bbMiddle: 102 },
  ];
  const r = evaluateSupertrendBbPullback(
    mk5({ close: 105, low: 102, lower: 97, middle: 100, st: 95, recent }),
    mk15("bullish"), PARAMS);
  assert.equal(r.confirmed, true);
});

test("bb-pullback: dip but no reclaim (close below middle) → reject", () => {
  const recent = [{ close: 96, low: 90, bbLower: 95, bbMiddle: 100 }];
  const r = evaluateSupertrendBbPullback(
    mk5({ close: 98, low: 90, lower: 95, middle: 100, st: 95, recent }),
    mk15("bullish"), PARAMS);
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /reclaim/i);
});

test("bb-pullback: valid 5m setup but 15m bearish → reject", () => {
  const recent = [{ close: 101, low: 90, bbLower: 95, bbMiddle: 100 }];
  const r = evaluateSupertrendBbPullback(
    mk5({ close: 105, low: 102, lower: 97, middle: 100, st: 95, recent }),
    mk15("bearish"), PARAMS);
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /15m/i);
});

test("bb-pullback: veto when 5m close below supertrend → reject", () => {
  const recent = [{ close: 101, low: 90, bbLower: 95, bbMiddle: 100 }];
  const r = evaluateSupertrendBbPullback(
    mk5({ close: 92, low: 90, lower: 95, middle: 100, st: 95, recent }),
    mk15("bullish"), PARAMS);
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /veto/i);
});

test("bb-pullback: degrade path (no recent) uses single-bar check → confirm", () => {
  const r = evaluateSupertrendBbPullback(
    mk5({ close: 105, low: 95, lower: 95, middle: 100, st: 95 }), // low 95 <= lower 95
    mk15("bullish"), PARAMS);
  assert.equal(r.confirmed, true);
  assert.equal(r.degraded, true);
});

test("bb-pullback: dip outside lookback window → reject", () => {
  const recent = [
    { close: 101, low: 90, bbLower: 95, bbMiddle: 100 }, // dip, but oldest
    { close: 103, low: 101, bbLower: 96, bbMiddle: 101 },
    { close: 105, low: 102, bbLower: 97, bbMiddle: 102 },
  ];
  const r = evaluateSupertrendBbPullback(
    mk5({ close: 105, low: 102, lower: 97, middle: 100, st: 95, recent }),
    mk15("bullish"), { lookbackBars: 2, dipBand: "lower", reclaimBand: "middle" });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /pullback/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tools/chart-indicators.test.js`
Expected: FAIL — `evaluateSupertrendBbPullback` is not exported / not a function.

- [ ] **Step 3: Implement the pure evaluator**

In `tools/chart-indicators.js`, add immediately after `evaluatePreset` (after line 237, before `evaluateIntervalPreset`). It uses the module-local `buildSignalSummary` and `safeNum`:

```js
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
    const window = recent.slice(-lookbackBars);
    dipped = window.some((bar) => {
      const level = dipBand === "middle" ? bar.bbMiddle : bar.bbLower;
      return level != null && bar.low != null && bar.low <= level;
    });
  } else {
    // Degrade: no series (meridian fallback) → single-bar check on the latest 5m bar.
    degraded = true;
    const dipLevel = dipBand === "middle" ? s5.middleBand : s5.lowerBand;
    const low5 = safeNum(payload5m?.latest?.candle?.low) ?? s5.close;
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tools/chart-indicators.test.js`
Expected: PASS (all tests, including the two existing fallback tests).

- [ ] **Step 5: Commit**

```bash
git add tools/chart-indicators.js tools/chart-indicators.test.js
git commit -m "feat: pure evaluator for supertrend_bb_pullback composite entry"
```

---

## Task 3: Config keys (defaults + registration)

**Files:**
- Modify: `config.js` (indicators block, ~line 312-331)
- Modify: `tools/executor.js` (CONFIG_MAP, ~line 453)

- [ ] **Step 1: Add defaults in config.js**

In `config.js`, inside the `indicators:` object, add after `requireAllIntervals` (after line 324):

```js
    requireAllIntervals: indicatorUserConfig.requireAllIntervals ?? false,
    // supertrend_bb_pullback composite entry tuning (live-tunable via /setcfg).
    // Window of closed 5m bars scanned for the pullback. Size so N*5min exceeds the
    // screening interval + one bar (N=8 ≈ 40min for the default 30-min screener).
    pullbackLookbackBars: indicatorUserConfig.pullbackLookbackBars ?? 8,
    pullbackDipBand: indicatorUserConfig.pullbackDipBand ?? "lower",     // "lower" | "middle"
    pullbackReclaimBand: indicatorUserConfig.pullbackReclaimBand ?? "middle", // "middle" | "lower"
```

- [ ] **Step 2: Register keys in executor.js CONFIG_MAP**

In `tools/executor.js`, add after `requireAllIntervals` (after line 453):

```js
      requireAllIntervals: ["indicators", "requireAllIntervals", ["chartIndicators", "requireAllIntervals"]],
      pullbackLookbackBars: ["indicators", "pullbackLookbackBars", ["chartIndicators", "pullbackLookbackBars"]],
      pullbackDipBand: ["indicators", "pullbackDipBand", ["chartIndicators", "pullbackDipBand"]],
      pullbackReclaimBand: ["indicators", "pullbackReclaimBand", ["chartIndicators", "pullbackReclaimBand"]],
```

- [ ] **Step 3: Verify config loads the defaults**

Run:
```bash
node -e "import('./config.js').then(({config}) => { const i = config.indicators; console.log(i.pullbackLookbackBars, i.pullbackDipBand, i.pullbackReclaimBand); })"
```
Expected: `8 lower middle`

- [ ] **Step 4: Syntax-check executor**

Run: `node --check tools/executor.js`
Expected: no output (exit 0).

- [ ] **Step 5: Commit**

```bash
git add config.js tools/executor.js
git commit -m "feat: add pullback tuning config keys (lookback/dip/reclaim)"
```

---

## Task 4: Async wrapper + routing in `confirmIndicatorPreset`

**Files:**
- Modify: `tools/chart-indicators.js` (add wrapper before `confirmIndicatorPreset` ~line 300; add branch inside it after the guard ~line 309)
- Test: `tools/chart-indicators.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tools/chart-indicators.test.js` (add `confirmIndicatorPreset` to the chart-indicators import):

```js
test("confirmIndicatorPreset routes supertrend_bb_pullback through the composite (degrade path)", async () => {
  const prev = {
    src: config.gmgn.indicatorSource,
    en: config.indicators.enabled,
    ep: config.indicators.entryPreset,
    lb: config.indicators.pullbackLookbackBars,
    db: config.indicators.pullbackDipBand,
    rb: config.indicators.pullbackReclaimBand,
  };
  config.gmgn.indicatorSource = "meridian"; // no `recent` → exercise degrade + routing
  config.indicators.enabled = true;
  config.indicators.entryPreset = "supertrend_bb_pullback";
  config.indicators.pullbackLookbackBars = 6;
  config.indicators.pullbackDipBand = "lower";
  config.indicators.pullbackReclaimBand = "middle";

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    async text() {
      const is15 = String(url).includes("15_MINUTE");
      return JSON.stringify(is15
        ? { latest: { candle: { close: 100, low: 99 }, supertrend: { value: 90, direction: "bullish" }, bollinger: { lower: 80, middle: 90, upper: 100 }, rsi: { value: 50 } } }
        : { latest: { candle: { close: 105, low: 95 }, supertrend: { value: 95, direction: "bullish" }, bollinger: { lower: 95, middle: 100, upper: 110 }, rsi: { value: 50 } } });
    },
  });
  try {
    const res = await confirmIndicatorPreset({ mint: "MINTZ", side: "entry", refresh: true });
    assert.equal(res.preset, "supertrend_bb_pullback");
    assert.equal(res.confirmed, true);
    assert.equal(res.enabled, true);
    assert.equal(res.skipped, false);
    assert.equal(res.intervals.length, 2);
    assert.ok(res.intervals.every((i) => i.ok));
  } finally {
    globalThis.fetch = realFetch;
    config.gmgn.indicatorSource = prev.src;
    config.indicators.enabled = prev.en;
    config.indicators.entryPreset = prev.ep;
    config.indicators.pullbackLookbackBars = prev.lb;
    config.indicators.pullbackDipBand = prev.db;
    config.indicators.pullbackReclaimBand = prev.rb;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/chart-indicators.test.js`
Expected: FAIL — routing absent, so `res.preset` is the generic loop result (or `confirmed` is wrong), assertions fail.

- [ ] **Step 3: Implement the async wrapper**

In `tools/chart-indicators.js`, add immediately before `confirmIndicatorPreset` (before line 300). It coerces config values (recall `/setcfg` stores strings):

```js
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
```

- [ ] **Step 4: Add the routing branch**

In `tools/chart-indicators.js`, inside `confirmIndicatorPreset`, immediately after the disabled/missing guard (after line 309, before `const targets = normalizeIntervals(intervals);`):

```js
  if (side === "entry" && preset === "supertrend_bb_pullback") {
    return await confirmSupertrendBbPullback({ mint, refresh });
  }

  const targets = normalizeIntervals(intervals);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tools/chart-indicators.test.js`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add tools/chart-indicators.js tools/chart-indicators.test.js
git commit -m "feat: route supertrend_bb_pullback entry through cross-interval evaluator"
```

---

## Task 5: Settings-UI button

**Files:**
- Modify: `index.js` (entry preset button row, ~line 1533-1536)

- [ ] **Step 1: Add the button**

In `index.js`, in the entry-preset button row, add a third/fourth button (after line 1535):

```js
      [
        settingButton("Entry: ST", "cfg:set:indicatorEntryPreset:supertrend_break"),
        settingButton("Entry: RSI", "cfg:set:indicatorEntryPreset:rsi_reversal"),
        settingButton("Entry: ST/RSI", "cfg:set:indicatorEntryPreset:supertrend_or_rsi"),
        settingButton("Entry: ST+BB", "cfg:set:indicatorEntryPreset:supertrend_bb_pullback"),
      ],
```

- [ ] **Step 2: Syntax-check**

Run: `node --check index.js`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat: add Entry: ST+BB settings button for supertrend_bb_pullback"
```

---

## Task 6: Document the preset in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (Chart Indicator Source section)

- [ ] **Step 1: Add documentation**

In `CLAUDE.md`, at the end of the `## Chart Indicator Source (gmgn-config.json)` section (just before the `## Model Configuration` heading), add:

```markdown

**Entry preset `supertrend_bb_pullback` (composite, cross-interval).** Confirms a deploy
when the **15m supertrend is bullish** (HTF trend filter) AND price **pulled back to a
Bollinger band and reclaimed it on 5m** within `indicators.pullbackLookbackBars` closed
bars (default 8), with the standard `close >= supertrend` veto. Unlike other presets it
evaluates two intervals together via `confirmSupertrendBbPullback` (tools/chart-indicators.js),
bypassing the per-interval `intervals`/`requireAllIntervals` loop. The pullback is a
*durable* window state (not a single-bar event) so it survives the 30-min screener
cadence — size `pullbackLookbackBars` so `N*5min` exceeds the screening interval. The
`recent` per-bar band series powering it comes from the GMGN path (`computeIndicators`);
the meridian fallback has no series and **degrades to a single-bar pullback check**.
Tune via `/setcfg pullbackLookbackBars|pullbackDipBand|pullbackReclaimBand`.
```

- [ ] **Step 2: Verify**

Run: `grep -n "supertrend_bb_pullback" CLAUDE.md`
Expected: at least one match in the Chart Indicator section.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document supertrend_bb_pullback entry preset"
```

---

## Task 7: Full verification

- [ ] **Step 1: Syntax check the whole repo**

Run: `npm test`
Expected: completes with no `node --check` errors.

- [ ] **Step 2: Run all relevant unit tests**

Run: `node --test tools/gmgn-indicators.test.js tools/chart-indicators.test.js`
Expected: all tests pass; 0 failures.

- [ ] **Step 3: Smoke-test the live switch (no deploy)**

Run:
```bash
node -e "import('./config.js').then(({config}) => { config.indicators.enabled = true; config.indicators.entryPreset='supertrend_bb_pullback'; console.log('entryPreset', config.indicators.entryPreset, '| lookback', config.indicators.pullbackLookbackBars); })"
```
Expected: `entryPreset supertrend_bb_pullback | lookback 8`

---

## Self-Review (completed during planning)

- **Spec coverage:** new preset (T2,T4,T5) · 15m-bullish + 5m-pullback-reclaim + veto (T2) · durable lookback via `recent` series (T1) · cross-interval evaluator + routing (T4) · degrade to single-bar (T2) · config keys + live tuning (T3) · source-agnostic (no per-source code added — gate already runs after dispatch) · exit side untouched (no exit changes) · tests (T1,T2,T4). All spec sections map to a task.
- **Placeholder scan:** none — every code step shows full code; every run step shows command + expected output.
- **Type consistency:** `evaluateSupertrendBbPullback(payload5m, payload15m, params)` signature and `{confirmed, reason, signal5m, signal15m, degraded}` return are identical across T2 and T4. `buildRecentSeries(candles, params, n)` and the `recent` item shape `{close, low, bbLower, bbMiddle}` match between T1 (producer) and T2 (consumer). Config key names `pullbackLookbackBars`/`pullbackDipBand`/`pullbackReclaimBand` identical across T3, T4, T5, T6.
```
