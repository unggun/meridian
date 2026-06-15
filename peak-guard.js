/**
 * Trailing-TP peak guard — protects peak tracking from present-but-wrong price
 * ticks.
 *
 * Background (WOC-SOL 2026-06-14): a single RPC poll tick read +2.68% PnL on a
 * position whose real PnL never exceeded ~0%. The relay path accepts peaks
 * immediately (no 15s recheck), so that one bad tick set peak_pnl_pct=2.68,
 * armed trailing TP (trigger 1.7%), and the next tick (-4.37%) closed the
 * position on a phantom 7.05% drawdown. The "suspicious tick" guard in pnl.js
 * only rejects MISSING prices (priceMissing/depositsMissing); a price that is
 * present but wrong sails through. This guard catches it by magnitude instead.
 *
 * Decision: a peak candidate that leaps more than `maxJumpPct` above the last
 * confirmed peak in a single tick is treated as unconfirmed — it must survive a
 * re-poll (resolvePendingPeak) before it can set the peak, regardless of relay
 * mode. Real fast moves that hold survive the recheck (0.85 tolerance); a
 * transient glitch reverts and is rejected.
 *
 * Only upward jumps are ever evaluated (peaks only ratchet up), so this never
 * touches downward moves — stop-loss / rug response stays on the instant path.
 */
export function peakJumpNeedsConfirmation(currentPeak, candidatePnlPct, maxJumpPct) {
  if (candidatePnlPct == null) return false;
  if (maxJumpPct == null || !(maxJumpPct > 0)) return false; // guard disabled
  const base = currentPeak == null ? 0 : currentPeak;
  return candidatePnlPct - base > maxJumpPct;
}
