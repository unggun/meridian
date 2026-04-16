# Night-Mode Protection + Winner Cooldown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the two biggest sources of loss surfaced by 48-close analysis: re-deploys into recent winners (5/5 big losses were re-deploys after wins) and sleep-window deploys (17-23 UTC had avg -6.72% vs +1.50% rest of day).

**Architecture:** Two independent layers. (1) **Winner cooldown** — when a pool's last close was a win, block re-deploy into it for N hours. Implemented in `pool-memory.js:recordPoolDeploy` alongside existing OOR/bad-PnL cooldowns; enforced by existing `isPoolOnCooldown`. (2) **Night mode** — a time-of-day-aware config resolver. Between `nightModeStartUtc` and `nightModeEndUtc`, the stop loss tightens and a max-volatility filter activates. Implemented as a `getEffectiveManagementConfig()` helper used at the stop-loss check site and a new volatility safety check in `runSafetyChecks`.

**Tech Stack:** Node 22, ESM (`"type": "module"`). Tests are plain Node scripts in `test/` that exit non-zero on failure (see `test/test-bad-pnl-cooldown.js` for the pattern). No test framework.

**Runtime:** Bot runs under `pm2` as process `meridian`. Restart with `pm2 restart meridian --update-env` after final task.

---

## File Structure

- `config.js` — add `winnerCooldownHours`, `winnerCooldownMinPnlPct`, `nightModeStartUtc`, `nightModeEndUtc`, `nightStopLossPct`, `nightMaxVolatility` under `management`. Add `getEffectiveManagementConfig(now?)` export.
- `user-config.example.json` — document the new keys with defaults.
- `user-config.json` — set `stopLossPct: -12`, add night-mode keys, add winner cooldown keys.
- `pool-memory.js` — add winner-cooldown block inside `recordPoolDeploy`, after the existing bad-pnl block.
- `state.js` — stop-loss check reads from `getEffectiveManagementConfig()` instead of `mgmtConfig` directly.
- `tools/executor.js` — in `runSafetyChecks` for `deploy_position`, add volatility cap check using `getEffectiveManagementConfig().maxVolatility`.
- `tools/definitions.js` — extend config key whitelist in the `update_config` tool description.
- `test/test-winner-cooldown.js` — new, covers winner cooldown trigger + non-trigger cases.
- `test/test-effective-config.js` — new, covers night-mode time resolution + day fallback.
- `CLAUDE.md` — update config table, add "Night Mode" section, update "Position Lifecycle" to mention winner cooldown.

---

## Task 1: Add winner cooldown config keys

**Files:**
- Modify: `config.js:52-80` (management block)
- Modify: `user-config.example.json`

- [ ] **Step 1: Add config defaults**

In `config.js`, add these two lines inside the `management: {` block, immediately after the existing `badPnlCooldownHours` line:

```js
    winnerCooldownHours:        u.winnerCooldownHours        ?? 6,
    winnerCooldownMinPnlPct:    u.winnerCooldownMinPnlPct    ?? 0,   // cool pool if last close pnl_pct > this
```

- [ ] **Step 2: Document in example config**

In `user-config.example.json`, immediately after the `badPnlCooldownHours` entry, add:

```json
  "winnerCooldownHours": 6,
  "winnerCooldownMinPnlPct": 0,
```

- [ ] **Step 3: Commit**

```bash
git add config.js user-config.example.json
git commit -m "feat: add winnerCooldownHours/winnerCooldownMinPnlPct config keys"
```

---

## Task 2: Winner cooldown — failing test first

**Files:**
- Create: `test/test-winner-cooldown.js`

- [ ] **Step 1: Write the failing test**

