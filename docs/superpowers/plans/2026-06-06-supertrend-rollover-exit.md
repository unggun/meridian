# Supertrend Rollover Exit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single `supertrend_rollover_exit` exit strategy that, on the 15m interval, closes any open position (regardless of PnL) when the 15m supertrend is bearish AND any of three OR'd, individually-toggleable blow-off triggers fired on the *previous closed bar*: RSI(2) > 90, MACD first-green histogram, or close above the upper Bollinger band.

**Architecture:** The indicator engine (`tools/gmgn-indicators.js`) gains MACD and a rolling RSI series, and exposes per-bar `rsi`/`macdHist` on the existing `recent` array plus `latest.macd`. A pure evaluator + a thin fetch wrapper live in `tools/chart-indicators.js`. The management cron (`index.js`) gets a new PnL-independent block — modeled on the existing `supertrendExitEnabled` block — that calls the wrapper directly (bypassing the `config.indicators.enabled` gate, exactly like its sibling), writes hits to `indicatorExitMap`, and reuses the existing 2-cycle debounce → close path. Config keys are added in `config.js` and the `/setcfg`/`update_config` map in `tools/executor.js`.

**Tech Stack:** Node.js (ESM), `node:test` + `node:assert/strict` for unit tests. Indicators are pure JS over OHLCV candle arrays.

> **Deviation from spec, intentional:** the spec §2/§3 said "route through `confirmIndicatorPreset`." `confirmIndicatorPreset` short-circuits when `config.indicators.enabled` is false, which would silently disable the rollover exit whenever the chart-exit feature is off. The sibling `supertrendExitEnabled` path deliberately bypasses that gate (it calls `evaluateIntervalPreset` directly). To match that "regardless of `enabled`" intent and avoid a footgun, this plan exports a dedicated `confirmSupertrendRolloverExit(...)` and calls it directly from `index.js`. The evaluator and wrapper still live in `chart-indicators.js`.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `tools/gmgn-indicators.js` | Indicator math + payload assembly | Add `computeRsiSeries`, `computeMacd`; MACD params; enrich `recent` + `latest.macd` |
| `tools/gmgn-indicators.test.js` | Unit tests for the engine | New tests for the above |
| `tools/chart-indicators.js` | Preset evaluators + fetch seam | Add `evaluateSupertrendRollover` (pure) + `confirmSupertrendRolloverExit` (wrapper) |
| `tools/chart-indicators.test.js` | Unit tests for evaluators | New tests for rollover evaluator + wrapper |
| `config.js` | Runtime config defaults | New `indicators.rollover*` keys |
| `tools/executor.js` | `update_config`/`/setcfg` key map | Register the new keys |
| `index.js` | Management cron orchestration | New PnL-independent rollover-exit block + import |
| `CLAUDE.md` | Project docs | Document the new exit + config keys |

**Test commands used throughout:**
- Engine tests: `node --test tools/gmgn-indicators.test.js`
- Evaluator tests: `node --test tools/chart-indicators.test.js`
- Syntax check (used where the repo has no unit harness, matching `npm run test:syntax`): `node --check <file>`

---

### Task 1: Rolling RSI series (`computeRsiSeries`)

**Files:**
- Modify: `tools/gmgn-indicators.js` (add export near `computeRsi`, ~line 78)
- Test: `tools/gmgn-indicators.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tools/gmgn-indicators.test.js` (add `computeRsiSeries` and `computeRsi` to the existing import on line 3):

```js
import { resampleKlines, computeIndicators, DEFAULT_INDICATOR_PARAMS, computeRsi, computeRsiSeries, computeMacd } from "./gmgn-indicators.js";
```

