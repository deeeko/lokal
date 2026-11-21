// Writes the site's static rate.json (GitHub Pages refreshes it every 30 min; on Vercel it is the fallback
// behind the live /api/rate). Read-only: no wallet, no keys, no transactions. Logic lives in lib/rate.mjs.
import fs from "node:fs";
import path from "node:path";
import { buildRate } from "../lib/rate.mjs";

const out = process.argv[2] ?? "site/rate.json";
const result = await buildRate({ timeoutMs: 30_000, carryForwardUrl: "https://deeeko.github.io/lokal/rate.json" });
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
