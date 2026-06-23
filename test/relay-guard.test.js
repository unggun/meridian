// Regression test for the relay zap-out "direct SOL transfer from owner" rejection (2026-06-23).
//
// assertNoUnsafeSystemTransfer threw on ANY SystemProgram.Transfer out of the owner unless
// the destination was whitelisted. The zap-out call sites never passed a whitelist, so the
// OKX swap leg (which funds a transient router/WSOL account from the owner — destination
// varies every swap) was rejected 100% of the time, forcing the local-close + 5%-slippage
// Jupiter fallback. Fix: an `allowOwnerSystemTransfers` opt-in that defers to the caller's
// post-simulation net-lamport-loss guard (the authoritative protection).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, Transaction, SystemProgram } from "@solana/web3.js";
import { assertNoUnsafeSystemTransfer } from "../tools/relay-guard.js";

const ownerKp = Keypair.generate();
const wallet = { publicKey: ownerKp.publicKey };
const destination = Keypair.generate().publicKey;

function ownerTransferTx() {
  return new Transaction().add(
    SystemProgram.transfer({ fromPubkey: ownerKp.publicKey, toPubkey: destination, lamports: 1000 }),
  );
}

test("throws on an owner SOL transfer to a non-whitelisted destination (preserved default)", () => {
  assert.throws(
    () => assertNoUnsafeSystemTransfer(ownerTransferTx(), wallet),
    /direct SOL transfer from owner/,
  );
});

test("does not throw when the destination is whitelisted (preserved)", () => {
  assert.doesNotThrow(
    () => assertNoUnsafeSystemTransfer(ownerTransferTx(), wallet, [destination.toString()]),
  );
});

test("ignores transfers that do not originate from the owner (preserved)", () => {
  const other = Keypair.generate();
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: other.publicKey, toPubkey: destination, lamports: 1000 }),
  );
  assert.doesNotThrow(() => assertNoUnsafeSystemTransfer(tx, wallet));
});

test("allowOwnerSystemTransfers: true permits an owner SOL transfer (new)", () => {
  assert.doesNotThrow(
    () => assertNoUnsafeSystemTransfer(ownerTransferTx(), wallet, [], { allowOwnerSystemTransfers: true }),
  );
});
