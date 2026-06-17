/**
 * Partition per-position management actions into those the cron executes
 * deterministically in-process vs those handed to the LLM.
 *
 * CLOSE is fully determined by the deterministic rules (stop loss / pumped /
 * OOR / low yield / trailing TP / chart exit) — there is no language judgement
 * left to make, so it must be executed directly via executeTool. Routing it
 * through the LLM let a model "decide" to close in its reasoning yet never emit
 * the close_position tool call, leaving the position open while the report said
 * CLOSE (TURTLE-SOL 2026-06-17). CLAIM is deterministic too but left on the LLM
 * path; INSTRUCTION genuinely needs natural-language evaluation. STAY is a no-op.
 */
export function partitionManagementActions(entries) {
  const directCloses = [];
  const llmActions = [];
  for (const entry of entries) {
    if (entry.action === "CLOSE") directCloses.push(entry);
    else if (entry.action !== "STAY") llmActions.push(entry);
  }
  return { directCloses, llmActions };
}
