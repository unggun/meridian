# GMGN Kline Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GMGN-kline-computed chart-indicator source behind a config switch (default = existing Meridian endpoint), with transparent auto-fallback, plus consolidate the GMGN screening path's two pool-discovery round-trips.

**Architecture:** A provider switch inside the existing `fetchChartIndicatorsForMint` seam dispatches to either the untouched Meridian endpoint or a new `tools/gmgn-indicators.js` module that fetches 1m GMGN klines, resamples to 5m/15m, and computes supertrend/RSI/Bollinger into the identical `{latest:{...}}` payload all consumers already read. Any GMGN failure falls back to Meridian.

**Tech Stack:** Node 20 ESM (`"type":"module"`), built-in `node:test` + `node:assert` (no new deps), native `fetch`.

---

## Background for the implementer (read first)

This repo is an autonomous Meteora DLMM liquidity-provider agent. You do **not** need to understand the trading logic. You need three facts:

1. **The seam.** `tools/chart-indicators.js` has a function `fetchChartIndicatorsForMint(mint, {interval, candles, rsiLength, refresh})` that returns a payload shaped like:
   ```
   { latest: {
       candle: { open, high, low, close },
       previousCandle: { close },
       rsi: { value },
       bollinger: { upper, middle, lower },
       supertrend: { value, direction },          // direction: "bullish" | "bearish"
       states: { supertrendBreakUp, supertrendBreakDown },
       fibonacci: { levels: { "0.500":..., "0.618":..., "0.786":... } }
   } }
   ```
   Two callers read this: `buildSignalSummary`/`evaluatePreset` in the same file, and `evaluateBouncePayload` in `tools/gmgn.js`. If our GMGN code returns the same shape, both work unchanged.

2. **No test framework exists.** Use Node's built-in runner: files named `*.test.js`, run with `node --test`. Import `{ test } from "node:test"` and `assert from "node:assert/strict"`.

3. **Config.** `config.js` loads `user-config.json` (→ `u`) and `gmgn-config.json` (→ `gmgnUserConfig`). The helper `gmgnValue(key, legacyKey, fallback)` resolves `gmgn-config.json` → `user-config.json[legacyKey]` → `fallback`. The live config object is exported as `config`; gmgn settings live under `config.gmgn`.

**No new npm dependencies.** Everything uses Node built-ins.

**Commit after every task.** This is the default branch `custom`; commits are fine, do not push.

---

## File Structure

- **Create `tools/gmgn-client.js`** — the GMGN HTTP client (`gmgnFetch` + `paceGmgnRequest` + the single shared throttle), extracted from `gmgn.js`. Depends only on `config`/`logger` — no other tool module — so importing it never creates a dependency cycle.
- **Create `tools/gmgn-indicators.js`** — kline fetch + resample + indicator math + payload assembly + per-mint TTL cache. Imports the client, never `gmgn.js`.
- **Create `tools/gmgn-indicators.test.js`** — unit tests for the pure functions (resample, indicator math, payload shape, cache).
- **Create `scripts/validate-gmgn-indicators.js`** — manual dev tool comparing GMGN vs Meridian decision-level agreement.
- **Modify `tools/gmgn.js`** — import the client (drop the moved code); add concurrent 24h fetch + stamp in `pickBestPool`.
- **Modify `tools/chart-indicators.js`** — rename existing body to `fetchMeridianIndicatorPayload`; make `fetchChartIndicatorsForMint` a dispatcher with fallback.
- **Modify `tools/screening.js`** — 24h gate reads the stamped `fee_tvl_ratio_24h` when present, fetches only as fallback.
- **Modify `config.js`** — add `indicatorSource` + `indicatorParams` under `config.gmgn`.
- **Modify `gmgn-config.json`** — add `indicatorSource` (default "meridian") + optional `indicatorParams`.
- **Modify `CLAUDE.md`** — document the switch.

Tasks are ordered so the shared client is extracted first, then the new module is built and tested in isolation, then wired into the seam, then config, then the independent #3 consolidation, then docs.

### Why a separate `gmgn-client.js` (read before Task 1)

`gmgn.js` already imports `chart-indicators.js` (for `fetchChartIndicatorsForMint`). The
new indicator module needs `gmgnFetch`. If `gmgn-indicators.js` imported `gmgnFetch`
straight from `gmgn.js`, and `chart-indicators.js` imported `gmgn-indicators.js`, we'd
get a 3-module cycle: `chart-indicators → gmgn-indicators → gmgn → chart-indicators`.
That cycle happens to resolve today only because the functions are hoisted declarations —
a latent footgun. Extracting the HTTP client into a leaf module (`gmgn-client.js`, which
imports only `config` + `logger`) removes the cycle for good:

```
gmgn-client.js   →  config, logger                 (leaf)
gmgn-indicators  →  gmgn-client, config            (no path back)
chart-indicators →  gmgn-indicators, config, logger
gmgn.js          →  gmgn-client, chart-indicators, … (leaf consumer; nothing imports it back)
```

The shared throttle (`lastGmgnRequestAt` + `paceGmgnRequest`) lives in `gmgn-client.js`
as a single module-singleton, so both `gmgn.js` and `gmgn-indicators.js` honor one
rate-limit gate.

---

## Task 1: Extract the GMGN HTTP client into `tools/gmgn-client.js`

Move the HTTP client + shared throttle out of `gmgn.js` into a new leaf module so both
`gmgn.js` and the new `gmgn-indicators.js` can import it without a dependency cycle (see
"Why a separate gmgn-client.js" above). Behavior is unchanged — this is a pure move.

`normalizeInterval` and `SUPPORTED_INTERVALS` **stay in `gmgn.js`** (they belong to the
screener, not the HTTP client). Only `sleep`, `paceGmgnRequest`, `getApiKey`,
`appendParams`, `gmgnFetch`, the throttle state, and the IPv4/crypto imports move.

