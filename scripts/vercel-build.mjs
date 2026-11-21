// Vercel build step = the deploy gate. Runs on every push (production) and every pull request (preview).
// If the tests or the site check fail, this exits non-zero and Vercel does NOT deploy.
import { execSync } from "node:child_process";
import fs from "node:fs";

const run = (cmd) => { console.log(`\n$ ${cmd}`); execSync(cmd, { stdio: "inherit" }); };

run("npm test");
run("node scripts/check-site.mjs");
run("node scripts/fetch-rate.mjs site/rate.json"); // static fallback behind the live /api/rate

// The site never ships the build spec / harness files.
fs.rmSync("site/_spec", { recursive: true, force: true });

// 404.html uses absolute URLs for GitHub Pages' /lokal/ prefix; on Vercel the site is at the root.
const f = "site/404.html";
fs.writeFileSync(f, fs.readFileSync(f, "utf8").replaceAll("/lokal/", "/"));
console.log("\nVercel build ready: tests and site check passed.");
