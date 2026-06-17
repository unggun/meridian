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
import { partitionManagementActions } from "../management-routing.js";

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