**Files:**
- Create: `tools/gmgn-client.js`
- Modify: `tools/gmgn.js` (remove moved code, add an import)

- [ ] **Step 1: Create `tools/gmgn-client.js` with the moved code (verbatim)**

```js
import { randomUUID } from "crypto";
import { setDefaultResultOrder } from "dns";
import { config } from "../config.js";

// Force IPv4 — GMGN OpenAPI does not support IPv6
setDefaultResultOrder("ipv4first");

// Single shared throttle for ALL GMGN requests across the process. Both gmgn.js
// (screening) and gmgn-indicators.js (klines) import gmgnFetch from here, so they
// honor one rate-limit gate (module singletons share this state).
let lastGmgnRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function paceGmgnRequest() {
  const delayMs = Math.max(0, Number(config.gmgn?.requestDelayMs ?? 2500));
  if (!delayMs) return;
  const elapsed = Date.now() - lastGmgnRequestAt;
  if (elapsed < delayMs) await sleep(delayMs - elapsed);
  lastGmgnRequestAt = Date.now();
}

function getApiKey() {
  const key = config.gmgn?.apiKey || process.env.GMGN_API_KEY;
  if (!key) throw new Error("GMGN_API_KEY is required when screeningSource=gmgn.");
  return key;
}

function appendParams(url, params = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const entry of value.filter((item) => item != null && item !== "")) {
        url.searchParams.append(key, String(entry));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

export async function gmgnFetch(pathname, { method = "GET", params = {}, body = null } = {}) {
  const baseUrl = String(config.gmgn?.baseUrl || "https://openapi.gmgn.ai").replace(/\/+$/, "");
  const url = new URL(`${baseUrl}${pathname}`);
  appendParams(url, {
    ...params,
    timestamp: Math.floor(Date.now() / 1000),
    client_id: randomUUID(),
  });

  const maxRetries = Math.max(0, Number(config.gmgn?.maxRetries ?? 2));
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await paceGmgnRequest();
    const res = await fetch(url, {
      method,
      headers: {
        "X-APIKEY": getApiKey(),
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : null,
    });
    const text = await res.text().catch(() => "");
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    const message = payload?.message || payload?.error || payload?.raw || `GMGN ${pathname} ${res.status}`;
    const rateLimited = res.status === 429 || /rate limit|temporarily banned/i.test(String(message));
    if (res.ok) return payload;
    if (rateLimited && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoffMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : /temporarily banned/i.test(String(message))
          ? 60000
          : Math.min(30000, 3000 * Math.pow(2, attempt));
      await sleep(backoffMs);
      continue;
    }
    throw new Error(message);
  }
  throw new Error(`GMGN ${pathname} failed`);
}
```

- [ ] **Step 2: Remove the moved code from `tools/gmgn.js`**

Delete these from `tools/gmgn.js`:
- The two imports at the top: `import { randomUUID } from "crypto";` and
  `import { setDefaultResultOrder } from "dns";`
- The `setDefaultResultOrder("ipv4first");` line and its `// Force IPv4 …` comment.
- `let lastGmgnRequestAt = 0;`
- The `function sleep(ms) {…}` block.
- The `async function paceGmgnRequest() {…}` block.
- The `function getApiKey() {…}` block.
- The `function appendParams(url, params = {}) {…}` block.
- The `async function gmgnFetch(pathname, …) {…}` block.

**Keep** `normalizeInterval` and `SUPPORTED_INTERVALS` — they are used by
`discoverGmgnPools` and are not part of the HTTP client.

- [ ] **Step 3: Add the client import to `tools/gmgn.js`**

At the top of `tools/gmgn.js`, the existing imports become (replace the old crypto/dns
lines; keep config/log/chart-indicators):
```js
import { config } from "../config.js";
import { log } from "../logger.js";
import { gmgnFetch } from "./gmgn-client.js";
import { fetchChartIndicatorsForMint, normalizeIntervals } from "./chart-indicators.js";
```
(`gmgn.js` calls `gmgnFetch` internally; it does not need `paceGmgnRequest` directly.)

- [ ] **Step 4: Verify both modules import cleanly and behavior is intact**

Run: `node -e "Promise.all([import('./tools/gmgn-client.js'), import('./tools/gmgn.js')]).then(([c,g]) => console.log('client:', Object.keys(c).join(','), '| gmgn:', Object.keys(g).join(',')))"`
Expected: `client: paceGmgnRequest,gmgnFetch | gmgn: discoverGmgnPools,formatGmgnCandidateForPrompt` (gmgn.js no longer exports gmgnFetch — that's fine; nothing else imported it from there).

Run: `node --check tools/gmgn.js && node --check tools/gmgn-client.js`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add tools/gmgn-client.js tools/gmgn.js
git commit -m "refactor: extract GMGN HTTP client to gmgn-client.js (breaks import cycle)"
```

---

## Task 2: Resample 1m klines to a target interval (pure function)

Build the pure `resampleKlines` first because it has zero dependencies and is easy to test. It buckets an ascending-by-time array of 1-minute OHLCV candles into N-minute candles.

**Files:**
- Create: `tools/gmgn-indicators.js`
- Test: `tools/gmgn-indicators.test.js`

- [ ] **Step 1: Write the failing test**

Create `tools/gmgn-indicators.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resampleKlines } from "./gmgn-indicators.js";

// Helper: build a 1m candle. time in ms.
const c = (time, open, high, low, close, volume) => ({ time, open, high, low, close, volume });

