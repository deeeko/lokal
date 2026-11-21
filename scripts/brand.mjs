// Re-renders every image made from the Lokal logo (docs/brand/lokal-mark.svg, the white cursive L with the yellow
// swoosh). Run it after editing the logo:
//
//   node scripts/brand.mjs
//
// 1. copies docs/brand/lokal-mark.svg to site/logo.svg and docs/brand/lokal-favicon.svg to site/favicon.svg, and gives
//    every reference to the brand images a new ?v= (scripts/asset-version.mjs; BRAND_VERSION sets it);
// 2. renders site/logo.png (512 px) and site/apple-touch-icon.png (180 px), with transparent corners;
// 3. renders the social card site/og.png (1200 x 630) from the landing hero, with the site's own CSS and fonts.
//
// Needs Google Chrome and playwright-core, which is NOT a dependency of this repo (nothing to install for the site).
// Point at them with PLAYWRIGHT_CORE (a folder that has node_modules/playwright-core, or an npx cache folder) and
// CHROME (chrome.exe). Sends nothing anywhere: only local files are loaded, every other request is blocked.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { setAssetVersion } from "./asset-version.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SITE = path.join(ROOT, "site");
const BRAND = path.join(ROOT, "docs", "brand");

const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
let pw;
try { pw = createRequire(path.join(process.env.PLAYWRIGHT_CORE ?? ROOT, "x.js"))("playwright-core"); }
catch { console.error('playwright-core not found. Set PLAYWRIGHT_CORE to a folder whose node_modules has it (e.g. an npx cache folder after "npx playwright-core --version").'); process.exit(1); }

// 1. the logo
fs.copyFileSync(path.join(BRAND, "lokal-mark.svg"), path.join(SITE, "logo.svg"));
fs.copyFileSync(path.join(BRAND, "lokal-favicon.svg"), path.join(SITE, "favicon.svg"));
console.log("site/logo.svg and site/favicon.svg updated.");
// New images need a new ?v= on every reference, or browsers and the CDN keep showing the old ones (vercel.json caches them).
const assetVersion = process.env.BRAND_VERSION ?? `lokal-${Date.now().toString(36)}`;
const versioned = setAssetVersion(assetVersion);
console.log(`Brand images now load as ?v=${assetVersion} (${versioned.length} file(s) updated).`);

// a tiny static server for site/ and docs/brand/ (the CSP on the pages wants http, not file://)
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const pages = new Map(); // in-memory helper pages
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (pages.has(rel)) { res.writeHead(200, { "content-type": TYPES[".html"] }); return res.end(pages.get(rel)); }
  const base = rel.startsWith("/_brand/") ? BRAND : SITE;
  const file = path.resolve(base, rel.replace(/^\/(_brand\/)?/, "") || "index.html");
  if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await pw.chromium.launch({ executablePath: CHROME });
const newPage = async (opts) => {
  const ctx = await browser.newContext(opts);
  await ctx.route("**/*", (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
  return ctx.newPage();
};
try {
  // 2. app icons
  pages.set("/_icon.html", `<!doctype html><html><head><style>html,body{margin:0;background:transparent}img{display:block;width:100vw;height:100vh}</style></head><body><img src="/logo.svg" alt=""></body></html>`);
  for (const [out, size] of [["site/logo.png", 512], ["site/apple-touch-icon.png", 180]]) {
    const p = await newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await p.goto(`${origin}/_icon.html`);
    await p.waitForFunction(() => document.images[0].complete);
    fs.mkdirSync(path.dirname(path.join(ROOT, out)), { recursive: true });
    await p.screenshot({ path: path.join(ROOT, out), omitBackground: true });
    await p.close();
    console.log(`${out} (${size} x ${size})`);
  }

  // 3. the social card: the Overview hero alone, sized for 1200 x 630
  {
    const p = await newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await p.addInitScript(() => { try { localStorage.setItem("np-consent", "declined"); } catch {} });
    await p.goto(`${origin}/index.html`, { waitUntil: "load" });
    await p.addStyleTag({ content: `
      *, *::before, *::after { animation: none !important; transition: none !important; }
      .sidebar, .sb-scrim, .nav-wrap, .site-footer, #consent, main > section:not(.hero), noscript { display: none !important; }
      html, body { padding: 0 !important; margin: 0 !important; overflow: hidden !important; }
      main { margin: 0 !important; padding: 0 !important; }
      .hero { padding: 84px 60px 0 !important; }
      .hero .tile { width: 96px !important; height: 96px !important; margin-bottom: 30px !important; }
      .hero .display { font-size: 80px !important; max-width: 21ch !important; }
      .hero .lead { max-width: 60ch !important; margin-left: auto !important; margin-right: auto !important; }
    ` });
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(300);
    await p.screenshot({ path: path.join(SITE, "og.png") });
    await p.close();
    console.log("site/og.png (1200 x 630)");
  }

} finally {
  await browser.close();
  server.close();
}
