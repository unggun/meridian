// wallet-report.js
// After a position closes, if NO positions remain open, report the final
// wallet SOL balance to Telegram. Centralized so every close path (automated
// executor hook + manual /close & /closeall) can call it.

import { getMyPositions } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { sendMessage } from "./telegram.js";
import { log } from "./logger.js";

/**
 * Check open positions; if none remain, fetch the wallet balance and send the
 * final SOL balance to Telegram. Never throws — failures are logged only, so a
 * reporting hiccup can't disrupt the close flow.
 */
export async function reportFinalBalanceIfFlat() {
  try {
    // Force a fresh count — a cached value could still include the just-closed position.
    const { total_positions } = await getMyPositions({ force: true, silent: true });
    if (total_positions > 0) return;

    const wallet = await getWalletBalances();
    if (wallet?.error) {
      log("wallet_report_warn", `Skipped final balance report: ${wallet.error}`);
      return;
    }

    const sol = Number(wallet?.sol ?? 0).toFixed(4);
    await sendMessage(`💰 All positions closed\nWallet: ◎${sol}`);
    log("wallet_report", `Reported final balance: ◎${sol}`);
  } catch (e) {
    log("wallet_report_warn", `reportFinalBalanceIfFlat failed: ${e.message}`);
  }
}