test("resampleKlines buckets five 1m candles into one 5m candle", () => {
  const base = 1_700_000_000_000; // arbitrary ms aligned to a 5m boundary for the test
  const min = 60_000;
  const ones = [
    c(base + 0 * min, 10, 12, 9, 11, 100),
    c(base + 1 * min, 11, 15, 10, 14, 200),
    c(base + 2 * min, 14, 14, 8, 9, 150),
    c(base + 3 * min, 9, 11, 7, 10, 50),
    c(base + 4 * min, 10, 13, 9, 12, 300),
  ];
  const out = resampleKlines(ones, 5);
  assert.equal(out.length, 1);
  assert.equal(out[0].open, 10);   // first candle's open
  assert.equal(out[0].close, 12);  // last candle's close
  assert.equal(out[0].high, 15);   // max high
  assert.equal(out[0].low, 7);     // min low
  assert.equal(out[0].volume, 800); // sum
});

test("resampleKlines drops an incomplete trailing bucket only if it has zero candles", () => {
  const base = 1_700_000_000_000;
  const min = 60_000;
  // 7 one-minute candles → one full 5m bucket + a partial (2-candle) bucket which we KEEP
  const ones = Array.from({ length: 7 }, (_, i) =>
    c(base + i * min, 10 + i, 20, 5, 10 + i, 10));
  const out = resampleKlines(ones, 5);
  assert.equal(out.length, 2);          // full bucket + partial bucket kept
  assert.equal(out[1].open, 15);        // 6th candle (index 5) opens the partial bucket
  assert.equal(out[1].volume, 20);      // two candles summed
});

