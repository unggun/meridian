#!/usr/bin/env node
// One-off: apply 24h cooldown to every Crashout-SOL pool entry in pool-memory.
// Rationale: 4 losses / 12 recent trades (33% loss rate) — pause deploys while we reassess.

import { cooldownPoolsByName } from "../pool-memory.js";

const count = cooldownPoolsByName("Crashout", 24, "Diagnostic cooldown — 4 losses in last 12 trades (2026-04-18 review)");
console.log(`Cooldown set on ${count} Crashout pool(s).`);
