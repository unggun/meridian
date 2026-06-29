// Regression test for the "decided CLOSE but never executed" bug (TURTLE-SOL 2026-06-17).
//
// The management cycle computes a deterministic action per position (CLOSE / CLAIM /
// INSTRUCTION / STAY) and used to hand EVERY non-STAY action to the LLM to execute.
// The LLM (MiniMax-M2.7) "decided" to close in its reasoning but never emitted the
// close_position tool call, so the position stayed open while the report said CLOSE.
//
// Fix: CLOSE is fully determined by the rules — partition it out and execute it
// directly via executeTool, never through the LLM. Only actions that genuinely need
// language evaluation (INSTRUCTION) — or are simply left to the LLM (CLAIM) — route
// to the model. STAY is never executed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { partitionManagementActions, shouldDirectCloseExit, canDirectCloseNow } from "../management-routing.js";

test("CLOSE actions route to direct execution, not the LLM", () => {
  const entries = [
    { position: "A", action: "CLOSE", rule: "chart_exit", reason: "15m bearish" },
  ];
  const { directCloses, llmActions } = partitionManagementActions(entries);
  assert.equal(directCloses.length, 1);
  assert.equal(directCloses[0].position, "A");
  assert.equal(llmActions.length, 0);
});

test("every CLOSE rule (numbered, exit, chart_exit) routes direct", () => {
  const entries = [
    { position: "A", action: "CLOSE", rule: 1, reason: "stop loss" },
    { position: "B", action: "CLOSE", rule: "exit", reason: "trailing tp" },
    { position: "C", action: "CLOSE", rule: "chart_exit", reason: "rollover" },
  ];
  const { directCloses, llmActions } = partitionManagementActions(entries);
  assert.deepEqual(directCloses.map(e => e.position), ["A", "B", "C"]);
  assert.equal(llmActions.length, 0);
});

test("CLAIM and INSTRUCTION still route to the LLM", () => {
  const entries = [
    { position: "A", action: "CLAIM" },
    { position: "B", action: "INSTRUCTION" },
  ];
  const { directCloses, llmActions } = partitionManagementActions(entries);
  assert.equal(directCloses.length, 0);
  assert.deepEqual(llmActions.map(e => e.position), ["A", "B"]);
});

test("STAY is never executed nor routed", () => {
  const entries = [
    { position: "A", action: "STAY" },
    { position: "B", action: "CLOSE", rule: 1, reason: "stop loss" },
  ];
  const { directCloses, llmActions } = partitionManagementActions(entries);
  assert.deepEqual(directCloses.map(e => e.position), ["B"]);
  assert.equal(llmActions.length, 0);
});

// ── PnL-poller fast-path eligibility ──────────────────────────────────
// The poller closes deterministic exits directly (no management-cycle round-trip).
// Stop-loss already did; trailing TP / take profit now do too so they fire within
// seconds instead of waiting up to managementIntervalMin.

test("stop loss closes directly from poller by default", () => {
  assert.equal(shouldDirectCloseExit("STOP_LOSS", {}), true);
});

test("stop loss respects directStopLossClose=false", () => {
  assert.equal(shouldDirectCloseExit("STOP_LOSS", { directStopLossClose: false }), false);
});

test("trailing TP and take profit close directly by default", () => {
  assert.equal(shouldDirectCloseExit("TRAILING_TP", {}), true);
  assert.equal(shouldDirectCloseExit("TAKE_PROFIT", {}), true);
});

test("trailing TP / take profit respect directProfitClose=false", () => {
  assert.equal(shouldDirectCloseExit("TRAILING_TP", { directProfitClose: false }), false);
  assert.equal(shouldDirectCloseExit("TAKE_PROFIT", { directProfitClose: false }), false);
});

test("directStopLossClose and directProfitClose are independent gates", () => {
  // disabling stop-loss direct close must not disable profit direct closes
  assert.equal(shouldDirectCloseExit("TRAILING_TP", { directStopLossClose: false }), true);
  // and vice versa
  assert.equal(shouldDirectCloseExit("STOP_LOSS", { directProfitClose: false }), true);
});

test("non-fast-path exits (OOR / unknown / missing) do not close directly", () => {
  assert.equal(shouldDirectCloseExit("OOR", {}), false);
  assert.equal(shouldDirectCloseExit("LOW_YIELD", {}), false);
  assert.equal(shouldDirectCloseExit(undefined, {}), false);
});

// ── Direct-close concurrency guard ────────────────────────────────────
// Realized PnL is a global wallet delta; overlapping close windows double-count
// each other's recovered SOL. A timer-driven direct close (trailing-drop / peak /
// TP confirmation setTimeout) bypasses the management mutex, so it must re-check
// the lock before opening its window. Hobbes (trailing TP, poll path) + world
// (Rule 3, management path) both reported ~+1.50◎ / +155% realized on 2026-06-29
// when their close windows overlapped while mark PnL was ~+1.5%.

test("direct close allowed when no other SOL-moving cycle is in flight", () => {
  assert.equal(canDirectCloseNow({ managementBusy: false, screeningBusy: false }), true);
  assert.equal(canDirectCloseNow({}), true);
  assert.equal(canDirectCloseNow(), true);
});

test("direct close deferred while a management cycle holds the lock", () => {
  // The Hobbes+world contamination case: a confirmation timer must NOT close while
  // the management cycle is mid-close of another position.
  assert.equal(canDirectCloseNow({ managementBusy: true, screeningBusy: false }), false);
});

test("direct close deferred while a screener deploy is in flight", () => {
  assert.equal(canDirectCloseNow({ managementBusy: false, screeningBusy: true }), false);
});
