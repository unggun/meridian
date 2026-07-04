// Locks in the OOR-polarity guidance in the system prompt.
//
// The agent is single-sided SOL / bins_below only, so going out of range to the
// UPSIDE (price above the range) is a benign exit: ~100% SOL, zero impermanent
// loss, fees already collected. The MANAGER prompt used to frame OOR purely as a
// problem ("if it's out of range, will it come back?"), and the SCREENER treated
// any past OOR close as a skip signal — both wrong polarity for this strategy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../prompt.js";

test("MANAGER prompt frames an above-range OOR exit as benign, not a failure", () => {
  const p = buildSystemPrompt("MANAGER", { balance_sol: 1 }, []);
  assert.ok(p.includes("ZERO impermanent loss"), "must state an above-range exit has zero IL");
  assert.ok(p.includes("BENIGN exit"), "must call an above-range OOR exit benign");
});

test("SCREENER prompt states an above-range OOR close is not a skip signal", () => {
  const p = buildSystemPrompt("SCREENER", { balance_sol: 1 }, []);
  assert.ok(
    p.includes("above-range OOR close is NOT a loss"),
    "screener must not treat a prior above-range OOR close as a loss/skip signal",
  );
});