test("resampleKlines returns [] for empty input", () => {
  assert.deepEqual(resampleKlines([], 5), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/gmgn-indicators.test.js`
Expected: FAIL — cannot find module `./gmgn-indicators.js` (or `resampleKlines` is not exported).

- [ ] **Step 3: Write minimal implementation**

Create `tools/gmgn-indicators.js`:
```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/gmgn-indicators.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/gmgn-indicators.js tools/gmgn-indicators.test.js
git commit -m "feat: add resampleKlines for GMGN 1m->Nm bucketing"
```

---

## Task 3: RSI (Wilder smoothing, length 2)

Add `computeRsi`. The repo uses RSI length 2 (`config.indicators.rsiLength ?? 2`). Use Wilder's smoothing (the standard RSI), which is what the upstream endpoint uses. Returns the RSI of the **last** candle.

**Files:**
- Modify: `tools/gmgn-indicators.js`
- Test: `tools/gmgn-indicators.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tools/gmgn-indicators.test.js`:
```js
import { computeRsi } from "./gmgn-indicators.js";

test("computeRsi returns 100 for a strictly rising close series", () => {
  const closes = [1, 2, 3, 4, 5, 6, 7, 8];
  const rsi = computeRsi(closes, 2);
  assert.ok(rsi > 99.9, `expected ~100, got ${rsi}`);
});

test("computeRsi returns 0 for a strictly falling close series", () => {
  const closes = [8, 7, 6, 5, 4, 3, 2, 1];
  const rsi = computeRsi(closes, 2);
  assert.ok(rsi < 0.1, `expected ~0, got ${rsi}`);
});

test("computeRsi returns null when not enough data", () => {
  assert.equal(computeRsi([1, 2], 2), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/gmgn-indicators.test.js`
Expected: FAIL — `computeRsi` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `tools/gmgn-indicators.js`:
```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/gmgn-indicators.test.js`
Expected: PASS (now 6 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/gmgn-indicators.js tools/gmgn-indicators.test.js
git commit -m "feat: add Wilder RSI computation"
```

---

## Task 4: Bollinger Bands (period 20, stddev 2)

Add `computeBollinger`, returning the bands for the **last** candle from a closes array. Uses population standard deviation (the standard for Bollinger).

**Files:**
- Modify: `tools/gmgn-indicators.js`
- Test: `tools/gmgn-indicators.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tools/gmgn-indicators.test.js`:
```js
import { computeBollinger } from "./gmgn-indicators.js";

test("computeBollinger on a flat series has zero-width bands at the mean", () => {
  const closes = Array.from({ length: 20 }, () => 100);
  const bb = computeBollinger(closes, 20, 2);
  assert.equal(bb.middle, 100);
  assert.equal(bb.upper, 100);
  assert.equal(bb.lower, 100);
});

test("computeBollinger bands straddle the mean symmetrically", () => {
  const closes = [];
  for (let i = 0; i < 20; i++) closes.push(i % 2 === 0 ? 90 : 110); // mean 100
  const bb = computeBollinger(closes, 20, 2);
  assert.equal(bb.middle, 100);
  assert.ok(bb.upper > 100 && bb.lower < 100);
  assert.ok(Math.abs((bb.upper - 100) - (100 - bb.lower)) < 1e-9);
});

test("computeBollinger returns null when not enough data", () => {
  assert.equal(computeBollinger([1, 2, 3], 20, 2), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/gmgn-indicators.test.js`
Expected: FAIL — `computeBollinger` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `tools/gmgn-indicators.js`:
```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/gmgn-indicators.test.js`
Expected: PASS (now 9 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/gmgn-indicators.js tools/gmgn-indicators.test.js
git commit -m "feat: add Bollinger Bands computation"
```

---

## Task 5: Supertrend (ATR period, multiplier) + break states

Add `computeSupertrend`, returning `{ value, direction, breakUp, breakDown }` for the final candle. This is the most consequential indicator (the gates lean on `direction` and `close >= value`). Standard ATR-based supertrend with Wilder ATR.

**Files:**
- Modify: `tools/gmgn-indicators.js`
- Test: `tools/gmgn-indicators.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tools/gmgn-indicators.test.js`:
```js
import { computeSupertrend } from "./gmgn-indicators.js";

const ohlc = (high, low, close) => ({ high, low, close, open: close });

test("computeSupertrend reports bullish on a sustained uptrend", () => {
  const candles = [];
  for (let i = 0; i < 30; i++) candles.push(ohlc(10 + i + 1, 10 + i - 1, 10 + i));
  const st = computeSupertrend(candles, 10, 3);
  assert.equal(st.direction, "bullish");
  assert.ok(st.value < candles[candles.length - 1].close, "supertrend sits below price in uptrend");
});

test("computeSupertrend reports bearish on a sustained downtrend", () => {
  const candles = [];
  for (let i = 0; i < 30; i++) candles.push(ohlc(100 - i + 1, 100 - i - 1, 100 - i));
  const st = computeSupertrend(candles, 10, 3);
  assert.equal(st.direction, "bearish");
  assert.ok(st.value > candles[candles.length - 1].close, "supertrend sits above price in downtrend");
});

test("computeSupertrend returns null when not enough data", () => {
  assert.equal(computeSupertrend([ohlc(1, 1, 1)], 10, 3), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/gmgn-indicators.test.js`
Expected: FAIL — `computeSupertrend` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `tools/gmgn-indicators.js`:
```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/gmgn-indicators.test.js`
Expected: PASS (now 12 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/gmgn-indicators.js tools/gmgn-indicators.test.js
git commit -m "feat: add ATR Supertrend with break states"
```

---

## Task 6: Fibonacci levels (best-effort) + assemble `computeIndicators`

Add a best-effort `computeFibonacci` (swing high/low over the last N bars) and the orchestrator `computeIndicators(candles, params)` that returns the full `{ latest: {...} }` payload. Fib is approximate by design (spec non-goal) but must be present in the shape.

**Files:**
- Modify: `tools/gmgn-indicators.js`
- Test: `tools/gmgn-indicators.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tools/gmgn-indicators.test.js`:
```js
import { computeIndicators } from "./gmgn-indicators.js";

function syntheticCandles(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const close = 100 + Math.sin(i / 3) * 5 + i * 0.1;
    out.push({ time: 1_700_000_000_000 + i * 60_000, open: close, high: close + 1, low: close - 1, close, volume: 10 });
  }
  return out;
}

test("computeIndicators returns the full latest payload shape", () => {
  const candles = syntheticCandles(60);
  const { latest } = computeIndicators(candles, {
    supertrendPeriod: 10, supertrendMultiplier: 3,
    bollingerPeriod: 20, bollingerStdDev: 2,
    rsiLength: 2, fibLookbackBars: 55,
  });
  // Required fields every consumer reads:
  assert.ok(latest.candle && typeof latest.candle.close === "number");
  assert.ok(latest.previousCandle && typeof latest.previousCandle.close === "number");
  assert.ok(latest.rsi && typeof latest.rsi.value === "number");
  assert.ok(latest.bollinger && typeof latest.bollinger.upper === "number");
  assert.ok(typeof latest.bollinger.lower === "number");
  assert.ok(typeof latest.bollinger.middle === "number");
  assert.ok(latest.supertrend && typeof latest.supertrend.value === "number");
  assert.ok(["bullish", "bearish"].includes(latest.supertrend.direction));
  assert.ok(latest.states && typeof latest.states.supertrendBreakUp === "boolean");
  assert.ok(typeof latest.states.supertrendBreakDown === "boolean");
  assert.ok(latest.fibonacci && latest.fibonacci.levels);
  assert.ok("0.618" in latest.fibonacci.levels);
});

test("computeIndicators throws on insufficient candles", () => {
  assert.throws(() => computeIndicators(syntheticCandles(5), {
    supertrendPeriod: 10, supertrendMultiplier: 3,
    bollingerPeriod: 20, bollingerStdDev: 2, rsiLength: 2, fibLookbackBars: 55,
  }), /insufficient/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/gmgn-indicators.test.js`
Expected: FAIL — `computeIndicators` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `tools/gmgn-indicators.js`:
```js
// Best-effort Fibonacci retracement levels from the swing high/low of the last N bars.
// Approximate by design (the upstream feed may anchor swings differently). Present so
// the payload shape is complete; the fibo_* presets are not in active use.
export function computeFibonacci(candles, lookbackBars = 55) {
  const window = candles.slice(-Math.max(2, lookbackBars));
  const high = Math.max(...window.map((c) => c.high));
  const low = Math.min(...window.map((c) => c.low));
  const span = high - low;
  const level = (ratio) => high - span * ratio;
  return {
    levels: {
      "0.236": level(0.236),
      "0.382": level(0.382),
      "0.500": level(0.5),
      "0.618": level(0.618),
      "0.786": level(0.786),
    },
  };
}

// Orchestrate all indicators into the payload shape consumers expect.
// Throws if there is insufficient data to compute the core indicators — the seam
// catches this and falls back to the Meridian endpoint.
export function computeIndicators(candles, params) {
  if (!Array.isArray(candles) || candles.length < 2) {
    throw new Error("insufficient kline data for indicators");
  }
  const closes = candles.map((c) => c.close);
  const supertrend = computeSupertrend(candles, params.supertrendPeriod, params.supertrendMultiplier);
  const bollinger = computeBollinger(closes, params.bollingerPeriod, params.bollingerStdDev);
  const rsi = computeRsi(closes, params.rsiLength);
  if (!supertrend || !bollinger || rsi == null) {
    throw new Error("insufficient kline data for indicators");
  }
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  return {
    latest: {
      candle: { open: last.open, high: last.high, low: last.low, close: last.close },
      previousCandle: { close: prev.close },
      rsi: { value: rsi },
      bollinger: { upper: bollinger.upper, middle: bollinger.middle, lower: bollinger.lower },
      supertrend: { value: supertrend.value, direction: supertrend.direction },
      states: {
        supertrendBreakUp: supertrend.breakUp,
        supertrendBreakDown: supertrend.breakDown,
      },
      fibonacci: computeFibonacci(candles, params.fibLookbackBars),
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/gmgn-indicators.test.js`
Expected: PASS (now 14 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/gmgn-indicators.js tools/gmgn-indicators.test.js
git commit -m "feat: add fibonacci + computeIndicators payload assembly"
```

---

## Task 7: Kline fetch + per-mint TTL cache + `fetchGmgnIndicatorPayload`

Add the network layer: fetch 1m klines (limit 300) via the shared throttle, cache per-mint with a TTL so the 5m and 15m calls for the same mint reuse one fetch, and the top-level `fetchGmgnIndicatorPayload` that maps an interval string → minutes → resample → computeIndicators.

**Files:**
- Modify: `tools/gmgn-indicators.js`
- Test: `tools/gmgn-indicators.test.js`

- [ ] **Step 1: Write the failing test (cache behavior with an injected fetcher)**

Append to `tools/gmgn-indicators.test.js`:
```js
import { fetchGmgnIndicatorPayload, __setKlineFetcherForTest, __clearKlineCacheForTest } from "./gmgn-indicators.js";

function fakeKlines(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const close = 100 + Math.sin(i / 5) * 3 + i * 0.05;
    out.push({ time: 1_700_000_000_000 + i * 60_000, open: close, high: close + 0.5, low: close - 0.5, close, volume: 5 });
  }
  return out;
}

test("fetchGmgnIndicatorPayload reuses one fetch for 5m and 15m within TTL", async () => {
  __clearKlineCacheForTest();
  let calls = 0;
  __setKlineFetcherForTest(async () => { calls += 1; return fakeKlines(300); });

  const five = await fetchGmgnIndicatorPayload("MINT1", { interval: "5_MINUTE", rsiLength: 2 });
  const fifteen = await fetchGmgnIndicatorPayload("MINT1", { interval: "15_MINUTE", rsiLength: 2 });

  assert.equal(calls, 1, "second interval should hit the per-mint cache");
  assert.ok(five.latest.supertrend.value > 0);
  assert.ok(fifteen.latest.supertrend.value > 0);
  __setKlineFetcherForTest(null); // restore real fetcher
});

test("fetchGmgnIndicatorPayload throws when the feed returns too few candles", async () => {
  __clearKlineCacheForTest();
  __setKlineFetcherForTest(async () => fakeKlines(3));
  await assert.rejects(
    () => fetchGmgnIndicatorPayload("MINT2", { interval: "5_MINUTE", rsiLength: 2 }),
    /insufficient/i,
  );
  __setKlineFetcherForTest(null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/gmgn-indicators.test.js`
Expected: FAIL — `fetchGmgnIndicatorPayload` / test hooks not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `tools/gmgn-indicators.js` (note the imports at the very TOP of the file — move these to the existing import region if you prefer, but they must be at module top-level):
```js
import { config } from "../config.js";
import { gmgnFetch } from "./gmgn-client.js";   // leaf client — NOT gmgn.js (avoids import cycle)

const INTERVAL_MINUTES = { "5_MINUTE": 5, "15_MINUTE": 15 };
const KLINE_LIMIT = 300; // 298 warmup + headroom

// Default indicator params; overridden by config.gmgn.indicatorParams.
export const DEFAULT_INDICATOR_PARAMS = {
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  bollingerPeriod: 20,
  bollingerStdDev: 2,
  fibLookbackBars: 55,
  klineCacheTtlSec: 30,
};

function indicatorParams() {
  return { ...DEFAULT_INDICATOR_PARAMS, ...(config.gmgn?.indicatorParams || {}) };
}

// Per-mint 1m-kline cache: Map<mint, { klines, ts }>. In-memory, TTL-bounded, no disk.
const klineCache = new Map();

// Injectable fetcher for tests. When null, the real GMGN fetch is used.
let klineFetcher = null;
export function __setKlineFetcherForTest(fn) { klineFetcher = fn; }
export function __clearKlineCacheForTest() { klineCache.clear(); }

async function realFetch1mKlines(mint) {
  const payload = await gmgnFetch("/v1/market/token_kline", {
    params: { chain: "sol", address: mint, resolution: "1m", limit: KLINE_LIMIT },
  });
  const list =
    payload?.data?.list ?? payload?.list ?? payload?.data ?? [];
  if (!Array.isArray(list)) return [];
  // Normalize to numbers, ascending by time.
  return list
    .map((k) => ({
      time: Number(k.time),
      open: Number(k.open),
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
      volume: Number(k.volume),
    }))
    .filter((k) => Number.isFinite(k.time) && Number.isFinite(k.close))
    .sort((a, b) => a.time - b.time);
}

async function getCached1mKlines(mint) {
  const ttlMs = Math.max(0, Number(indicatorParams().klineCacheTtlSec)) * 1000;
  const hit = klineCache.get(mint);
  if (hit && ttlMs > 0 && Date.now() - hit.ts < ttlMs) return hit.klines;
  const fetcher = klineFetcher || realFetch1mKlines;
  const klines = await fetcher(mint);
  klineCache.set(mint, { klines, ts: Date.now() });
  return klines;
}

// Top-level: produce the Meridian-shaped { latest } payload from GMGN klines.
// Throws on insufficient data or fetch failure — caller (the seam) falls back.
export async function fetchGmgnIndicatorPayload(mint, { interval, rsiLength } = {}) {
  const minutes = INTERVAL_MINUTES[String(interval || "").trim().toUpperCase()] || 5;
  const klines1m = await getCached1mKlines(mint);
  if (!Array.isArray(klines1m) || klines1m.length === 0) {
    throw new Error("GMGN returned empty kline list");
  }
  const resampled = resampleKlines(klines1m, minutes);
  const params = { ...indicatorParams(), rsiLength: Number(rsiLength) || 2 };
  return computeIndicators(resampled, params);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/gmgn-indicators.test.js`
Expected: PASS (now 16 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/gmgn-indicators.js tools/gmgn-indicators.test.js
git commit -m "feat: add cached GMGN kline fetch + indicator payload entry point"
```

---

## Task 8: Config — `indicatorSource` + `indicatorParams`

Wire the two new config keys into `config.gmgn`, defaulting to today's behavior.

**Files:**
- Modify: `config.js` (in the `gmgn:` block, after line 157 `indicatorFilter`)
- Modify: `gmgn-config.json`

- [ ] **Step 1: Add the keys in config.js**

In `tools/../config.js`, inside the `gmgn: {` object, immediately after the `indicatorFilter:` line (currently line 157), add:
```js
    // Indicator candle source: "meridian" (default, existing endpoint) | "gmgn" (compute
    // from GMGN klines, auto-falling back to meridian on any failure).
    indicatorSource: gmgnValue("indicatorSource", "gmgnIndicatorSource", "meridian"),
    indicatorParams: {
      supertrendPeriod: 10,
      supertrendMultiplier: 3,
      bollingerPeriod: 20,
      bollingerStdDev: 2,
      fibLookbackBars: 55,
      klineCacheTtlSec: 30,
      ...(gmgnUserConfig.indicatorParams || {}),
    },
```

- [ ] **Step 2: Add the default to gmgn-config.json**

In `gmgn-config.json`, add a top-level key (e.g. after `"indicatorFilter": true,`):
```json
  "indicatorSource": "meridian",
```
(Leave `indicatorParams` out of the file for now — the baked-in defaults apply. Document that it can be added.)

- [ ] **Step 3: Verify config loads and resolves the default**

Run: `node -e "import('./config.js').then(({config}) => { console.log('source=', config.gmgn.indicatorSource); console.log('stPeriod=', config.gmgn.indicatorParams.supertrendPeriod); })"`
Expected: `source= meridian` and `stPeriod= 10`.

- [ ] **Step 4: Commit**

```bash
git add config.js gmgn-config.json
git commit -m "feat: add indicatorSource + indicatorParams config (default meridian)"
```

---

## Task 9: Wire the seam — dispatcher + auto-fallback

Rename the existing `fetchChartIndicatorsForMint` body to `fetchMeridianIndicatorPayload`, and make `fetchChartIndicatorsForMint` dispatch on `config.gmgn.indicatorSource`, falling back to Meridian on any GMGN error.

**Files:**
- Modify: `tools/chart-indicators.js:248-279` (the existing `fetchChartIndicatorsForMint`)
- Test: `tools/chart-indicators.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tools/chart-indicators.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";

// We test the dispatcher's fallback by pointing the GMGN path at a fetcher that throws,
// and stubbing the Meridian fetch via a global fetch override.
import { fetchChartIndicatorsForMint } from "./chart-indicators.js";
import { __setKlineFetcherForTest, __clearKlineCacheForTest } from "./gmgn-indicators.js";
import { config } from "../config.js";

test("fetchChartIndicatorsForMint falls back to meridian when GMGN throws", async () => {
  __clearKlineCacheForTest();
  __setKlineFetcherForTest(async () => { throw new Error("simulated GMGN outage"); });
  const prevSource = config.gmgn.indicatorSource;
  config.gmgn.indicatorSource = "gmgn";

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async text() {
      return JSON.stringify({ latest: { candle: { close: 42 }, supertrend: { value: 1, direction: "bullish" } } });
    },
  });

  try {
    const payload = await fetchChartIndicatorsForMint("MINTX", { interval: "5_MINUTE" });
    assert.equal(payload.latest.candle.close, 42, "should have returned the meridian payload");
  } finally {
    globalThis.fetch = realFetch;
    config.gmgn.indicatorSource = prevSource;
    __setKlineFetcherForTest(null);
  }
});

test("fetchChartIndicatorsForMint uses meridian directly when source=meridian", async () => {
  const prevSource = config.gmgn.indicatorSource;
  config.gmgn.indicatorSource = "meridian";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async text() { return JSON.stringify({ latest: { candle: { close: 7 } } }); },
  });
  try {
    const payload = await fetchChartIndicatorsForMint("MINTY", { interval: "5_MINUTE" });
    assert.equal(payload.latest.candle.close, 7);
  } finally {
    globalThis.fetch = realFetch;
    config.gmgn.indicatorSource = prevSource;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/chart-indicators.test.js`
Expected: FAIL — fallback not implemented (the GMGN throw propagates, or source isn't checked).

- [ ] **Step 3: Implement the dispatcher**

In `tools/chart-indicators.js`:

(a) Add imports near the top (after the existing `import { log } from "./logger.js";`):
```js
import { fetchGmgnIndicatorPayload } from "./gmgn-indicators.js";
```

(b) Rename the existing exported function. Change line 248 from:
```js
export async function fetchChartIndicatorsForMint(
```
to:
```js
async function fetchMeridianIndicatorPayload(
```

(c) Immediately ABOVE that renamed function, add the new dispatcher:
```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/chart-indicators.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the whole suite to confirm nothing regressed**

Run: `node --test tools/`
Expected: PASS (all tests across `gmgn-indicators.test.js` + `chart-indicators.test.js`).

- [ ] **Step 6: Commit**

```bash
git add tools/chart-indicators.js tools/chart-indicators.test.js
git commit -m "feat: dispatch chart indicators by source with auto-fallback to meridian"
```

---

## Task 10: #3 efficiency — concurrent 24h fetch + stamp in `pickBestPool`

Fetch the `timeframe=24h` pool detail concurrently with the existing detail fetch in `pickBestPool`, and stamp `fee_tvl_ratio_24h` onto the returned candidate so the screening 24h gate can skip its re-fetch.

**Files:**
- Modify: `tools/gmgn.js` — `pickBestPool` and `condenseGmgnCandidate`, and the Stage-5
  call site in `discoverGmgnPools`. (Line numbers shifted up ~80 after Task 1 — locate by
  function name; the quoted code below is the anchor.)
- Modify: `tools/screening.js` — the 24h gate block inside `getTopCandidates` (the
  `if (minFeeTvl24h != null && eligible.length > 0)` block).

- [ ] **Step 1: Stamp the 24h ratio through pickBestPool**

In `tools/gmgn.js`, in `pickBestPool`, after `chosenDetail` is determined and before the `return`, add a concurrent 24h fetch. Replace the final `return { pool: chosenPool, detail: chosenDetail, volatilityDetail, volatilityTimeframe };` with:
```js
  const detail24h = chosenPool
    ? await fetchPoolDetailDirect(chosenPool.address || chosenPool.pool_address, "24h").catch(() => null)
    : null;
  const feeTvlRatio24h = Number.isFinite(Number(detail24h?.fee_tvl_ratio))
    ? Number(Number(detail24h.fee_tvl_ratio).toFixed(2))
    : null;

  return { pool: chosenPool, detail: chosenDetail, volatilityDetail, volatilityTimeframe, feeTvlRatio24h };
```

- [ ] **Step 2: Carry the stamp into the candidate**

In `tools/gmgn.js`, update `condenseGmgnCandidate` to accept and emit it.

(a) Change its destructured signature to add `feeTvlRatio24h = null`:
```js
function condenseGmgnCandidate({ token, pool, poolDetail, volatilityDetail = poolDetail, volatilityTimeframe = MIN_VOLATILITY_TIMEFRAME, security, info, infoAnalysis, holdersAnalysis, indicatorSignal, feeTvlRatio24h = null }) {
```

(b) In the returned object, just after the `fee_active_tvl_ratio:` line, add:
```js
    fee_tvl_ratio_24h: feeTvlRatio24h,
```

(c) At the Stage-5 call site in `discoverGmgnPools` (the `await pickBestPool(...)` line), thread the value through. Change:
```js
      const { pool, detail: poolDetail, volatilityDetail, volatilityTimeframe } = await pickBestPool(topPools, config.screening.timeframe);
```
to:
```js
      const { pool, detail: poolDetail, volatilityDetail, volatilityTimeframe, feeTvlRatio24h } = await pickBestPool(topPools, config.screening.timeframe);
```
and change the `condenseGmgnCandidate({ ... })` call (line 726) to include `feeTvlRatio24h`:
```js
      const candidate = condenseGmgnCandidate({ token, pool, poolDetail, volatilityDetail, volatilityTimeframe, security, info, infoAnalysis: infoCheck, holdersAnalysis: holdersCheck, indicatorSignal, feeTvlRatio24h });
```

- [ ] **Step 3: Make the screening 24h gate prefer the stamp**

In `tools/screening.js`, in the 24h gate block, replace the fetch loop so already-stamped candidates skip the network call. Change this:
```js
    const detail24h = await Promise.allSettled(
      eligible.map((p) => fetchPoolDiscoveryDetail({ poolAddress: p.pool, timeframe: "24h" })),
    );
    for (let i = 0; i < eligible.length; i++) {
      const r = detail24h[i];
      const ratio = r.status === "fulfilled" ? numeric(r.value?.fee_tvl_ratio) : null;
      eligible[i].fee_tvl_ratio_24h = ratio != null ? Number(ratio.toFixed(2)) : null;
    }
```
to:
```js
    // Prefer a value already stamped upstream (GMGN pickBestPool); only fetch for
    // candidates that lack it (e.g. the Meteora source path).
    const needFetch = eligible.filter((p) => p.fee_tvl_ratio_24h == null);
    const fetched = await Promise.allSettled(
      needFetch.map((p) => fetchPoolDiscoveryDetail({ poolAddress: p.pool, timeframe: "24h" })),
    );
    for (let i = 0; i < needFetch.length; i++) {
      const r = fetched[i];
      const ratio = r.status === "fulfilled" ? numeric(r.value?.fee_tvl_ratio) : null;
      needFetch[i].fee_tvl_ratio_24h = ratio != null ? Number(ratio.toFixed(2)) : null;
    }
```

- [ ] **Step 4: Verify both modules still import cleanly**

Run: `node -e "Promise.all([import('./tools/gmgn.js'), import('./tools/screening.js')]).then(() => console.log('imports OK')).catch(e => { console.error(e); process.exit(1); })"`
Expected: `imports OK`.

- [ ] **Step 5: Commit**

```bash
git add tools/gmgn.js tools/screening.js
git commit -m "perf: fetch 24h fee/TVL concurrently in pickBestPool, skip re-fetch in gate"
```

---

## Task 11: Parity validation script (manual dev tool)

A standalone script comparing GMGN vs Meridian decision-level agreement on a sample of mints. Not wired into the agent.

**Files:**
- Create: `scripts/validate-gmgn-indicators.js`

- [ ] **Step 1: Write the script**

Create `scripts/validate-gmgn-indicators.js`:
```js
// Manual parity check: GMGN-computed indicators vs the Meridian endpoint, on the
// decisions that gate logic actually uses. NOT wired into the agent.
//
// Usage:
//   node scripts/validate-gmgn-indicators.js <mint> [<mint> ...]
//   node scripts/validate-gmgn-indicators.js            (pulls a live screen sample)
import "dotenv/config";
import { config } from "../config.js";
import { fetchGmgnIndicatorPayload } from "../tools/gmgn-indicators.js";

// Import the private meridian fetch by temporarily forcing source=meridian through the seam.
import { fetchChartIndicatorsForMint } from "../tools/chart-indicators.js";

const INTERVALS = ["5_MINUTE", "15_MINUTE"];

function rsiZone(v) {
  if (v == null) return "n/a";
  const os = config.indicators?.rsiOversold ?? 30;
  const ob = config.indicators?.rsiOverbought ?? 80;
  if (v <= os) return "oversold";
  if (v >= ob) return "overbought";
  return "neutral";
}
function bbPos(close, bb) {
  if (close == null || !bb) return "n/a";
  if (bb.upper != null && close > bb.upper) return "above";
  if (bb.lower != null && close < bb.lower) return "below";
  return "inside";
}
function decisions(latest) {
  const close = latest?.candle?.close ?? null;
  const st = latest?.supertrend || {};
  return {
    direction: st.direction ?? null,
    aboveST: close != null && st.value != null ? close >= st.value : null,
    breakUp: !!latest?.states?.supertrendBreakUp,
    rsiZone: rsiZone(latest?.rsi?.value ?? null),
    bbPos: bbPos(close, latest?.bollinger),
  };
}

async function meridianPayload(mint, interval) {
  const prev = config.gmgn.indicatorSource;
  config.gmgn.indicatorSource = "meridian";
  try {
    return await fetchChartIndicatorsForMint(mint, { interval, refresh: true });
  } finally {
    config.gmgn.indicatorSource = prev;
  }
}

async function getSampleMints() {
  if (process.argv.length > 2) return process.argv.slice(2);
  const { discoverGmgnPools } = await import("../tools/gmgn.js");
  const { pools } = await discoverGmgnPools({ limit: 15 });
  return pools.map((p) => p.base?.mint).filter(Boolean);
}

async function main() {
  const mints = await getSampleMints();
  if (mints.length === 0) { console.log("No mints to validate."); return; }

  const tally = {};
  const keys = ["direction", "aboveST", "breakUp", "rsiZone", "bbPos"];
  for (const k of keys) tally[k] = { agree: 0, total: 0 };

  for (const mint of mints) {
    for (const interval of INTERVALS) {
      let g, m;
      try {
        g = decisions((await fetchGmgnIndicatorPayload(mint, { interval, rsiLength: config.indicators?.rsiLength ?? 2 })).latest);
        m = decisions((await meridianPayload(mint, interval)).latest);
      } catch (e) {
        console.log(`skip ${mint.slice(0, 8)} ${interval}: ${e.message}`);
        continue;
      }
      for (const k of keys) {
        tally[k].total += 1;
        if (g[k] === m[k]) tally[k].agree += 1;
      }
      console.log(`${mint.slice(0, 8)} ${interval}: gmgn=${JSON.stringify(g)} meridian=${JSON.stringify(m)}`);
    }
  }

  console.log("\n=== Decision-level agreement ===");
  for (const k of keys) {
    const { agree, total } = tally[k];
    const pct = total ? ((agree / total) * 100).toFixed(1) : "n/a";
    console.log(`${k.padEnd(10)} ${agree}/${total} (${pct}%)`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Smoke-test it parses and runs (no network assertion)**

Run: `node --check scripts/validate-gmgn-indicators.js`
Expected: no output, exit 0 (syntax valid). Running it for real (`node scripts/validate-gmgn-indicators.js <mint>`) requires live API keys and is a manual step for the user.

- [ ] **Step 3: Commit**

```bash
git add scripts/validate-gmgn-indicators.js
git commit -m "feat: add GMGN vs meridian indicator parity validation script"
```

---

## Task 12: Documentation

Document the switch in CLAUDE.md so future sessions know it exists.

**Files:**
- Modify: `CLAUDE.md` (Model Configuration / new section near the indicator/lessons areas)

- [ ] **Step 1: Add a docs section**

In `CLAUDE.md`, add a new section (e.g. after "## Base Fee Calculation (dlmm.js)"):
```markdown
## Chart Indicator Source (gmgn-config.json)

`fetchChartIndicatorsForMint` (tools/chart-indicators.js) dispatches on
`config.gmgn.indicatorSource`:
- `"meridian"` (default) — precomputed indicators from `api.agentmeridian.xyz` (unchanged legacy path).
- `"gmgn"` — computes supertrend/RSI/Bollinger from GMGN 1m klines (tools/gmgn-indicators.js),
  resampled to 5m/15m. Falls back to meridian on ANY failure (rate-limit, network, empty data),
  so worst case == legacy behavior.

Flip via `gmgn-config.json` (`"indicatorSource": "gmgn"`) or `/setcfg gmgnIndicatorSource gmgn`.
Math params live in `config.gmgn.indicatorParams` (baked-in defaults; override in gmgn-config.json).
1m klines are fetched once per mint per cycle (in-memory TTL cache, `klineCacheTtlSec`) and
resampled locally to both intervals — one GMGN call covers 5m and 15m.

Validate parity before flipping: `node scripts/validate-gmgn-indicators.js [<mint>...]`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document GMGN chart indicator source switch"
```

---

## Final verification

- [ ] **Run the full test suite**

Run: `node --test tools/`
Expected: PASS — all tests in `gmgn-indicators.test.js` (16) and `chart-indicators.test.js` (2).

- [ ] **Confirm default behavior unchanged**

Run: `node -e "import('./config.js').then(({config}) => console.log('indicatorSource =', config.gmgn.indicatorSource))"`
Expected: `indicatorSource = meridian` (the agent behaves exactly as before until you flip it).

- [ ] **Manual parity run (user, with live keys)**

Run: `node scripts/validate-gmgn-indicators.js`
Expected: per-signal agreement table. Tune `config.gmgn.indicatorParams` and re-run if `direction` / `aboveST` / `bbPos` agreement is low, before setting `indicatorSource: "gmgn"` in production.

---

## Notes on parity tuning (for whoever runs Task's final step)

The baked-in defaults (Supertrend 10/3, BB 20/2, RSI Wilder len 2) are the standard
TradingView parameters and the most likely match for the upstream endpoint. If the
validation script shows low agreement on `direction` or `aboveST`, the most likely
culprits in order: (1) supertrend multiplier (try 2 or 3), (2) supertrend ATR period
(try 7 or 14), (3) whether the upstream uses HL2 vs close for the basic bands. Adjust
via `gmgn-config.json` → `indicatorParams` and re-run; no code change needed.
```
