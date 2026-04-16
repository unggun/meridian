# Dry-Run Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track paper positions during DRY_RUN mode and feed price-based outcomes into the lessons system so the agent learns from simulated deployments.

**Architecture:** On dry-run deploy, fetch the pool's entry price and record a paper position in state.json (flagged `dry_run: true`). Each management cycle, check paper positions' current price vs entry. After a hold period or OOR, auto-close them and call `recordPerformance()` with price-change-based PnL estimates.

**Tech Stack:** Node.js, existing Meteora DLMM SDK (read-only calls), existing state.js/lessons.js infrastructure.

---

### Task 1: Add paper position support to state.js

**Files:**
- Modify: `state.js:56-111` (trackPosition)
- Modify: `state.js:496-523` (syncOpenPositions)
- Add new export: `getPaperPositions()`

- [ ] **Step 1: Add `dry_run` and `entry_price` fields to `trackPosition`**

In `state.js`, update `trackPosition` to accept two new optional parameters and store them:

```js
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  signal_snapshot = null,
  dry_run = false,       // NEW
  entry_price = null,    // NEW
}) {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    strategy,
    bin_range,
    amount_sol,
    amount_x,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    signal_snapshot: signal_snapshot || null,
    deployed_at: new Date().toISOString(),
    out_of_range_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    rebalance_count: 0,
    closed: false,
    closed_at: null,
    notes: [],
    peak_pnl_pct: 0,
    pending_peak_pnl_pct: null,
    pending_peak_started_at: null,
    pending_trailing_current_pnl_pct: null,
    pending_trailing_peak_pnl_pct: null,
    pending_trailing_drop_pct: null,
    pending_trailing_started_at: null,
    confirmed_trailing_exit_reason: null,
    confirmed_trailing_exit_until: null,
    trailing_active: false,
    dry_run,               // NEW
    entry_price,           // NEW
  };
  pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool, dry_run });
  save(state);
  log("state", `Tracked ${dry_run ? "paper" : "new"} position: ${position} in pool ${pool}`);
}
```

- [ ] **Step 2: Skip paper positions in `syncOpenPositions`**

In `state.js:syncOpenPositions`, add a check to skip `dry_run` positions so they don't get auto-closed by the on-chain sync:

```js
export function syncOpenPositions(active_addresses) {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || pos.dry_run || activeSet.has(posId)) continue;  // added pos.dry_run
    // ... rest unchanged
  }
  if (changed) save(state);
}
```

- [ ] **Step 3: Add `getPaperPositions` helper**

Add a new export after `getTrackedPositions`:

```js
/**
 * Get open paper (dry-run) positions.
 */
export function getPaperPositions() {
  const state = load();
  return Object.values(state.positions).filter((p) => p.dry_run && !p.closed);
}
```

- [ ] **Step 4: Commit**

```bash
git add state.js
git commit -m "feat: add paper position tracking for dry-run learning"
```

---

### Task 2: Track paper positions on dry-run deploy

**Files:**
- Modify: `tools/dlmm.js:122-137` (deployPosition DRY_RUN block)

- [ ] **Step 1: Expand dry-run deploy to fetch price and track position**

Replace the early-return DRY_RUN block in `deployPosition` (`tools/dlmm.js:122-137`) with:

```js
if (process.env.DRY_RUN === "true") {
  const totalBins = activeBinsBelow + activeBinsAbove;

  // Fetch entry price for paper position tracking (read-only, no SDK needed)
  let entryPrice = null;
  let entryBinId = null;
  try {
    const binData = await getActiveBin({ pool_address });
    entryPrice = binData.price;
    entryBinId = binData.binId;
  } catch (e) {
    log("deploy", `DRY RUN — could not fetch entry price: ${e.message}`);
  }

  // Generate a deterministic paper position ID
  const paperId = `paper_${pool_address.slice(0, 8)}_${Date.now()}`;

  trackPosition({
    position: paperId,
    pool: pool_address,
    pool_name,
    strategy: activeStrategy,
    bin_range: {
      min: entryBinId != null ? entryBinId - activeBinsBelow : null,
      max: entryBinId != null ? entryBinId + activeBinsAbove : null,
      bins_below: activeBinsBelow,
      bins_above: activeBinsAbove,
    },
    bin_step,
    volatility,
    fee_tvl_ratio,
    organic_score,
    amount_sol: amount_y ?? amount_sol ?? 0,
    amount_x: amount_x ?? 0,
    active_bin: entryBinId,
    initial_value_usd: initial_value_usd ?? 0,
    dry_run: true,
    entry_price: entryPrice,
  });

  return {
    dry_run: true,
    success: true,
    position: paperId,
    pool: pool_address,
    pool_name,
    would_deploy: {
      pool_address,
      strategy: activeStrategy,
      bins_below: activeBinsBelow,
      bins_above: activeBinsAbove,
      amount_x: amount_x || 0,
      amount_y: amount_y || amount_sol || 0,
      wide_range: totalBins > 69,
    },
    message: "DRY RUN — paper position tracked for learning",
  };
}
```

