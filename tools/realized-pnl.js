/**
 * Wallet-measured realized PnL for a closed position.
 *
 * recovered     — SOL the wallet gained across the close (claim + close + swap),
 *                 measured as (walletAfter − walletBefore).
 * deployCostSol — SOL the wallet spent at deploy (liquidity + rent + gas − refunds),
 *                 measured as (walletBefore − walletAfter) at deploy time.
 * amountSol     — liquidity deployed (the deposit basis for the percentage).
 *
 * Rent cancels: it is inside both deployCostSol (paid) and recovered (refunded).
 * Exception: shared binArray rent. binArray rent is paid at deploy only if this
 * position is first to touch those bins, and refunded at close only if it is last
 * to vacate them. When another live position still overlaps, that rent is paid but
 * not refunded (or vice-versa), leaving realizedSol off by the un-cancelled binArray
 * rent — bounded (~0.00073 SOL per binArray, a handful at most) and never in the
 * over-reporting direction this feature exists to fix.
 * Returns null when either measurement is unavailable → caller shows mark-only.
 */
export function computeRealizedPnl({ recovered, deployCostSol, amountSol }) {
  if (recovered == null || deployCostSol == null) return null;
  const realizedSol = recovered - deployCostSol;
  const realizedPct = amountSol > 0 ? (realizedSol / amountSol) * 100 : null;
  return { realizedSol, realizedPct };
}