```js
test("computeRsiSeries is candle-aligned and its final value matches computeRsi", () => {
  const closes = [10, 11, 10.5, 12, 13, 12.5, 14, 13, 15, 16, 15.5, 17];
  const series = computeRsiSeries(closes, 2);
  assert.equal(series.length, closes.length);          // aligned to candles
  assert.equal(series[0], null);                        // no RSI before warmup
  const pointwise = computeRsi(closes, 2);
  assert.ok(Math.abs(series[series.length - 1] - pointwise) < 1e-9,
    `series tail ${series[series.length - 1]} should equal point RSI ${pointwise}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/gmgn-indicators.test.js`
Expected: FAIL — `computeRsiSeries is not a function` (or `export ... not defined`).

- [ ] **Step 3: Write minimal implementation**

In `tools/gmgn-indicators.js`, immediately after the `computeRsi` function (after line 78), add:

```js
// Rolling Wilder RSI aligned to `closes` (one value per close; null before warmup).
// series[i] uses the same Wilder smoothing as computeRsi, so series[last] === computeRsi(closes).
export function computeRsiSeries(closes, length = 2) {
  const out = new Array(Array.isArray(closes) ? closes.length : 0).fill(null);
  if (!Array.isArray(closes) || closes.length < length + 1) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= length; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) avgGain += delta;
    else avgLoss -= delta;
  }
  avgGain /= length;
  avgLoss /= length;
  const rsiFrom = (g, l) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[length] = rsiFrom(avgGain, avgLoss);
  for (let i = length + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (length - 1) + gain) / length;
    avgLoss = (avgLoss * (length - 1) + loss) / length;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/gmgn-indicators.test.js`
Expected: PASS (all tests, including the new one).

- [ ] **Step 5: Commit**

```bash
git add tools/gmgn-indicators.js tools/gmgn-indicators.test.js
git commit -m "feat(indicators): add rolling computeRsiSeries"
```

---

### Task 2: MACD with histogram series (`computeMacd`)

**Files:**
- Modify: `tools/gmgn-indicators.js` (add export after `computeRsiSeries`)
- Test: `tools/gmgn-indicators.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tools/gmgn-indicators.test.js` (the import was already extended in Task 1):

```js
test("computeMacd returns a candle-aligned histogram series with a first-green crossover", () => {
  // Down-leg then up-leg: the histogram must cross from <=0 to >0 during the up-leg.
  const down = Array.from({ length: 40 }, (_, i) => 100 - i);     // 100..61
  const up = Array.from({ length: 40 }, (_, i) => 61 + i * 2);    // 61, 63, ...
  const closes = [...down, ...up];
  const macd = computeMacd(closes, { fast: 12, slow: 26, signal: 9 });
  assert.equal(macd.histogramSeries.length, closes.length);
  assert.ok(Number.isFinite(macd.histogram), "latest histogram should be finite");
  let firstGreenIdx = -1;
  for (let i = 1; i < macd.histogramSeries.length; i++) {
    const a = macd.histogramSeries[i - 1];
    const b = macd.histogramSeries[i];
    if (a != null && b != null && a <= 0 && b > 0) { firstGreenIdx = i; break; }
  }
  assert.ok(firstGreenIdx > 0, "expected a histogram cross from <=0 to >0 during the up-leg");
});

