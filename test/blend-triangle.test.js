// Tests for the `triangle` blend shape — a LINEAR ramp (weight ∝ distance from the active
// bin), matching the by-strategy StrategyType.BidAsk on-chain shape, unlike the SDK's
// calculateBidAskDistribution (exponential spike) that the other blend bid_ask uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLEND_SHAPES,
  normalizeStrategyMix,
  buildBlendedDistribution,
} from "../tools/liquidity-blend.js";

const ACTIVE = -279;
const binIds = [];
for (let b = -314; b <= -279; b++) binIds.push(b); // 36 bins, low -> high (active = top)

const yb = (d, i) => Number(d[i].yAmountBpsOfTotal);
const xb = (d, i) => Number(d[i].xAmountBpsOfTotal);

test("triangle is a registered blend shape", () => {
  assert.ok("triangle" in BLEND_SHAPES);
});

test("triangle Y side is a linear ramp: max at far edge, 0 at active bin", () => {
  const d = BLEND_SHAPES.triangle(ACTIVE, binIds);
  // far edge (-314, index 0) is the largest; active bin (-279, last) is zero.
  assert.ok(yb(d, 0) > 0);
  assert.equal(yb(d, binIds.length - 1), 0); // active bin
  // strictly decreasing from far edge toward active
  for (let i = 1; i < binIds.length - 1; i++) {
    assert.ok(yb(d, i) < yb(d, i - 1), `bin ${binIds[i]} should be < previous`);
  }
  // linear on the interior: consecutive drops equal within rounding (±2 bps). The far-edge
  // bin (index 0) is skipped — by design it absorbs normalizeBpsToTotal's rounding remainder.
  const drops = [];
  for (let i = 2; i < binIds.length - 1; i++) drops.push(yb(d, i - 1) - yb(d, i));
  const maxDrop = Math.max(...drops);
  const minDrop = Math.min(...drops);
  assert.ok(maxDrop - minDrop <= 2, `ramp not linear: drops range ${minDrop}..${maxDrop}`);
});

test("triangle Y side sums to 10000 bps; X side empty for single-sided-below", () => {
  const d = BLEND_SHAPES.triangle(ACTIVE, binIds);
  const ySum = binIds.reduce((s, _, i) => s + yb(d, i), 0);
  const xSum = binIds.reduce((s, _, i) => s + xb(d, i), 0);
  assert.equal(ySum, 10000);
  assert.equal(xSum, 0);
});

test("triangle X side ramps for bins above the active bin", () => {
  const ids = [];
  for (let b = -5; b <= 5; b++) ids.push(b); // active 0, bins both sides
  const d = BLEND_SHAPES.triangle(0, ids);
  // furthest above (b=5, last) is the largest X; active (b=0) is zero
  assert.ok(xb(d, ids.length - 1) > 0);
  assert.equal(xb(d, ids.indexOf(0)), 0);
  const xSum = ids.reduce((s, _, i) => s + xb(d, i), 0);
  assert.equal(xSum, 10000);
});

test("normalizeStrategyMix accepts {triangle, spot}", () => {
  assert.deepEqual(normalizeStrategyMix({ triangle: 0.8, spot: 0.2 }), {
    triangle: 0.8,
    spot: 0.2,
  });
});

test("triangle+spot blend: linear ramp plus a nonzero spot floor", () => {
  const d = buildBlendedDistribution(ACTIVE, binIds, { triangle: 0.8, spot: 0.2 });
  const ySum = binIds.reduce((s, _, i) => s + yb(d, i), 0);
  assert.equal(ySum, 10000); // re-normalized to exactly 10000
  // far edge dominates, and the inner bins keep a spot floor (not ~0 like exponential)
  assert.ok(yb(d, 0) > yb(d, 10));
  const innerFloor = yb(d, binIds.length - 6); // a near-active inner bin (not the active bin)
  assert.ok(innerFloor > 30, `expected a spot floor > 30 bps, got ${innerFloor}`);
});
