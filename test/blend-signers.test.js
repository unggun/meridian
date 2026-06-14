// Regression test for the blend deploy "unknown signer" bug (2026-06-14).
//
// `initializePositionAndAddLiquidityByWeight` splits at MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX
// (26 bins) into an array: [preInstructionsTx (initializePosition → position IS a signer),
//  mainTx (addLiquidity → position referenced non-signer), postInstructionsTx (unwrap SOL
//  → position not referenced at all)]. The deploy loop signed EVERY tx with the position
// keypair, so web3.js threw `unknown signer` on the unwrap-SOL tx (which never references
// the position). The fix: only pass the position signer to txs that actually require it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { txNeedsPositionSigner } from "../tools/liquidity-blend.js";

const position = Keypair.generate().publicKey;
const wallet = Keypair.generate().publicKey;

// preInstructionsTx — initializePosition makes the new position account a signer.
const preInstructionsTx = {
  instructions: [
    { keys: [
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: position, isSigner: true, isWritable: true },
    ] },
  ],
};

// mainTx — addLiquidityOneSide references position as a writable NON-signer.
const mainTx = {
  instructions: [
    { keys: [
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
    ] },
  ],
};

// postInstructionsTx — unwrap WSOL, position not referenced at all (this is the tx that threw).
const postInstructionsTx = {
  instructions: [
    { keys: [{ pubkey: wallet, isSigner: true, isWritable: true }] },
  ],
};

test("position signer required only for the tx that creates the position", () => {
  assert.equal(txNeedsPositionSigner(preInstructionsTx, position), true);
  assert.equal(txNeedsPositionSigner(mainTx, position), false);
  assert.equal(txNeedsPositionSigner(postInstructionsTx, position), false);
});

test("single-sided SOL blend array signs exactly one tx with the position", () => {
  const txArray = [preInstructionsTx, mainTx, postInstructionsTx];
  const needing = txArray.filter((tx) => txNeedsPositionSigner(tx, position));
  assert.equal(needing.length, 1);
  assert.equal(needing[0], preInstructionsTx);
});

test("tolerates missing instructions/keys without throwing", () => {
  assert.equal(txNeedsPositionSigner({}, position), false);
  assert.equal(txNeedsPositionSigner({ instructions: [{}] }, position), false);
});