```js
// Verify winner cooldown fires after a winning close above the threshold.
// Backs up pool-memory.json before running, restores on exit.
import fs from "fs";

const POOL_FILE = "./pool-memory.json";
const BACKUP = fs.readFileSync(POOL_FILE, "utf8");

let exitCode = 0;
function fail(msg) { console.error("FAIL:", msg); exitCode = 1; }
function ok(msg)   { console.log("PASS:", msg); }

try {
  fs.writeFileSync(POOL_FILE, "{}");

  const { recordPoolDeploy, isPoolOnCooldown } = await import("../pool-memory.js");
  const { config } = await import("../config.js");

  if (config.management.winnerCooldownHours !== 6) fail(`winnerCooldownHours expected 6, got ${config.management.winnerCooldownHours}`);
  if (config.management.winnerCooldownMinPnlPct !== 0) fail(`winnerCooldownMinPnlPct expected 0, got ${config.management.winnerCooldownMinPnlPct}`);
  ok("config keys loaded");

  const winPool  = "WIN_POOL_ADDR_111111111111";
  const lossPool = "LOSS_POOL_ADDR_22222222222";

  // Winner case — single +5% close should trigger winner cooldown
  recordPoolDeploy(winPool, {
    pool_name: "WIN-SOL", base_mint: "WIN_MINT",
    pnl_pct: 5, close_reason: "Take profit", strategy: "spot",
  });
  if (!isPoolOnCooldown(winPool)) fail("Winner pool SHOULD be on cooldown after +5% close");
  else ok("winner cooldown fires on +5% close");

  // Loss case — single -10% close should NOT trigger winner cooldown
  recordPoolDeploy(lossPool, {
    pool_name: "LOSS-SOL", base_mint: "LOSS_MINT",
    pnl_pct: -10, close_reason: "Stop loss", strategy: "spot",
  });
  if (isPoolOnCooldown(lossPool)) fail("Loss pool should NOT be on winner cooldown");
  else ok("winner cooldown does NOT fire on losing close");

  // Edge case — pnl_pct == winnerCooldownMinPnlPct should NOT trigger (strict greater-than)
  const edgePool = "EDGE_POOL_ADDR_33333333333";
  recordPoolDeploy(edgePool, {
    pool_name: "EDGE-SOL", base_mint: "EDGE_MINT",
    pnl_pct: 0, close_reason: "flat", strategy: "spot",
  });
  if (isPoolOnCooldown(edgePool)) fail("Edge pnl==threshold should NOT cool down");
  else ok("winner cooldown uses strict > threshold");
} finally {
  fs.writeFileSync(POOL_FILE, BACKUP);
}
process.exit(exitCode);
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node test/test-winner-cooldown.js
```

