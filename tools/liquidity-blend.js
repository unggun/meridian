// Pure leaf module: liquidity-shape blending. Imports ONLY the SDK's distribution
// calculators — never config.js — so it stays cycle-free and unit-testable.
import pkg from "@meteora-ag/dlmm";
const { calculateSpotDistribution, calculateBidAskDistribution, calculateNormalDistribution } = pkg;

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