Key changes from the old dry-run block:
- Calls `getActiveBin()` (read-only) to get entry price
- Calls `trackPosition()` with `dry_run: true` and `entry_price`
- Returns `success: true` so the executor post-hook (Telegram notification) fires
- Returns a `position` field so the notification has something to show

- [ ] **Step 2: Commit**

```bash
git add tools/dlmm.js
git commit -m "feat: track paper positions on dry-run deploy with entry price"
```

---

### Task 3: Add paper position checking to management cycle

**Files:**
- Modify: `index.js:167-380` (runManagementCycle)
- Modify: `index.js:6` (imports from dlmm.js)
- Modify: `index.js:14` (imports from state.js)

- [ ] **Step 1: Add import for `getPaperPositions`**

In `index.js:14`, add `getPaperPositions` to the state.js import:

```js
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, setPositionInstruction, updatePnlAndCheckExits, queuePeakConfirmation, resolvePendingPeak, queueTrailingDropConfirmation, resolvePendingTrailingDrop, getPaperPositions } from "./state.js";
```

- [ ] **Step 2: Add `recordClose` import**

`recordClose` is already imported in dlmm.js but not in index.js. We need it to close paper positions. Add to the state.js import line (same line as step 1):

Check if `recordClose` is already imported. If not, add it to the import from `./state.js`.

- [ ] **Step 3: Add `checkPaperPositions` function**

Add this function before `runManagementCycle` in `index.js` (around line 165):

