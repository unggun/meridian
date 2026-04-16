import "dotenv/config";
import { swapToken } from "../tools/wallet.js";

const PEPE_MINT = "EkJuyYyD3to61CHVPJn6wHb7xANxvqApnVJ4o2SdBAGS";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const AMOUNT = 68125.91368792;

console.log(`Swapping ${AMOUNT} PEPE -> SOL...`);
const r = await swapToken({ input_mint: PEPE_MINT, output_mint: SOL_MINT, amount: AMOUNT });
console.log(JSON.stringify(r, null, 2));
process.exit(r?.success ? 0 : 1);
