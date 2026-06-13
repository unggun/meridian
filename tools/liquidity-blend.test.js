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