```js
// ─── Paper Position Monitor (dry-run learning) ──────────────────
const PAPER_HOLD_MINUTES = 180; // 3 hours — enough for meme token signal

async function checkPaperPositions() {
  if (process.env.DRY_RUN !== "true") return;

  const papers = getPaperPositions();
  if (papers.length === 0) return;

  log("cron", `Checking ${papers.length} paper position(s)`);

  for (const paper of papers) {
    try {
      const currentBin = await getActiveBin({ pool_address: paper.pool });
      const currentPrice = currentBin.price;
      const entryPrice = paper.entry_price;

      if (!entryPrice || !currentPrice) {
        log("cron", `Paper ${paper.position}: missing price data, skipping`);
        continue;
      }

      const priceChangePct = ((currentPrice - entryPrice) / entryPrice) * 100;
      const ageMinutes = Math.floor((Date.now() - new Date(paper.deployed_at).getTime()) / 60000);

      // Check if paper position should be closed
      const binRange = paper.bin_range || {};
      const isOOR = currentBin.binId < (binRange.min ?? -Infinity) ||
                    currentBin.binId > (binRange.max ?? Infinity);
      const isExpired = ageMinutes >= PAPER_HOLD_MINUTES;

      if (!isOOR && !isExpired) {
        log("cron", `Paper ${paper.pool_name || paper.pool}: age ${ageMinutes}m, price ${priceChangePct.toFixed(1)}% — holding`);
        continue;
      }

      // Close the paper position and record performance
      const closeReason = isOOR
        ? `[DRY_RUN] Out of range after ${ageMinutes}m (price ${priceChangePct.toFixed(1)}%)`
        : `[DRY_RUN] Hold period expired after ${ageMinutes}m (price ${priceChangePct.toFixed(1)}%)`;

      log("cron", `Paper ${paper.pool_name || paper.pool}: closing — ${closeReason}`);

      // Use price change as PnL proxy
      // For one-sided SOL deposits, price drop = roughly proportional loss
      const estimatedPnlPct = priceChangePct;
      const initialUsd = paper.initial_value_usd || (paper.amount_sol * 150); // rough SOL price fallback
      const estimatedFinalUsd = initialUsd * (1 + estimatedPnlPct / 100);

      const { recordPerformance } = await import("./lessons.js");
      await recordPerformance({
        position: paper.position,
        pool: paper.pool,
        pool_name: paper.pool_name || paper.pool.slice(0, 8),
        strategy: paper.strategy,
        bin_range: paper.bin_range,
        bin_step: paper.bin_step || null,
        volatility: paper.volatility || null,
        fee_tvl_ratio: paper.fee_tvl_ratio || null,
        organic_score: paper.organic_score || null,
        amount_sol: paper.amount_sol,
        fees_earned_usd: 0,
        final_value_usd: Math.max(0, estimatedFinalUsd),
        initial_value_usd: initialUsd,
        minutes_in_range: isOOR ? Math.max(0, ageMinutes - 10) : ageMinutes, // rough estimate
        minutes_held: ageMinutes,
        close_reason: closeReason,
      });

      // Mark closed in state
      const { recordClose } = await import("./state.js");
      recordClose(paper.position, closeReason);

      if (telegramEnabled()) {
        const emoji = estimatedPnlPct >= 0 ? "+" : "";
        sendMessage(
          `📝 Paper position closed\n\n${paper.pool_name || paper.pool.slice(0, 8)}\nPrice: ${emoji}${estimatedPnlPct.toFixed(1)}% | Age: ${ageMinutes}m\nReason: ${isOOR ? "Out of range" : "Hold expired"}\n\n(DRY RUN — learning recorded)`
        ).catch(() => {});
      }
    } catch (e) {
      log("cron_error", `Paper position check failed for ${paper.position}: ${e.message}`);
    }
  }
}
```

- [ ] **Step 4: Call `checkPaperPositions` from management cycle**

In `runManagementCycle`, right after the `_managementBusy = true` line (`index.js:169`), but before the real position check, add the paper check. Specifically, insert after line 171 (`log("cron", "Starting management cycle");`):

```js
  // Check paper positions (dry-run learning)
  await checkPaperPositions().catch((e) => log("cron_error", `Paper position check failed: ${e.message}`));
```

Also, update the "no open positions" block (`index.js:184-189`) to not trigger screening if we have paper positions:

```js
    if (positions.length === 0) {
      log("cron", "No open positions — triggering screening cycle");
      mgmtReport = "No open positions. Triggering screening cycle.";
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      return mgmtReport;
    }
```

This block stays as-is — paper positions don't count toward `maxPositions` since they're not real. The screening cycle's `deploy_position` safety check uses `getMyPositions()` which queries on-chain, so paper positions won't block new deploys.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat: check paper positions in management cycle for dry-run learning"
```

---

### Task 4: Handle paper positions in executor safety checks and config

**Files:**
- Modify: `tools/executor.js:366-442` (deploy_position safety checks)
- Modify: `config.js:52-75` (management section)

- [ ] **Step 1: Add `paperHoldMinutes` to config**

In `config.js`, add to the management section (after `solMode` line ~74):

```js
    // Dry-run paper position hold period (minutes)
    paperHoldMinutes:      u.paperHoldMinutes      ?? 180,
```

- [ ] **Step 2: Update `checkPaperPositions` to use config**

Back in `index.js`, replace the hardcoded `PAPER_HOLD_MINUTES` constant:

```js
// Remove: const PAPER_HOLD_MINUTES = 180;
// Use config.management.paperHoldMinutes instead in the function body:
    const isExpired = ageMinutes >= config.management.paperHoldMinutes;
