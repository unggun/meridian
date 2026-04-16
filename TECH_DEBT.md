# Meridian — Tech Debt

Living log of known issues and deferred fixes. Not committed.

---

## `lookupPoolForPosition` fails for untracked positions on RPCs that throttle `getProgramAccounts`

**File:** `tools/dlmm.js:994` (`lookupPoolForPosition`)
**Surfaces as:** `close_position` returns `"Position X not found in open positions"` for any position that isn't in `state.json` and isn't already in the in-memory `_positionsCache`.

### When it bites
- A deploy that partially succeeds (position account created, liquidity-add tx reverts — e.g. `ExceededBinSlippageTolerance`). `trackPosition()` never runs, so `state.json` never learns about the phantom account.
- Closing it requires either (a) a warm `_positionsCache` from a prior `getMyPositions` call in the same process, or (b) a working `getProgramAccounts` + memcmp on the RPC. Many paid/public RPCs throttle or don't honor that filter, returning 0 pools silently.

### Observed
- 2026-04-14: phantom PEPE/SOL position `4X4Fxjxr75eZJZ1QTkpgWfFh9THP5LqwUurDYyHn4ssF` in pool `5RNNDDW41H7FpTERBCgiwWRMtskxQkiDH3orfs39LyaP` couldn't be closed via the tool. Closed manually by calling `DLMM.create(pool).closePosition()` directly with the pool address from the Meteora portfolio API. Tx: `5tXqSfJhx9BWMorkhiAKMd2JqBBPL15x2tMJMsrJeYz6zjALtQo1aHXH6dPqg1LY9zGPtmA8D2jXUJtbBwpxEcNA`. Reclaimed ~0.073 SOL rent.

### Why it rarely matters
- In the agent runtime, `getMyPositions` runs on the management cron every `managementIntervalMin` and populates `_positionsCache`, which `lookupPoolForPosition` checks before the SDK scan. Tool calls from the LLM or Telegram within that runtime generally succeed.
- The failure mode is effectively "one-shot script / cold process tries to close a phantom."

### Minimal fix (when it's worth doing)
In `closePosition` (tools/dlmm.js:765), if `lookupPoolForPosition` throws, auto-call `getMyPositions({ force: true })` once and retry. ~4 lines, no new endpoint dependency, just warms the cache the function already consults.

### Larger fix (not recommended right now)
Extend `lookupPoolForPosition` to consult `dlmm.datapi.meteora.ag/portfolio/open?user=<wallet>` before the SDK scan. Trade-offs:
- New hard dependency on Meteora's hosted datapi for the close path.
- Needs program-id guard so future DLMM-v2 / DAMM positions don't get handed to `DLMM.create()` (v1).
- Staleness window: portfolio API can lag chain by a few seconds.
- Keep SDK scan as final fallback either way.

### Workaround (today)
```js
const pool = await DLMM.create(connection, new PublicKey(poolAddr));
const tx = await pool.closePosition({
  owner: wallet.publicKey,
  position: { publicKey: new PublicKey(positionAddr) },
});
const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
```
Discover the pool address for an untracked position via the portfolio API:
`https://dlmm.datapi.meteora.ag/portfolio/open?user=<wallet>`

---

## Partial night-mode coverage in position exits

**File:** `state.js:435-457` (stop loss + trailing TP blocks)
**Surfaces as:** stop loss honours `nightStopLossPct`, but trailing-TP's `trailingDropPct` keeps reading from `mgmtConfig` directly — so night mode doesn't tighten the trailing exit even though high-vol hours are exactly when it should.

### Why it's like this
Plan `2026-04-16-night-mode-and-winner-cooldown.md` only scoped the stop-loss check. Wiring trailing-TP and the OOR-timeout path through `getEffectiveManagementConfig()` was left for a follow-up so this commit stayed minimal and reviewable.

### Proper fix
Drop the `mgmtConfig` parameter from `updatePnlAndCheckExits` entirely and resolve `effMgmt = getEffectiveManagementConfig()` once at the top of the function. Then every exit check (stop loss, trailing TP, OOR, rule-3 pumped) reads from the same night-aware source. Add a night-specific `nightTrailingDropPct` if we want tighter trailing at night.
