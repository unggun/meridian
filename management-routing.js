/**
 * Partition per-position management actions into those the cron executes
 * deterministically in-process vs those handed to the LLM.
 *
 * CLOSE is fully determined by the deterministic rules (stop loss / pumped /
 * OOR / low yield / trailing TP / chart exit) — there is no language judgement
 * left to make, so it must be executed directly via executeTool. Routing it
 * through the LLM let a model "decide" to close in its reasoning yet never emit
 * the close_position tool call, leaving the position open while the report said
 * CLOSE (TURTLE-SOL 2026-06-17). CLAIM is deterministic too but left on the LLM
 * path; INSTRUCTION genuinely needs natural-language evaluation. STAY is a no-op.
 */
export function partitionManagementActions(entries) {
  const directCloses = [];
  const llmActions = [];
  for (const entry of entries) {
    if (entry.action === "CLOSE") directCloses.push(entry);
    else if (entry.action !== "STAY") llmActions.push(entry);
  }
  return { directCloses, llmActions };
}

/**
 * Whether a PnL-poller exit action should be closed directly in-process — a fast
 * path that skips the management-cycle round-trip (which is cooldown-gated up to
 * managementIntervalMin). These are all fully deterministic exits.
 *
 *  - STOP_LOSS              — gated by `directStopLossClose` (default on); fast to
 *                             minimise rug-bleed.
 *  - TRAILING_TP / TAKE_PROFIT — gated by `directProfitClose` (default on); fast so
 *                             a confirmed profit exit isn't given back waiting for
 *                             the next management cycle.
 *
 * The two gates are independent. Any other action (OOR, low yield, etc.) is NOT a
 * poller fast-path — it routes through the management cycle as before.
 */
export function shouldDirectCloseExit(action, config = {}) {
  if (action === "STOP_LOSS") return config.directStopLossClose !== false;
  if (action === "TRAILING_TP" || action === "TAKE_PROFIT") return config.directProfitClose !== false;
  return false;
}

/**
 * Whether a poll/timer-driven direct close may open its close window right now.
 *
 * Realized PnL is measured as a GLOBAL wallet delta (walletAfter − walletBefore in
 * executor.js): the implicit assumption is that nothing else moves SOL between the
 * two snapshots. A direct close fired from a decoupled confirmation setTimeout
 * (trailing-drop / peak / take-profit) does NOT re-check the management/screening
 * mutex, so it can overlap an in-flight management-cycle close (or a screener
 * deploy). When two close windows overlap, each measures BOTH positions' recovered
 * SOL + auto-swaps and reports a near-identical, inflated realized PnL (Hobbes+world
 * both showed ~+1.50◎ / +155% on 2026-06-29 while mark PnL was ~+1.5%).
 *
 * Defer the direct close while another SOL-moving cycle holds the lock. The exit is
 * sticky — the PnL poller re-detects it and closes cleanly once the lock frees.
 */
export function canDirectCloseNow({ managementBusy = false, screeningBusy = false } = {}) {
  return !managementBusy && !screeningBusy;
}