test("computeMacd returns null when there is insufficient data", () => {
  assert.equal(computeMacd([1, 2, 3], { fast: 12, slow: 26, signal: 9 }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/gmgn-indicators.test.js`
Expected: FAIL — `computeMacd is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `tools/gmgn-indicators.js`, immediately after `computeRsiSeries`, add:

```js
// EMA aligned to `values`; null before the seed bar. Seed = SMA of the first `period`.
function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period || period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// MACD over `closes`. Returns { macd, signal, histogram } for the last bar plus the aligned
// `histogramSeries` (one value per close; null before the signal line is defined), or null
// when there is not enough data for the slow EMA + signal EMA. Used for first-green detection.
export function computeMacd(closes, { fast = 12, slow = 26, signal = 9 } = {}) {
  if (!Array.isArray(closes) || closes.length < slow + signal) return null;
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null);
  // Signal EMA over the defined portion of macdLine, mapped back to aligned indices.
  const firstMacd = macdLine.findIndex((v) => v != null);
  const defined = firstMacd >= 0 ? macdLine.slice(firstMacd) : [];
  const sigDefined = emaSeries(defined, signal);
  const signalLine = new Array(closes.length).fill(null);
  for (let j = 0; j < sigDefined.length; j++) {
    if (sigDefined[j] != null) signalLine[firstMacd + j] = sigDefined[j];
  }
  const histogramSeries = closes.map((_, i) =>
    macdLine[i] != null && signalLine[i] != null ? macdLine[i] - signalLine[i] : null);
  const last = closes.length - 1;
  if (histogramSeries[last] == null) return null;
  return {
    macd: macdLine[last],
    signal: signalLine[last],
    histogram: histogramSeries[last],
    histogramSeries,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/gmgn-indicators.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/gmgn-indicators.js tools/gmgn-indicators.test.js
git commit -m "feat(indicators): add computeMacd with aligned histogram series"
```

---

### Task 3: Enrich the `recent` series + payload with rsi/macdHist + MACD params

**Files:**
- Modify: `tools/gmgn-indicators.js` — `buildRecentSeries` (~line 98), `computeIndicators` (~line 219), `DEFAULT_INDICATOR_PARAMS` (~line 252)
- Test: `tools/gmgn-indicators.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tools/gmgn-indicators.test.js` (uses the `c`, `ALIGNED_15M`, `min` helpers already defined at the top of the file):

```js
test("computeIndicators enriches recent with rsi + macdHist and exposes latest.macd", () => {
  const base = ALIGNED_15M;
  // 80 candles with enough variation for RSI/MACD to be defined.
  const candles = Array.from({ length: 80 }, (_, i) => {
    const close = 100 + Math.sin(i / 3) * 6 + i * 0.15;
    return c(base + i * 15 * min, close, close + 1.5, close - 1.5, close, 100);
  });
  const params = { ...DEFAULT_INDICATOR_PARAMS, rsiLength: 2 };
  const out = computeIndicators(candles, params);
  assert.ok(Array.isArray(out.recent) && out.recent.length > 0);
  const lastBar = out.recent[out.recent.length - 1];
  assert.ok("rsi" in lastBar && "macdHist" in lastBar, "recent bars must carry rsi + macdHist");
  assert.ok(Number.isFinite(lastBar.rsi), "trailing rsi should be finite");
  assert.ok(out.latest.macd && Number.isFinite(out.latest.macd.histogram), "latest.macd present");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/gmgn-indicators.test.js`
Expected: FAIL — `'rsi' in lastBar` is false (recent bars only carry bb fields today), and/or `out.latest.macd` is undefined.

- [ ] **Step 3: Write minimal implementation**

**3a.** Replace the `buildRecentSeries` signature and body in `tools/gmgn-indicators.js` (lines 98–117) with a version that accepts optional aligned series and attaches them per bar:

```js
export function buildRecentSeries(candles, params, n, series = {}) {
  const out = [];
  if (!Array.isArray(candles) || candles.length === 0) return out;
  const count = Math.max(0, Number.isFinite(n) ? Math.floor(n) : 1);
  if (count === 0) return out;
  const rsiSeries = Array.isArray(series.rsiSeries) ? series.rsiSeries : null;
  const macdHistSeries = Array.isArray(series.macdHistSeries) ? series.macdHistSeries : null;
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
      rsi: rsiSeries ? rsiSeries[i] ?? null : null,
      macdHist: macdHistSeries ? macdHistSeries[i] ?? null : null,
    });
  }
  return out;
}
```

**3b.** In `computeIndicators` (lines 219–247), compute the series and pass them through. Replace the body from `const closes = ...` through the `return { ... }` with:

```js
  const closes = candles.map((c) => c.close);
  const supertrend = computeSupertrend(candles, params.supertrendPeriod, params.supertrendMultiplier);
  const bollinger = computeBollinger(closes, params.bollingerPeriod, params.bollingerStdDev);
  const rsi = computeRsi(closes, params.rsiLength);
  if (!supertrend || !bollinger || rsi == null) {
    throw new Error("insufficient kline data for indicators");
  }
  // MACD is best-effort: null when history is short → triggers that need it simply don't fire.
  const rsiSeries = computeRsiSeries(closes, params.rsiLength);
  const macd = computeMacd(closes, { fast: params.macdFast, slow: params.macdSlow, signal: params.macdSignal });
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  return {
    latest: {
      candle: { open: last.open, high: last.high, low: last.low, close: last.close },
      previousCandle: { close: prev.close },
      rsi: { value: rsi },
      macd: macd ? { macd: macd.macd, signal: macd.signal, histogram: macd.histogram } : null,
      bollinger: { upper: bollinger.upper, middle: bollinger.middle, lower: bollinger.lower },
      supertrend: { value: supertrend.value, direction: supertrend.direction },
      states: {
        supertrendBreakUp: supertrend.breakUp,
        supertrendBreakDown: supertrend.breakDown,
      },
      fibonacci: computeFibonacci(candles, params.fibLookbackBars),
    },
    recent: buildRecentSeries(candles, params, params.recentSeriesBars || 16, {
      rsiSeries,
      macdHistSeries: macd ? macd.histogramSeries : null,
    }),
  };
```

**3c.** In `DEFAULT_INDICATOR_PARAMS` (after `bollingerStdDev: 2,` on line 256), add MACD params:

```js
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/gmgn-indicators.test.js`
Expected: PASS (new test + all prior tests, including the `recent`/bb-extension ones, still green).

- [ ] **Step 5: Commit**

```bash
git add tools/gmgn-indicators.js tools/gmgn-indicators.test.js
git commit -m "feat(indicators): expose per-bar rsi/macdHist on recent + latest.macd"
```

---

### Task 4: Pure rollover evaluator (`evaluateSupertrendRollover`)

**Files:**
- Modify: `tools/chart-indicators.js` (add export after `evaluateSupertrendBbExtension`, ~line 301)
- Test: `tools/chart-indicators.test.js`

- [ ] **Step 1: Write the failing test**

In `tools/chart-indicators.test.js`, extend the import on line 6 to include the new export:

```js
import { fetchChartIndicatorsForMint, evaluateSupertrendBbExtension, evaluateSupertrendRollover, confirmSupertrendRolloverExit, confirmIndicatorPreset } from "./chart-indicators.js";
```

Then append:

```js
// 15m payload with a `recent` series for the rollover exit. recent[-1]=latest closed bar,
// recent[-2]=previous bar (what the triggers read), recent[-3]=the bar before that.
const mkRollover = ({ direction, recent }) => ({
  latest: {
    candle: { close: 100, high: 101, low: 99, open: 100 },
    previousCandle: { close: 100 },
    rsi: { value: 50 },
    bollinger: { upper: 110, middle: 100, lower: 90 },
    supertrend: { value: 105, direction },
    states: {},
  },
  ...(recent ? { recent } : {}),
});
const rbar = ({ close = 100, bbUpper = 110, rsi = 50, macdHist = 0 } = {}) =>
  ({ close, high: close + 1, low: close - 1, bbLower: 90, bbMiddle: 100, bbUpper, rsi, macdHist });
const ALL = { rsiEnabled: true, macdEnabled: true, bbEnabled: true, rsiUpper: 90 };

test("rollover: bullish 15m supertrend vetoes every trigger", () => {
  const r = evaluateSupertrendRollover(
    mkRollover({ direction: "bullish", recent: [rbar({ rsi: 95 }), rbar({ rsi: 95 })] }), ALL);
  assert.equal(r.confirmed, false);
});

test("rollover: RSI>90 on the previous bar fires when 15m ST is bearish", () => {
  const r = evaluateSupertrendRollover(
    mkRollover({ direction: "bearish", recent: [rbar({ rsi: 95 }), rbar({ rsi: 50 })] }), ALL);
  assert.equal(r.confirmed, true);
});

test("rollover: RSI trigger reads the previous bar, not the latest", () => {
  // latest (recent[-1]) is hot, previous (recent[-2]) is calm → must NOT fire.
  const r = evaluateSupertrendRollover(
    mkRollover({ direction: "bearish", recent: [rbar({ rsi: 50 }), rbar({ rsi: 95 })] }),
    { ...ALL, macdEnabled: false, bbEnabled: false });
  assert.equal(r.confirmed, false);
});

test("rollover: previous bar closing above the upper band fires", () => {
  const r = evaluateSupertrendRollover(
    mkRollover({ direction: "bearish", recent: [rbar({ close: 120, bbUpper: 110 }), rbar({ close: 100 })] }),
    { ...ALL, rsiEnabled: false, macdEnabled: false });
  assert.equal(r.confirmed, true);
});

test("rollover: previous bar = first green histogram fires", () => {
  // recent[-3] hist<=0, recent[-2] hist>0 → first green on the previous bar.
  const r = evaluateSupertrendRollover(
    mkRollover({ direction: "bearish", recent: [rbar({ macdHist: -1 }), rbar({ macdHist: 2 }), rbar({ macdHist: 5 })] }),
    { ...ALL, rsiEnabled: false, bbEnabled: false });
  assert.equal(r.confirmed, true);
});

test("rollover: macd does not fire when the bar before was already green", () => {
  const r = evaluateSupertrendRollover(
    mkRollover({ direction: "bearish", recent: [rbar({ macdHist: 1 }), rbar({ macdHist: 2 }), rbar({ macdHist: 5 })] }),
    { ...ALL, rsiEnabled: false, bbEnabled: false });
  assert.equal(r.confirmed, false);
});

test("rollover: a disabled sub-trigger does not fire", () => {
  const r = evaluateSupertrendRollover(
    mkRollover({ direction: "bearish", recent: [rbar({ rsi: 95 }), rbar({ rsi: 50 })] }),
    { rsiEnabled: false, macdEnabled: false, bbEnabled: false, rsiUpper: 90 });
  assert.equal(r.confirmed, false);
});

test("rollover: missing recent series degrades to skipped (no exit)", () => {
  const r = evaluateSupertrendRollover(mkRollover({ direction: "bearish", recent: undefined }), ALL);
  assert.equal(r.confirmed, false);
  assert.equal(r.skipped, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/chart-indicators.test.js`
Expected: FAIL — `evaluateSupertrendRollover is not a function` (and the import of `confirmSupertrendRolloverExit` is undefined; both land in Tasks 4–5).

- [ ] **Step 3: Write minimal implementation**

In `tools/chart-indicators.js`, immediately after `evaluateSupertrendBbExtension` (after line 301), add:

```js
// Pure decision for the supertrend_rollover_exit (no I/O). params pre-coerced:
//   { rsiEnabled, macdEnabled, bbEnabled, rsiUpper:number }.
// Thesis: a trend rollover / blow-off top. Gate on 15m supertrend bearish, then OR three
// blow-off triggers read from the PREVIOUS closed bar (recent[-2]):
//   rsi  → prev.rsi > rsiUpper
//   bb   → prev.close > prev.bbUpper
//   macd → first green histogram on prev (prev.macdHist > 0 && recent[-3].macdHist <= 0)
// No `recent` series (meridian fallback) → { skipped:true } so the cron never exits on
// missing data (it requires confirmed && !skipped). Returns { confirmed, reason, signal, skipped }.
export function evaluateSupertrendRollover(payload, params) {
  const summary = buildSignalSummary(payload);
  const base = { signal: summary, skipped: false };
  if (summary.supertrendDirection !== "bearish") {
    return { ...base, confirmed: false, reason: `15m supertrend ${summary.supertrendDirection} (need bearish)` };
  }
  const recent = Array.isArray(payload?.recent) ? payload.recent : null;
  if (!recent || recent.length < 2) {
    return { ...base, skipped: true, confirmed: false, reason: "No recent series — rollover exit skipped" };
  }
  const prev = recent[recent.length - 2];
  const prev2 = recent.length >= 3 ? recent[recent.length - 3] : null;

  const fired = [];
  if (params.rsiEnabled && prev?.rsi != null && prev.rsi > params.rsiUpper) {
    fired.push(`RSI ${prev.rsi.toFixed(1)} > ${params.rsiUpper}`);
  }
  if (params.bbEnabled && prev?.close != null && prev?.bbUpper != null && prev.close > prev.bbUpper) {
    fired.push(`close ${prev.close} > upper band ${prev.bbUpper.toFixed(6)}`);
  }
  if (
    params.macdEnabled &&
    prev?.macdHist != null && prev.macdHist > 0 &&
    prev2?.macdHist != null && prev2.macdHist <= 0
  ) {
    fired.push("MACD first green histogram");
  }

  const confirmed = fired.length > 0;
  return {
    ...base,
    confirmed,
    reason: confirmed
      ? `15m bearish supertrend + ${fired.join(" / ")} (prev bar)`
      : "15m bearish but no rollover trigger on previous bar",
  };
}
```

- [ ] **Step 4: Run test to verify the evaluator tests pass**

Run: `node --test tools/chart-indicators.test.js`
Expected: the 8 `rollover:` evaluator tests PASS. (Tests referencing `confirmSupertrendRolloverExit` still fail to import until Task 5 — that's expected; if the runner aborts on the missing import, do Task 5 before re-running. The two tasks are committed separately but the import binding is shared.)

> **Note for the implementer:** because the shared import line references `confirmSupertrendRolloverExit` (added in Task 5), the test file will not fully load until Task 5 lands. Implement Task 4 and Task 5 back-to-back, then run the suite once after Task 5. Commit each task's source separately as below.

- [ ] **Step 5: Commit**

```bash
git add tools/chart-indicators.js tools/chart-indicators.test.js
git commit -m "feat(indicators): add evaluateSupertrendRollover exit evaluator"
```

---

### Task 5: Fetch wrapper (`confirmSupertrendRolloverExit`)

**Files:**
- Modify: `tools/chart-indicators.js` (add after `evaluateSupertrendRollover`)
- Test: `tools/chart-indicators.test.js` (wrapper test; import already extended in Task 4)

- [ ] **Step 1: Write the failing test**

Append to `tools/chart-indicators.test.js`:

```js
test("confirmSupertrendRolloverExit returns skipped when payload has no recent series", async () => {
  const prevSource = config.gmgn.indicatorSource;
  config.gmgn.indicatorSource = "meridian"; // meridian payload has no `recent` → degrade path
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async text() {
      return JSON.stringify({
        latest: {
          candle: { close: 100 },
          previousCandle: { close: 100 },
          rsi: { value: 50 },
          bollinger: { upper: 110, middle: 100, lower: 90 },
          supertrend: { value: 105, direction: "bearish" },
          states: {},
        },
      });
    },
  });
  try {
    const r = await confirmSupertrendRolloverExit({ mint: "MINTROLL" });
    assert.equal(r.skipped, true);
    assert.equal(r.confirmed, false);
    assert.equal(r.preset, "supertrend_rollover_exit");
  } finally {
    globalThis.fetch = realFetch;
    config.gmgn.indicatorSource = prevSource;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/chart-indicators.test.js`
Expected: FAIL — `confirmSupertrendRolloverExit is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `tools/chart-indicators.js`, immediately after `evaluateSupertrendRollover`, add the wrapper. It reads config flags, fetches the 15m payload via the existing seam, evaluates, and returns the standard confirmation shape. On fetch failure it fails safe (`skipped:true`, no exit):

```js
// Fetch the 15m payload and evaluate the rollover exit. Called DIRECTLY by index.js
// (not via confirmIndicatorPreset) so it runs regardless of config.indicators.enabled —
// matching the sibling supertrendExit path. Returns the standard confirmation shape.
export async function confirmSupertrendRolloverExit({ mint, refresh = false } = {}) {
  const params = {
    rsiEnabled: config.indicators.rolloverRsi !== false,
    macdEnabled: config.indicators.rolloverMacd !== false,
    bbEnabled: config.indicators.rolloverBb !== false,
    rsiUpper: Number(config.indicators.rolloverRsiUpper) || 90,
  };
  let payload;
  try {
    payload = await fetchChartIndicatorsForMint(mint, { interval: "15_MINUTE", refresh });
  } catch (error) {
    log("indicators_warn", `Rollover exit fetch failed for ${String(mint).slice(0, 8)}: ${error.message}`);
    return {
      enabled: true, confirmed: false, skipped: true,
      preset: "supertrend_rollover_exit", side: "exit",
      reason: `Fetch failed: ${error.message}`, intervals: [],
    };
  }
  const evaln = evaluateSupertrendRollover(payload, params);
  return {
    enabled: true,
    confirmed: !!evaln.confirmed && !evaln.skipped,
    skipped: !!evaln.skipped,
    preset: "supertrend_rollover_exit",
    side: "exit",
    reason: evaln.reason,
    intervals: [{ interval: "15_MINUTE", ok: true, confirmed: !!evaln.confirmed, reason: evaln.reason, signal: evaln.signal, latest: payload?.latest || null }],
  };
}
```

- [ ] **Step 4: Run the full evaluator suite**

Run: `node --test tools/chart-indicators.test.js`
Expected: PASS — all rollover evaluator tests + the wrapper test + all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add tools/chart-indicators.js tools/chart-indicators.test.js
git commit -m "feat(indicators): add confirmSupertrendRolloverExit fetch wrapper"
```

---

### Task 6: Config defaults (`config.js`)

**Files:**
- Modify: `config.js` (inside the `indicators` block, after line 337)

- [ ] **Step 1: Add the config keys**

In `config.js`, after the `supertrendExitInterval` line (line 337) and before the closing `},` of the `indicators` block (line 338), add:

```js
    // Rollover / blow-off exit (Approach A): ONE preset, three OR'd sub-triggers, all on
    // 15m, evaluated on ALL positions regardless of PnL and regardless of `enabled`. Each
    // sub-trigger reads the PREVIOUS closed bar. See confirmSupertrendRolloverExit.
    rolloverExitEnabled: indicatorUserConfig.rolloverExitEnabled ?? false,
    rolloverRsi: indicatorUserConfig.rolloverRsi ?? true,         // prev-bar RSI(2) > rolloverRsiUpper
    rolloverMacd: indicatorUserConfig.rolloverMacd ?? true,       // prev bar = first green MACD histogram
    rolloverBb: indicatorUserConfig.rolloverBb ?? true,           // prev bar closed above upper Bollinger band
    rolloverRsiUpper: indicatorUserConfig.rolloverRsiUpper ?? 90, // dedicated (does not clobber rsiOverbought=80)
```

- [ ] **Step 2: Verify the file parses**

Run: `node --check config.js`
Expected: no output, exit 0 (syntax OK). The repo's config requires runtime env to fully import, so a syntax check is the appropriate gate here (matches `npm run test:syntax`).

- [ ] **Step 3: Commit**

```bash
git add config.js
git commit -m "feat(config): add rollover exit keys (enable + per-trigger toggles + rsi upper)"
```

---

### Task 7: Register keys in the `/setcfg` / `update_config` map (`tools/executor.js`)

**Files:**
- Modify: `tools/executor.js` (the `CONFIG_MAP`, after line 458)

- [ ] **Step 1: Add the key mappings**

In `tools/executor.js`, after the `supertrendExitInterval` mapping (line 458), add:

```js
      rolloverExitEnabled: ["indicators", "rolloverExitEnabled", ["chartIndicators", "rolloverExitEnabled"]],
      rolloverRsi: ["indicators", "rolloverRsi", ["chartIndicators", "rolloverRsi"]],
      rolloverMacd: ["indicators", "rolloverMacd", ["chartIndicators", "rolloverMacd"]],
      rolloverBb: ["indicators", "rolloverBb", ["chartIndicators", "rolloverBb"]],
      rolloverRsiUpper: ["indicators", "rolloverRsiUpper", ["chartIndicators", "rolloverRsiUpper"]],
```

- [ ] **Step 2: Verify the file parses**

Run: `node --check tools/executor.js`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add tools/executor.js
git commit -m "feat(config): expose rollover exit keys to /setcfg and update_config"
```

---

### Task 8: Wire the rollover-exit block into the management cron (`index.js`)

**Files:**
- Modify: `index.js` — import (line 12) and the management cycle (after line 359, the end of the `supertrendExitEnabled` block)

- [ ] **Step 1: Extend the chart-indicators import**

In `index.js` line 12, add `confirmSupertrendRolloverExit` to the import:

```js
import { confirmIndicatorPreset, evaluateIntervalPreset, confirmSupertrendRolloverExit } from "./tools/chart-indicators.js";
```

- [ ] **Step 2: Add the PnL-independent rollover block**

In `index.js`, immediately after the closing `}` of the `supertrendExitEnabled` block (after line 359) and before the `// ── Deterministic rule checks` comment (line 361), insert:

```js
    // ── Rollover / blow-off exit (independent of PnL and the enabled/exitPreset gate) ──
    // 15m supertrend bearish + any enabled blow-off trigger (RSI>90 / first-green MACD /
    // close above upper band) on the PREVIOUS closed bar. Writes to indicatorExitMap, so it
    // reuses the same 2-cycle debounce → close path as the other chart exits.
    if (config.indicators?.rolloverExitEnabled) {
      const candidates = positionData.filter(
        (p) => p.base_mint && !exitMap.has(p.position) && !indicatorExitMap.has(p.position),
      );
      if (candidates.length > 0) {
        const results = await Promise.allSettled(
          candidates.map((p) => confirmSupertrendRolloverExit({ mint: p.base_mint, refresh: true })),
        );
        candidates.forEach((p, i) => {
          const r = results[i];
          if (r.status !== "fulfilled") {
            log("state_warn", `Rollover exit check failed for ${p.pair}: ${r.reason?.message || r.reason}`);
            return;
          }
          const v = r.value;
          if (v?.confirmed && !v.skipped) {
            const reason = v.reason || "Rollover blow-off signal";
            indicatorExitMap.set(p.position, reason);
            log("state", `Rollover exit alert for ${p.pair}: ${reason}`);
          }
        });
      }
    }
```

- [ ] **Step 3: Verify the file parses**

Run: `node --check index.js`
Expected: no output, exit 0.

- [ ] **Step 4: Run the full unit suite to confirm nothing regressed**

Run: `node --test tools/gmgn-indicators.test.js tools/chart-indicators.test.js`
Expected: PASS (all engine + evaluator tests).

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat(exit): wire supertrend_rollover_exit into the management cron"
```

---

### Task 9: Document the new exit + config keys (`CLAUDE.md`)

**Files:**
- Modify: `CLAUDE.md` — the Config System table and the Chart Indicator Source section

- [ ] **Step 1: Add the config keys to the table**

In `CLAUDE.md`, in the "Valid config keys and their sections" table, add these rows (section column = `indicators`/chartIndicators):

```markdown
| rolloverExitEnabled | indicators | false |
| rolloverRsi / rolloverMacd / rolloverBb | indicators | true |
| rolloverRsiUpper | indicators | 90 |
```

- [ ] **Step 2: Add a description paragraph**

In `CLAUDE.md`, at the end of the `## Chart Indicator Source (gmgn-config.json)` section (just before the `---` that closes it), add:

```markdown
**Exit preset `supertrend_rollover_exit` (composite, 15m, PnL-independent).** One exit that
closes ANY position (regardless of PnL) when the **15m supertrend is bearish** AND any enabled
blow-off trigger fired on the **previous closed 15m bar**: `rolloverRsi` (RSI(2) >
`rolloverRsiUpper`, default 90), `rolloverMacd` (first green MACD histogram — prev bar > 0,
the bar before ≤ 0), or `rolloverBb` (prev bar closed above the upper Bollinger band). The
three are OR'd and individually toggleable. Evaluated by `confirmSupertrendRolloverExit`
(tools/chart-indicators.js) → `evaluateSupertrendRollover`, called directly from the
management cron's `rolloverExitEnabled` block in index.js so it runs **independent of
`config.indicators.enabled`** (like the `supertrendExitEnabled` breakdown exit). MACD +
per-bar RSI/`macdHist` come from the GMGN path (`computeMacd`/`computeRsiSeries`, exposed on
the `recent` series); the meridian fallback has no series and **degrades to skipped** (never
closes on missing data). Hits route through the standard 2-cycle chart-exit debounce. Tune via
`/setcfg rolloverExitEnabled|rolloverRsi|rolloverMacd|rolloverBb|rolloverRsiUpper`.
```

- [ ] **Step 3: Verify the suite is still green and commit**

Run: `node --test tools/gmgn-indicators.test.js tools/chart-indicators.test.js`
Expected: PASS.

```bash
git add CLAUDE.md
git commit -m "docs: document supertrend_rollover_exit and its config keys"
```

---

## Self-Review

**Spec coverage:**
- RSI/MACD/BB exit triggers, all 15m, prev-bar, OR'd, toggleable → Tasks 4 (evaluator) + 2/3 (MACD + series).
- "Regardless of PnL / trend rollover" → Task 8 PnL-independent block (+ direct-call wiring, documented deviation).
- MACD net-new + histogram series + first-green → Tasks 2, 3, 4.
- Previous-bar RSI exposed → Tasks 1, 3 (via `recent[].rsi`).
- BB prev-bar via existing series → Task 4 (reads `recent[-2].bbUpper`, populated already).
- Meridian-fallback degrade → Task 4 (`skipped` when no `recent`) + Task 5 wrapper test.
- Config keys + `/setcfg` + CLAUDE.md table → Tasks 6, 7, 9.
- Tests for engine + evaluator + degrade → Tasks 1–5, 8, 9.
- Debounce reuse (signed-off behavior) → Task 8 (writes to `indicatorExitMap`).

**Placeholder scan:** none — every code/test step shows complete code and exact commands.

**Type/name consistency:** `computeRsiSeries`, `computeMacd` (returns `{ macd, signal, histogram, histogramSeries }`), `buildRecentSeries(candles, params, n, { rsiSeries, macdHistSeries })`, `recent[].rsi`/`recent[].macdHist`, `evaluateSupertrendRollover(payload, { rsiEnabled, macdEnabled, bbEnabled, rsiUpper })` returning `{ confirmed, reason, signal, skipped }`, `confirmSupertrendRolloverExit({ mint, refresh })`, config keys `rolloverExitEnabled/rolloverRsi/rolloverMacd/rolloverBb/rolloverRsiUpper` — all used consistently across tasks.

**Known intentional deviation:** wrapper is called directly from `index.js` rather than through `confirmIndicatorPreset` (documented at the top), to keep "regardless of `enabled`" semantics.