```

- [ ] **Step 3: Skip SOL balance check for dry-run in executor safety**

The executor safety check at `executor.js:432` already skips the balance check for DRY_RUN. No change needed here.

However, the `maxPositions` check in executor.js calls `getMyPositions({ force: true })` which returns on-chain positions only. Paper positions won't count. This is correct behavior — we don't want paper positions blocking real deploys. But in dry-run mode, we should also count paper positions toward the limit to avoid infinite paper deploys.

In `tools/executor.js`, find the maxPositions check in the `deploy_position` safety case. It looks like:

```js
case "deploy_position": {
```

Find the position count check within that case block and add paper position counting for dry-run mode. Read the exact code first, then modify.

- [ ] **Step 4: Add paper position count to maxPositions check**

In `executor.js` deploy_position safety check, after the position count check, add:

```js
      // In dry-run mode, also count paper positions toward the limit
      if (process.env.DRY_RUN === "true") {
        const { getPaperPositions } = await import("../state.js");
        const paperCount = getPaperPositions().length;
        if (paperCount >= maxPos) {
          return {
            pass: false,
            reason: `Paper position limit reached: ${paperCount} paper positions open (max ${maxPos}). Wait for them to expire.`,
          };
        }
      }
```

- [ ] **Step 5: Commit**

```bash
git add config.js tools/executor.js index.js
git commit -m "feat: add paperHoldMinutes config and paper position limits"
```

---

### Task 5: Mark dry-run lessons distinctly

**Files:**
- Modify: `lessons.js:175-231` (derivLesson function)

- [ ] **Step 1: Tag dry-run lessons**

The `close_reason` from paper positions is already prefixed with `[DRY_RUN]`. The `derivLesson` function uses `perf.close_reason` in its output. However, we should also add a `dry_run` tag so lessons can be filtered.

In `lessons.js:derivLesson`, add after the `tags` array initialization (line 177):

```js
function derivLesson(perf) {
  const tags = [];

  // Tag dry-run lessons for filtering
  if (perf.close_reason?.includes("[DRY_RUN]")) {
    tags.push("dry_run");
  }

  // ... rest unchanged
```

This ensures dry-run lessons are tagged and can be filtered or identified in the prompt injection.

- [ ] **Step 2: Commit**

```bash
git add lessons.js
git commit -m "feat: tag dry-run lessons for identification"
```

---

### Task 6: Test end-to-end dry-run learning flow

**Files:**
- No new files — manual testing via `DRY_RUN=true node index.js`

- [ ] **Step 1: Start the agent in dry-run mode**

```bash
DRY_RUN=true node index.js
```

- [ ] **Step 2: Verify paper position is tracked after screening deploys**

After a screening cycle fires and "deploys," check `state.json`:

```bash
cat state.json | node -e "
  const s = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const papers = Object.values(s.positions).filter(p => p.dry_run);
  console.log('Paper positions:', papers.length);
  papers.forEach(p => console.log(p.position, p.pool_name, 'price:', p.entry_price));
"
```

Expected: At least one paper position with `dry_run: true` and a non-null `entry_price`.

- [ ] **Step 3: Verify paper positions are checked in management cycle**

Watch the logs for lines containing "Paper" or "paper":

```bash
grep -i paper logs/*.log
```

Expected: Lines like `Paper TOKEN-SOL: age Xm, price Y% — holding` appearing each management cycle.

- [ ] **Step 4: Verify learning is recorded after paper position closes**

After the hold period expires (or accelerate by temporarily setting `paperHoldMinutes` to 1 in user-config.json), check `lessons.json`:

```bash
cat lessons.json | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const dryPerf = d.performance.filter(p => p.close_reason?.includes('[DRY_RUN]'));
  console.log('Dry-run performance records:', dryPerf.length);
  dryPerf.forEach(p => console.log(p.pool_name, 'pnl:', p.pnl_pct + '%'));
  const dryLessons = d.lessons.filter(l => l.tags?.includes('dry_run'));
  console.log('Dry-run lessons:', dryLessons.length);
  dryLessons.forEach(l => console.log(l.rule.slice(0, 100)));
"
```

Expected: Performance records and lessons with `[DRY_RUN]` prefix and `dry_run` tag.

- [ ] **Step 5: Verify Telegram notification on paper close**

Check Telegram for a message like:
```
Paper position closed

TOKEN-SOL
Price: -5.2% | Age: 180m
Reason: Hold expired

(DRY RUN — learning recorded)
```

- [ ] **Step 6: Final commit with any fixes**

```bash
git add -A
git commit -m "fix: dry-run learning adjustments from testing"
```
