// Safety guard for relay (zap-in / zap-out) transactions built by an external provider
// (OKX/LPAgent) before we sign them. Leaf module so the logic is unit-testable without
// importing the heavy DLMM SDK wrapper (mirrors tools/liquidity-blend.js).
import {
  SystemProgram,
  SystemInstruction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";

export function getTransactionInstructions(tx) {
  if (!(tx instanceof VersionedTransaction)) return tx.instructions;

  const keys = tx.message.staticAccountKeys;
  return tx.message.compiledInstructions
    .map((ix) => {
      const programId = keys[ix.programIdIndex];
      if (!programId) return null;
      const accounts = ix.accountKeyIndexes
        .map((accountIndex) => keys[accountIndex])
        .filter(Boolean);
      return new TransactionInstruction({
        programId,
        keys: accounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
        data: Buffer.from(ix.data),
      });
    })
    .filter(Boolean);
}

// Rejects a relay tx that moves SOL directly out of the owner's wallet to an address we did
// not whitelist. `allowOwnerSystemTransfers: true` skips this instruction-level heuristic and
// defers to the caller's post-simulation net-lamport-loss guard (the authoritative protection):
// legitimate provider swap legs fund a transient router/WSOL account from the owner (with a
// destination that varies every swap), which this check otherwise rejects 100% of the time.
export function assertNoUnsafeSystemTransfer(tx, wallet, allowedDestinations = [], { allowOwnerSystemTransfers = false } = {}) {
  if (allowOwnerSystemTransfers) return;

  const owner = wallet.publicKey.toString();
  const allowed = new Set(allowedDestinations.filter(Boolean).map(String));

  for (const ix of getTransactionInstructions(tx)) {
    if (!ix.programId.equals(SystemProgram.programId)) continue;

    let type = null;
    try {
      type = SystemInstruction.decodeInstructionType(ix);
    } catch {
      continue;
    }
    if (type !== "Transfer" && type !== "TransferWithSeed") continue;

    const decoded = type === "Transfer"
      ? SystemInstruction.decodeTransfer(ix)
      : SystemInstruction.decodeTransferWithSeed(ix);
    const source = decoded.fromPubkey?.toString();
    const destination = decoded.toPubkey?.toString();
    if (source === owner && !allowed.has(destination)) {
      throw new Error(
        `Relay transaction contains direct SOL transfer from owner to ${destination?.slice(0, 8) || "unknown"}.`,
      );
    }
  }
}
