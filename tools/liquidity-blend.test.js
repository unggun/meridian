import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeStrategyMix } from "./liquidity-blend.js";

test("valid 80/20 bid_ask+spot blend is returned normalized", () => {
  assert.deepEqual(normalizeStrategyMix({ bid_ask: 0.8, spot: 0.2 }), { bid_ask: 0.8, spot: 0.2 });
});

test("null / undefined / empty object → null (no blend)", () => {
  assert.equal(normalizeStrategyMix(null), null);
  assert.equal(normalizeStrategyMix(undefined), null);
  assert.equal(normalizeStrategyMix({}), null);
});

test("degenerate single-shape blend (1.0) → null (use single strategy)", () => {
  assert.equal(normalizeStrategyMix({ bid_ask: 1.0 }), null);
  assert.equal(normalizeStrategyMix({ spot: 1 }), null);
});

test("drops zero-weight shapes before the degenerate check", () => {
  assert.deepEqual(normalizeStrategyMix({ bid_ask: 0.7, spot: 0.3, curve: 0 }), { bid_ask: 0.7, spot: 0.3 });
});

test("sum not ≈ 1 → null", () => {
  assert.equal(normalizeStrategyMix({ bid_ask: 0.8, spot: 0.1 }), null);
  assert.equal(normalizeStrategyMix({ bid_ask: 0.8, spot: 0.4 }), null);
});

test("unknown shape key → null", () => {
  assert.equal(normalizeStrategyMix({ bid_ask: 0.8, wedge: 0.2 }), null);
});

test("negative or non-finite fraction → null", () => {
  assert.equal(normalizeStrategyMix({ bid_ask: 1.2, spot: -0.2 }), null);
  assert.equal(normalizeStrategyMix({ bid_ask: 0.8, spot: NaN }), null);
});

test("non-object input → null", () => {
  assert.equal(normalizeStrategyMix("bid_ask"), null);
  assert.equal(normalizeStrategyMix([0.8, 0.2]), null);
  assert.equal(normalizeStrategyMix(0.8), null);
});

test("tolerance: sum within ±0.001 of 1 is accepted", () => {
  assert.deepEqual(normalizeStrategyMix({ bid_ask: 0.8005, spot: 0.1995 }), { bid_ask: 0.8005, spot: 0.1995 });
});

import * as dlmmSdk from "@meteora-ag/dlmm";
const sdk = { ...(dlmmSdk.default ?? {}), ...dlmmSdk };
const { calculateSpotDistribution, calculateBidAskDistribution } = sdk;
import { buildBlendedDistribution } from "./liquidity-blend.js";

const ACTIVE = 1000;
const BINS = [997, 998, 999, 1000]; // single-sided SOL: all binIds <= active

const ySum = (dist) => dist.reduce((s, b) => s + Number(b.yAmountBpsOfTotal), 0);

test("blend y-bps match the hand-computed 80/20 fixture and sum to 10000", () => {
  const dist = buildBlendedDistribution(ACTIVE, BINS, { bid_ask: 0.8, spot: 0.2 });
  assert.deepEqual(dist.map((b) => b.binId), BINS);
  assert.deepEqual(dist.map((b) => Number(b.yAmountBpsOfTotal)), [7806, 1165, 703, 326]);
  assert.equal(ySum(dist), 10000);
});

test("each blended y-bps lies between the two pure SDK distributions", () => {
  const spot = calculateSpotDistribution(ACTIVE, BINS);
  const ba = calculateBidAskDistribution(ACTIVE, BINS);
  const dist = buildBlendedDistribution(ACTIVE, BINS, { bid_ask: 0.8, spot: 0.2 });
  for (let i = 0; i < BINS.length; i++) {
    const lo = Math.min(Number(spot[i].yAmountBpsOfTotal), Number(ba[i].yAmountBpsOfTotal));
    const hi = Math.max(Number(spot[i].yAmountBpsOfTotal), Number(ba[i].yAmountBpsOfTotal));
    const y = Number(dist[i].yAmountBpsOfTotal);
    assert.ok(y >= lo - 1 && y <= hi + 1, `bin ${BINS[i]}: ${y} not in [${lo},${hi}]`);
  }
});

test("single-sided (all bins <= active) → x-bps all zero", () => {
  const dist = buildBlendedDistribution(ACTIVE, [997, 998, 999], { bid_ask: 0.8, spot: 0.2 });
  assert.deepEqual(dist.map((b) => Number(b.xAmountBpsOfTotal)), [0, 0, 0]);
});

test("degenerate-equivalent weights reproduce a pure SDK distribution (parity)", () => {
  // 0.999/0.001 is within tolerance and exercises the blend path; compare to pure bid_ask.
  const ba = calculateBidAskDistribution(ACTIVE, BINS);
  const dist = buildBlendedDistribution(ACTIVE, BINS, { bid_ask: 0.999, spot: 0.001 });
  // dominant shape: each bin within a few bps of pure bid_ask, total still 10000.
  for (let i = 0; i < BINS.length; i++) {
    assert.ok(Math.abs(Number(dist[i].yAmountBpsOfTotal) - Number(ba[i].yAmountBpsOfTotal)) <= 30);
  }
  assert.equal(ySum(dist), 10000);
});

test("returns BN instances for both sides", () => {
  const dist = buildBlendedDistribution(ACTIVE, BINS, { bid_ask: 0.8, spot: 0.2 });
  assert.equal(typeof dist[0].yAmountBpsOfTotal.toString, "function");
  assert.equal(typeof dist[0].xAmountBpsOfTotal.toString, "function");
});
