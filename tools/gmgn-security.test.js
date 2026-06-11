import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";
import { passBasicRankFilter, condenseGmgnCandidate } from "./gmgn.js";

// Rank-entry fixture that passes every Stage1 threshold except (potentially)
// the creator-hold gate. Thresholds are read from live config so the test
// doesn't depend on specific gmgn-config.json values.
function passingToken(overrides = {}) {
  const g = config.gmgn;
  return {
    address: "MintAddr1111111111111111111111111111111111",
    symbol: "TEST",
    market_cap: Number(g.minMcap || 0) + 1,
    bundler_rate: 0,
    volume: Number(g.minVolume || 0) + 1,
    creation_timestamp: Math.floor(Date.now() / 1000) - ((Number(g.minTokenAgeHours) || 0) + 1) * 3600,
    creator_token_status: "creator_close",
    ...overrides,
  };
}

function withGmgnConfig(patch, fn) {
  const g = config.gmgn;
  const saved = {};
  for (const k of Object.keys(patch)) {
    saved[k] = g[k];
    g[k] = patch[k];
  }
  try {
    fn();
  } finally {
    Object.assign(g, saved);
  }
}

test("creator_hold passes Stage1 filter in log-only mode (default)", () => {
  withGmgnConfig({ creatorHoldGate: true, creatorHoldGateLogOnly: true }, () => {
    const check = passBasicRankFilter(passingToken({ creator_token_status: "creator_hold" }));
    assert.equal(check.pass, true, `unexpected reasons: ${check.reasons.join(", ")}`);
  });
});

test("creator_hold is rejected when the gate is enforced", () => {
  withGmgnConfig({ creatorHoldGate: true, creatorHoldGateLogOnly: false }, () => {
    const check = passBasicRankFilter(passingToken({ creator_token_status: "creator_hold" }));
    assert.equal(check.pass, false);
    assert.ok(check.reasons.some((r) => r.includes("creator still holding")), check.reasons.join(", "));
  });
});

test("creator_close is not rejected even when the gate is enforced", () => {
  withGmgnConfig({ creatorHoldGate: true, creatorHoldGateLogOnly: false }, () => {
    const check = passBasicRankFilter(passingToken({ creator_token_status: "creator_close" }));
    assert.equal(check.pass, true, `unexpected reasons: ${check.reasons.join(", ")}`);
  });
});

test("creator_hold passes when the gate is disabled outright", () => {
  withGmgnConfig({ creatorHoldGate: false, creatorHoldGateLogOnly: false }, () => {
    const check = passBasicRankFilter(passingToken({ creator_token_status: "creator_hold" }));
    assert.equal(check.pass, true, `unexpected reasons: ${check.reasons.join(", ")}`);
  });
});

test("condenseGmgnCandidate carries Stage1 security/dev fields for the signal snapshot", () => {
  const token = passingToken({
    rug_ratio: 0.25,
    creator_token_status: "creator_hold",
    is_wash_trading: false,
    sniper_count: 5,
    twitter_create_token_count: 488,
  });
  const candidate = condenseGmgnCandidate({
    token,
    pool: { address: "PoolAddr111", name: "TEST-SOL", pool_config: { bin_step: 100, base_fee_pct: 2 } },
    poolDetail: null,
    security: {},
    info: {
      dev: { creator_address: "DevAddr111", creator_open_count: 87, twitter_create_token_count: 488 },
      price: { price: 0.001 },
    },
    infoAnalysis: {},
    holdersAnalysis: { kolHolding: 0, smartHolding: 0, smartAccumulating: 0, smartExiting: 0, mostlyExited: 0 },
    indicatorSignal: null,
  });
  assert.equal(candidate.gmgn_rug_ratio, 0.25);
  assert.equal(candidate.gmgn_creator_token_status, "creator_hold");
  assert.equal(candidate.gmgn_wash_trading, false);
  assert.equal(candidate.gmgn_creator_open_count, 87);
  assert.equal(candidate.gmgn_twitter_create_token_count, 488);
});