Expected: FAIL on "Winner pool SHOULD be on cooldown after +5% close" (the winner cooldown isn't implemented yet; only OOR-repeated, low-yield, and bad-pnl cooldowns exist).

---

## Task 3: Implement winner cooldown

**Files:**
- Modify: `pool-memory.js` — insert new block inside `recordPoolDeploy`, immediately after the bad-PnL cooldown block (currently ends at the line `}` before `save(db);` around line 188).

- [ ] **Step 1: Add winner cooldown block**

In `pool-memory.js`, find this block (the bad-PnL cooldown):

```js
  const badPnlTriggerCount = config.management.badPnlCooldownTriggerCount ?? 3;
  const badPnlMinAvgPct    = config.management.badPnlCooldownMinAvgPct    ?? 1;
  const badPnlHours        = config.management.badPnlCooldownHours        ?? 24;
  const recentWithPnl = entry.deploys.slice(-badPnlTriggerCount).filter((d) => d.pnl_pct != null);
  if (recentWithPnl.length >= badPnlTriggerCount) {
    const avgRecent = recentWithPnl.reduce((s, d) => s + d.pnl_pct, 0) / recentWithPnl.length;
    if (avgRecent < badPnlMinAvgPct) {
      const reason = `low avg pnl (${avgRecent.toFixed(2)}% over last ${badPnlTriggerCount} deploys)`;
      const cooldownUntil = setPoolCooldown(entry, badPnlHours, reason);
      log("pool-memory", `Cooldown set for ${entry.name} until ${cooldownUntil} (${reason})`);
    }
  }
```

Immediately after it (before `save(db);`), insert:

```js
  // Winner cooldown — don't redeploy into a pool whose last close was a win.
  // Data showed 100% of double-digit losses were re-deploys into recent-winner pools.
  const winnerCooldownHours   = config.management.winnerCooldownHours   ?? 6;
  const winnerCooldownMinPnl  = config.management.winnerCooldownMinPnlPct ?? 0;
  if (winnerCooldownHours > 0 && deploy.pnl_pct != null && deploy.pnl_pct > winnerCooldownMinPnl) {
    // Only override if no stronger cooldown is already active (longer expiry wins).
    const existing = entry.cooldown_until ? new Date(entry.cooldown_until).getTime() : 0;
    const candidate = Date.now() + winnerCooldownHours * 60 * 60 * 1000;
    if (candidate > existing) {
      const reason = `winner cooldown (last close +${deploy.pnl_pct}%)`;
      const cooldownUntil = setPoolCooldown(entry, winnerCooldownHours, reason);
      log("pool-memory", `Cooldown set for ${entry.name} until ${cooldownUntil} (${reason})`);
    }
  }
```

- [ ] **Step 2: Run test to verify it passes**

```bash
node test/test-winner-cooldown.js
```

Expected: 4 PASS lines, exit 0.

- [ ] **Step 3: Also run the pre-existing bad-pnl test to verify no regression**

```bash
node test/test-bad-pnl-cooldown.js
```

Expected: all PASS, exit 0.

- [ ] **Step 4: Commit**

```bash
git add pool-memory.js test/test-winner-cooldown.js
git commit -m "feat: add winner cooldown to pool-memory"
```

---

## Task 4: Add night-mode config keys

**Files:**
- Modify: `config.js:52-80`
- Modify: `user-config.example.json`

- [ ] **Step 1: Add night-mode defaults to config.js**

Inside the `management: {` block, after the `winnerCooldownMinPnlPct` line added in Task 1, add:

```js
    nightModeStartUtc:          u.nightModeStartUtc          ?? null,  // e.g. 17 enables night mode 17:00 UTC
    nightModeEndUtc:            u.nightModeEndUtc            ?? null,  // e.g. 23 disables at 23:00 UTC (exclusive)
    nightStopLossPct:           u.nightStopLossPct           ?? null,  // overrides stopLossPct during night window
    nightMaxVolatility:         u.nightMaxVolatility         ?? null,  // blocks deploys with volatility >= this at night
    maxVolatility:              u.maxVolatility              ?? null,  // day/always cap; null = no cap
```

- [ ] **Step 2: Document in example config**

In `user-config.example.json`, after `winnerCooldownMinPnlPct`, add:

```json
  "nightModeStartUtc": 17,
  "nightModeEndUtc": 23,
  "nightStopLossPct": -8,
  "nightMaxVolatility": 2,
  "maxVolatility": null,
```

- [ ] **Step 3: Commit**

```bash
git add config.js user-config.example.json
git commit -m "feat: add night-mode config keys"
```

---

## Task 5: `getEffectiveManagementConfig()` — failing test first

**Files:**
- Create: `test/test-effective-config.js`

- [ ] **Step 1: Write the failing test**

```js
// Verify night-mode effective config resolution.
// Uses an injectable "now" so we don't depend on wall clock.
let exitCode = 0;
function fail(msg) { console.error("FAIL:", msg); exitCode = 1; }
function ok(msg)   { console.log("PASS:", msg); }

const { getEffectiveManagementConfig, config } = await import("../config.js");

// Baseline check: function exists
if (typeof getEffectiveManagementConfig !== "function") {
  fail("getEffectiveManagementConfig is not exported");
  process.exit(1);
}

// Save originals so we can restore
const saved = { ...config.management };
Object.assign(config.management, {
  stopLossPct: -12,
  maxVolatility: null,
  nightModeStartUtc: 17,
  nightModeEndUtc: 23,
  nightStopLossPct: -8,
  nightMaxVolatility: 2,
});

try {
  // Daytime: 10:00 UTC → day values
  const day = getEffectiveManagementConfig(new Date("2026-04-16T10:00:00Z"));
  if (day.stopLossPct !== -12) fail(`day SL expected -12, got ${day.stopLossPct}`);
  else ok("daytime uses day stopLossPct");
  if (day.maxVolatility !== null) fail(`day maxVolatility expected null, got ${day.maxVolatility}`);
  else ok("daytime uses day maxVolatility");
  if (day.isNight !== false) fail(`day isNight expected false, got ${day.isNight}`);
  else ok("daytime isNight=false");

  // Night window start boundary: exactly 17:00 UTC → night
  const nightStart = getEffectiveManagementConfig(new Date("2026-04-16T17:00:00Z"));
  if (nightStart.stopLossPct !== -8) fail(`night-start SL expected -8, got ${nightStart.stopLossPct}`);
  else ok("17:00 UTC is night (inclusive start)");

  // Middle of night: 20:00 UTC → night
  const mid = getEffectiveManagementConfig(new Date("2026-04-16T20:00:00Z"));
  if (mid.stopLossPct !== -8) fail(`night SL expected -8, got ${mid.stopLossPct}`);
  else ok("night stopLossPct override applied");
  if (mid.maxVolatility !== 2) fail(`night maxVolatility expected 2, got ${mid.maxVolatility}`);
  else ok("night maxVolatility override applied");
  if (mid.isNight !== true) fail(`mid isNight expected true, got ${mid.isNight}`);
  else ok("night isNight=true");

  // Night end exclusive: 23:00 UTC → day
  const endBoundary = getEffectiveManagementConfig(new Date("2026-04-16T23:00:00Z"));
  if (endBoundary.stopLossPct !== -12) fail(`23:00 UTC expected day (-12), got ${endBoundary.stopLossPct}`);
  else ok("23:00 UTC is day (exclusive end)");

  // With night mode disabled (start=null), always day
  config.management.nightModeStartUtc = null;
  const disabled = getEffectiveManagementConfig(new Date("2026-04-16T20:00:00Z"));
  if (disabled.stopLossPct !== -12) fail(`night-disabled SL expected -12, got ${disabled.stopLossPct}`);
  else ok("nightModeStartUtc=null disables night mode");
} finally {
  Object.assign(config.management, saved);
}
process.exit(exitCode);
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node test/test-effective-config.js
```

Expected: FAIL on "getEffectiveManagementConfig is not exported".

---

## Task 6: Implement `getEffectiveManagementConfig()`

**Files:**
- Modify: `config.js` — add export at the bottom of the file, after the `export const config = { ... }` declaration.

- [ ] **Step 1: Add the helper**

Append to the end of `config.js`:

```js
/**
 * Returns management config with night-mode overrides applied when the current
 * UTC hour falls within [nightModeStartUtc, nightModeEndUtc) (end exclusive).
 * Handles wrap-around windows (e.g. start=22, end=2).
 *
 * @param {Date} [now] — optional clock override for tests. Defaults to new Date().
 * @returns {object} shallow copy of config.management plus { isNight: boolean }.
 */
export function getEffectiveManagementConfig(now = new Date()) {
  const m = config.management;
  const start = m.nightModeStartUtc;
  const end   = m.nightModeEndUtc;

  let isNight = false;
  if (start != null && end != null) {
    const h = now.getUTCHours();
    isNight = start <= end ? (h >= start && h < end) : (h >= start || h < end);
  }

  const eff = { ...m, isNight };
  if (isNight) {
    if (m.nightStopLossPct   != null) eff.stopLossPct   = m.nightStopLossPct;
    if (m.nightMaxVolatility != null) eff.maxVolatility = m.nightMaxVolatility;
  }
  return eff;
}
```

- [ ] **Step 2: Run test to verify it passes**

```bash
node test/test-effective-config.js
```

Expected: 7 PASS lines, exit 0.

- [ ] **Step 3: Commit**

```bash
git add config.js test/test-effective-config.js
git commit -m "feat: add getEffectiveManagementConfig with night-mode overrides"
```

---

## Task 7: Stop-loss check uses effective config

**Files:**
- Modify: `state.js:434-440` (the stop-loss `if` block inside whatever function contains the OOR/trailing logic — confirm by reading line 434).

- [ ] **Step 1: Import the helper**

At the top of `state.js`, find the existing `import { ... } from "./config.js";` line and change it from:

```js
import { config } from "./config.js";
```

to:

```js
import { config, getEffectiveManagementConfig } from "./config.js";
```

(If the import is destructured differently, add `getEffectiveManagementConfig` to the same destructure.)

- [ ] **Step 2: Resolve effective config at the check site**

In `state.js`, the stop-loss block at line 434-440 currently reads:

```js
  // ── Stop loss ──────────────────────────────────────────────────
  if (!pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct <= mgmtConfig.stopLossPct) {
    return {
      action: "STOP_LOSS",
      reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%`,
    };
  }
