#!/usr/bin/env node
// One-off: close a specific zombie position that's on-chain but not in state.json.
// Primes the _positionsCache via getMyPositions() so lookupPoolForPosition can find the pool.

import "dotenv/config";
import { getMyPositions, closePosition } from "../tools/dlmm.js";

const POSITION = process.argv[2];
if (!POSITION) {
  console.error("Usage: node scripts/close-zombie-position.js <position_address>");
  process.exit(1);
}

async function main() {
  console.log(`Priming positions cache via portfolio API...`);
  const positions = await getMyPositions({ force: true });
  const match = positions.positions.find((p) => p.position === POSITION);
  if (!match) {
    console.error(`Position ${POSITION} not found in portfolio API. Already closed?`);
    process.exit(1);
  }
  console.log(`Found: ${match.pair} (pool ${match.pool}), value=$${match.total_value_usd}, age=${match.age_minutes}m`);

  console.log(`Closing...`);
  const result = await closePosition({ position_address: POSITION, reason: "zombie cleanup — failed deploy at 13:09 UTC" });
  console.log("Result:", JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error(e.stack);
  process.exit(1);
});
