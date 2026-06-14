// Pure leaf module: liquidity-shape blending. Imports ONLY the SDK's distribution
// calculators — never config.js — so it stays cycle-free and unit-testable.
import * as dlmmSdk from "@meteora-ag/dlmm";
import BN from "bn.js";
// SDK v1.9.4 interop: the distribution calculators are top-level named exports (and, on
// some builds, mirrored on the default export). Resolve from either so this stays robust.
const sdk = { ...(dlmmSdk.default ?? {}), ...dlmmSdk };
const { calculateSpotDistribution, calculateBidAskDistribution, calculateNormalDistribution } = sdk;

export const BLEND_SHAPES = {
  spot: calculateSpotDistribution,
  bid_ask: calculateBidAskDistribution,
  curve: calculateNormalDistribution,
};

const SUM_TOLERANCE = 0.001;

// Validate a raw strategyMix value into a clean { shape: fraction } object, or null.
// null means "no blend" — the caller falls back to the single configured strategy.
// A degenerate single-shape blend (one shape = 1.0) also normalizes to null.
export function normalizeStrategyMix(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;

  const entries = Object.entries(raw);
  if (entries.length === 0) return null;

  const cleaned = {};
  let sum = 0;
  for (const [shape, frac] of entries) {
    if (!(shape in BLEND_SHAPES)) return null;
    const n = Number(frac);
    if (!Number.isFinite(n) || n < 0) return null;
    if (n === 0) continue; // drop zero-weight shapes
    cleaned[shape] = n;
    sum += n;
  }

  if (Math.abs(sum - 1) > SUM_TOLERANCE) return null;

  const shapes = Object.keys(cleaned);
  if (shapes.length === 0) return null;
  if (shapes.length === 1) return null; // degenerate → use single strategy path

  return cleaned;
}

// Blend several SDK shape distributions over the same binIds into one BinAndAmount[].
// `mix` MUST already be normalized (see normalizeStrategyMix). Each side is summed in
// integer bps space and re-normalized to exactly 10000, with the rounding remainder
// assigned to the max-weight bin so the SDK never under-deploys.
export function buildBlendedDistribution(activeBin, binIds, mix) {
  const shapes = Object.entries(mix); // [ [shape, weight], ... ]
  const perShape = shapes.map(([shape, weight]) => ({
    weight,
    dist: BLEND_SHAPES[shape](activeBin, binIds),
  }));

  const rawX = binIds.map(() => 0);
  const rawY = binIds.map(() => 0);
  for (const { weight, dist } of perShape) {
    for (let i = 0; i < binIds.length; i++) {
      rawX[i] += weight * Number(dist[i].xAmountBpsOfTotal);
      rawY[i] += weight * Number(dist[i].yAmountBpsOfTotal);
    }
  }

  const x = normalizeBpsToTotal(rawX);
  const y = normalizeBpsToTotal(rawY);

  return binIds.map((binId, i) => ({
    binId,
    xAmountBpsOfTotal: new BN(x[i]),
    yAmountBpsOfTotal: new BN(y[i]),
  }));
}

// Round a float-bps array to integers summing to exactly 10000. If the side is all
// zeros (e.g. x side of a single-sided SOL deploy), leave it as zeros.
function normalizeBpsToTotal(raw) {
  const total = raw.reduce((s, v) => s + v, 0);
  if (total <= 0) return raw.map(() => 0);
  const rounded = raw.map((v) => Math.round(v));
  const diff = 10000 - rounded.reduce((s, v) => s + v, 0);
  if (diff !== 0) {
    // Pick the max-weight bin over the PRE-rounding floats (not the rounded ints) and,
    // on ties, keep the first index — intentional, so the choice is deterministic and
    // independent of rounding artifacts.
    let maxIdx = 0;
    for (let i = 1; i < raw.length; i++) if (raw[i] > raw[maxIdx]) maxIdx = i;
    // Invariant: rounded[maxIdx] += diff can never drive a bin negative. Each bin's
    // rounding error is in (-0.5, 0.5], so |diff| ≤ ⌈N/2⌉ (≤ 35 at the 69-bin cap),
    // while the max-weight bin holds the largest share of 10000 bps — far more than the
    // tiny remainder. No clamp needed.
    rounded[maxIdx] += diff;
  }
  return rounded;
}

// The blend deploy uses `initializePositionAndAddLiquidityByWeight`, which splits at the
// SDK's MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX (26 bins) into an array of transactions:
// [preInstructionsTx (initializePosition — the new position account IS a required signer),
//  mainTx (addLiquidity — position referenced as a NON-signer),
//  postInstructionsTx (unwrap WSOL — position not referenced at all)].
// Signing a tx with the position keypair when the tx doesn't reference it as a signer makes
// web3.js throw `unknown signer: <position>` (it threw on the unwrap-SOL tx, 2026-06-14).
// So sign each tx with the position keypair ONLY when it actually requires that signature.
// Robust to tx count/order, unlike a positional `i === 0` check.
export function txNeedsPositionSigner(tx, positionPubkey) {
  return (tx?.instructions ?? []).some((ix) =>
    (ix?.keys ?? []).some((k) => k.isSigner && k.pubkey?.equals(positionPubkey)),
  );
}