```

Replace with:

```js
  // ── Stop loss (night-mode aware) ──────────────────────────────
  const effMgmt = getEffectiveManagementConfig();
  if (!pnl_pct_suspicious && currentPnlPct != null && effMgmt.stopLossPct != null && currentPnlPct <= effMgmt.stopLossPct) {
    return {
      action: "STOP_LOSS",
      reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${effMgmt.stopLossPct}%${effMgmt.isNight ? " (night mode)" : ""}`,
    };
  }
```

- [ ] **Step 3: Syntax-check**

```bash
node --check state.js
```

Expected: no output (clean).

- [ ] **Step 4: Commit**

```bash
git add state.js
git commit -m "feat: stop-loss check honors night-mode override"
```

---

## Task 8: Volatility safety check on deploy

**Files:**
- Modify: `tools/executor.js:374-446` (the `case "deploy_position":` block inside `runSafetyChecks`).

- [ ] **Step 1: Import the helper**

At the top of `tools/executor.js`, locate the existing `config` import and add `getEffectiveManagementConfig`:

```js
import { config, getEffectiveManagementConfig } from "../config.js";
```

(If the import doesn't currently destructure `config` from `config.js`, adjust accordingly — the file already uses `config.screening.*` and `config.management.*` so an import of `config` must exist.)

- [ ] **Step 2: Add the volatility check**

In `tools/executor.js`, at the top of the `case "deploy_position": {` block (immediately after the opening brace, before the existing `// Reject pools with bin_step out of configured range` comment), insert:

```js
      // Reject pools with volatility above the effective cap (night-mode aware)
      const effMgmtForDeploy = getEffectiveManagementConfig();
      if (effMgmtForDeploy.maxVolatility != null && args.volatility != null && args.volatility >= effMgmtForDeploy.maxVolatility) {
        return {
          pass: false,
          reason: `Pool volatility ${args.volatility} is at or above the max allowed (${effMgmtForDeploy.maxVolatility})${effMgmtForDeploy.isNight ? " during night mode" : ""}. Skip this pool.`,
        };
      }
```

- [ ] **Step 3: Verify the screener passes `volatility` to `deploy_position`**

```bash
grep -n "volatility" tools/definitions.js | head -20
```

If `volatility` is not in the `deploy_position` tool's input schema, add it. Expected: the existing schema already includes `volatility` (it's documented in the SCREENER prompt in `index.js`). If grep shows it is already a parameter, no action needed. If not, add this to the `deploy_position` tool's `parameters.properties` in `tools/definitions.js`:

```js
            volatility: { type: "number", description: "Pool volatility from candidate data (0-10+). Used for safety checks." },
```

- [ ] **Step 4: Syntax-check**

```bash
node --check tools/executor.js
```

Expected: no output (clean).

- [ ] **Step 5: Commit**

```bash
git add tools/executor.js tools/definitions.js
git commit -m "feat: volatility cap safety check on deploy (night-mode aware)"
```

---

## Task 9: Wire new keys into `update_config` whitelist

**Files:**
- Modify: `tools/executor.js:156-170` (the `update_config` key mapping).
- Modify: `tools/definitions.js:373-378` (the VALID KEYS docstring the LLM sees).

- [ ] **Step 1: Add new keys to the executor mapping**

In `tools/executor.js`, find the object that maps config keys to `[section, key]` pairs (starts with `minFeeActiveTvlRatio: ["screening", ...]`, includes `stopLossPct: ["management", "stopLossPct"]` at line 160). Add after `takeProfitFeePct`:

```js
      nightModeStartUtc:     ["management", "nightModeStartUtc"],
      nightModeEndUtc:       ["management", "nightModeEndUtc"],
      nightStopLossPct:      ["management", "nightStopLossPct"],
      nightMaxVolatility:    ["management", "nightMaxVolatility"],
      maxVolatility:         ["management", "maxVolatility"],
      winnerCooldownHours:   ["management", "winnerCooldownHours"],
      winnerCooldownMinPnlPct: ["management", "winnerCooldownMinPnlPct"],
```

- [ ] **Step 2: Update the LLM-visible docstring**

In `tools/definitions.js`, the `Management: ...` key list around line 376 currently ends with `gasReserve, positionSizePct`. Replace that line with:

```
Management: minClaimAmount, outOfRangeBinsToClose, outOfRangeWaitMinutes, minVolumeToRebalance, stopLossPct, takeProfitFeePct, minSolToOpen, deployAmountSol, gasReserve, positionSizePct, nightModeStartUtc, nightModeEndUtc, nightStopLossPct, nightMaxVolatility, maxVolatility, winnerCooldownHours, winnerCooldownMinPnlPct
```

- [ ] **Step 3: Syntax-check**

```bash
node --check tools/executor.js && node --check tools/definitions.js
```

Expected: no output (clean).

- [ ] **Step 4: Commit**

```bash
git add tools/executor.js tools/definitions.js
git commit -m "feat: expose night-mode and winner-cooldown keys to update_config"
```

---

## Task 10: Activate in live config

**Files:**
- Modify: `user-config.json`

- [ ] **Step 1: Read current config**

```bash
cat user-config.json
```

Confirm `stopLossPct: -15` is present, and none of the new night-mode or winner-cooldown keys exist yet.

- [ ] **Step 2: Update user-config.json**

Change `"stopLossPct": -15` to `"stopLossPct": -12`, and add (anywhere — pool-memory will pick up defaults, but keeping them grouped is nicer):

```json
  "stopLossPct": -12,
  "nightModeStartUtc": 17,
  "nightModeEndUtc": 23,
  "nightStopLossPct": -8,
  "nightMaxVolatility": 2,
  "winnerCooldownHours": 6,
  "winnerCooldownMinPnlPct": 0,
```

- [ ] **Step 3: Validate JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('user-config.json','utf8')); console.log('ok')"
```

Expected: `ok`.

- [ ] **Step 4: Commit**

```bash
git add user-config.json
git commit -m "chore: enable night-mode (SL -8 17-23 UTC, vol cap 2) + winner cooldown"
```

---

## Task 11: Documentation

**Files:**
- Modify: `CLAUDE.md` — the "Config System" table around the top of the file, and the "Position Lifecycle" section.

- [ ] **Step 1: Add rows to the config table**

In `CLAUDE.md`, find the table under `## Config System` (rows like `| minFeeActiveTvlRatio | screening | 0.05 |`). Add these rows to the **management section** (after `badPnlCooldownHours`):

```markdown
| winnerCooldownHours | management | 6 |
| winnerCooldownMinPnlPct | management | 0 |
| nightModeStartUtc | management | null |
| nightModeEndUtc | management | null |
| nightStopLossPct | management | null |
| nightMaxVolatility | management | null |
| maxVolatility | management | null |
```

- [ ] **Step 2: Add a Night Mode subsection**

After the `computeDeployAmount` paragraph at the end of the Config System section, add:

```markdown
**Night mode** (`getEffectiveManagementConfig`): when `nightModeStartUtc` and `nightModeEndUtc` are both set, the stop loss (`stopLossPct`) tightens to `nightStopLossPct` and deploys are rejected for pools with `volatility >= nightMaxVolatility` between those UTC hours (start-inclusive, end-exclusive; wrap-around supported). Used at the stop-loss check site in `state.js` and the `deploy_position` safety check in `tools/executor.js`.

**Winner cooldown** (`pool-memory.js:recordPoolDeploy`): after a winning close (`pnl_pct > winnerCooldownMinPnlPct`), the pool is put on cooldown for `winnerCooldownHours`. Prevents re-deploying into a pool whose move has already paid out. Skipped if an existing cooldown expires later than the winner-cooldown candidate (longest-expiry wins).
```

- [ ] **Step 3: Update Position Lifecycle**

In the `## Position Lifecycle` section, find the `**Pool cooldowns** (pool-memory.js)` line. Replace the existing pool cooldown sentence with:

```markdown
5. **Pool cooldowns** (pool-memory.js): a pool gets cooled down if (a) its last `oorCooldownTriggerCount` deploys all closed OOR, (b) its last `badPnlCooldownTriggerCount` deploys averaged below `badPnlCooldownMinAvgPct`, or (c) its last close was a winner (`pnl_pct > winnerCooldownMinPnlPct`) — in which case the pool cools for `winnerCooldownHours`. Cooled-down pools are skipped by the screener. Base mints share cooldowns across pools for the OOR case only.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document night-mode and winner-cooldown in CLAUDE.md"
```

---

## Task 12: Restart and sanity-check

- [ ] **Step 1: Restart pm2 with updated env**

```bash
pm2 restart meridian --update-env
```

Expected: status `online`, restart counter increments.

- [ ] **Step 2: Watch management cycle logs**

```bash
tail -f logs/agent-$(date -u +%Y-%m-%d).log | grep -E "CRON|stop loss|night|cooldown"
```

Let it run for one management cycle (≤10 min). Expected behaviors:
- If now is between 17-23 UTC: any deploy attempt with volatility ≥ 2 gets rejected with "night mode" in the reason.
- On any close, if the closed PnL was > 0, a `Cooldown set for <pool> ... winner cooldown` log line appears.
- The stop-loss log line includes `(night mode)` when the hour is in the night window.

- [ ] **Step 3: Telegram smoke test**

Via Telegram `/config` (if implemented) or directly: confirm `stopLossPct` reads `-12`. Attempt `update_config stopLossPct=-10` and confirm it persists to `user-config.json`.

- [ ] **Step 4: Exit tail, done**

---

## Self-review notes

- **Spec coverage:** Winner cooldown (Tasks 1-3) ✓. Night-mode SL (Tasks 4-7) ✓. Night-mode volatility cap (Tasks 4, 6, 8) ✓. Existing loser cooldown untouched ✓. All 7 new config keys exposed to `update_config` (Task 9) ✓. Live activation (Task 10) ✓. Docs (Task 11) ✓.
- **Placeholder scan:** No TODOs, no "implement X later", all code blocks complete.
- **Type consistency:** `getEffectiveManagementConfig` always named the same, returns `{ ...m, isNight }`. `nightMaxVolatility` consistently spelled. `winnerCooldownHours` / `winnerCooldownMinPnlPct` consistent across config, test, impl, and docs.
- **Known trade-off:** Task 8 rejects deploys with `volatility >= maxVolatility` (≥, not >). Matches the user's intent that vol=2 is the ceiling. If screener only has volatility bucketing (low/med/high), this may need rethinking — but existing `volatility_at_deploy` in pool-memory stores the raw number, so the float comparison is sound.
