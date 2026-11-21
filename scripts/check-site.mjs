// Static checks for the live site. Run in CI before every deploy: node scripts/check-site.mjs
// Fails (exit 1) on: broken internal links/assets, pages missing the CSP or the design system,
// page scripts that don't parse, or JSON/SVG assets that are malformed.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { assetVersions } from "./asset-version.mjs";

const SITE = path.resolve("site");
const errors = [];
const fail = (msg) => errors.push(msg);

const pages = fs.readdirSync(SITE).filter((f) => f.endsWith(".html"));
if (!pages.includes("index.html")) fail("site/index.html is missing");
// the dashboard, the gateway and the tag pages are linked from every page's sidebar and footer
for (const p of ["app.html", "start.html", "account.html", "tag.html"]) if (!pages.includes(p)) fail(`site/${p} is missing`);
/** Pages with their own chrome on purpose: the landing and the sign-up gateway (see the CHROME comment below). */
const OWN_CHROME = new Set(["index.html", "start.html"]);
/** The app sidebar, in order (the owner's brief, 21 Nov 2026). Account is an entry now; the user chip stays too. */
const SIDEBAR = "Dashboard=app.html, Send=quote.html, Get paid=get-paid.html, Activity=transactions.html, Account=account.html, Docs=docs.html";

for (const page of pages) {
  const html = fs.readFileSync(path.join(SITE, page), "utf8");
  const isFallback = page === "404.html"; // served for any missing path, so it uses absolute URLs

  if (!/http-equiv="Content-Security-Policy"/.test(html)) fail(`${page}: missing Content-Security-Policy meta`);
  if (!/assets\/styles\.css/.test(html)) fail(`${page}: does not load assets/styles.css`);
  if (!/<title>[^<]+<\/title>/.test(html)) fail(`${page}: missing <title>`);
  if (!isFallback && !/name="viewport"/.test(html)) fail(`${page}: missing viewport meta`);
  if (/\son[a-z]+="/i.test(html)) fail(`${page}: inline event handler found (blocked by CSP)`);

  // every local href/src must exist
  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    let ref = m[1];
    if (/^(https?:|mailto:|tel:|data:|#|ethereum:)/i.test(ref)) continue;
    ref = ref.split("#")[0].split("?")[0];
    if (!ref) continue;
    if (ref.startsWith("/lokal/")) ref = ref.slice("/lokal/".length) || "index.html";
    else if (ref.startsWith("/")) { fail(`${page}: root-absolute link "${m[1]}" will break on GitHub Pages`); continue; }
    if (ref.endsWith("/")) ref += "index.html";
    if (ref === "rate.json") continue; // generated at deploy time
    if (!fs.existsSync(path.join(SITE, ref))) fail(`${page}: broken link/asset "${m[1]}"`);
  }

  // App pages keep the same chrome: the sidebar (Dashboard, Send, Get paid, Activity, Account, Docs), the user chip
  // slots, the footer, the icons they use. The landing and the gateway have their own chrome (OWN_CHROME, below).
  if (!isFallback && !OWN_CHROME.has(page)) {
    const sb = (html.match(/<nav class="sb-nav"[^]*?<\/nav>/) || [""])[0];
    const entries = [...sb.matchAll(/<a href="([a-z0-9-]+\.html)" data-label="([^"]*)"/g)].map((m) => `${m[2]}=${m[1]}`).join(", ");
    if (entries !== SIDEBAR) fail(`${page}: sidebar should be exactly ${SIDEBAR} (found ${entries || "none"})`);
    // every page is reachable from the sidebar, directly or grouped under one entry (data-also);
    // tag.html is the public pay page for one tag: it may only sit under Send (paying someone), and has no tab strip
    const covered = new Map();
    for (const m of sb.matchAll(/href="([a-z0-9-]+\.html)"(?: data-label="[^"]*")?(?: data-also="([^"]*)")?/g)) {
      for (const p of [m[1], ...(m[2] || "").split(/\s+/).filter(Boolean)]) {
        if (covered.has(p)) fail(`${page}: ${p} is grouped under two sidebar entries`);
        covered.set(p, m[1]);
      }
    }
    if (covered.has("tag.html") && covered.get("tag.html") !== "quote.html") fail(`${page}: tag.html may only be grouped under Send (quote.html)`);
    for (const p of pages) if (p !== "404.html" && p !== "tag.html" && !OWN_CHROME.has(p) && !covered.has(p)) fail(`${page}: sidebar does not reach ${p} (add it to an entry's data-also)`);
    // a tab strip only links pages of this page's own group, and marks this page as current
    const strip = (html.match(/<nav class="subnav"[^]*?<\/nav>/) || [""])[0];
    if (strip) {
      for (const m of strip.matchAll(/href="([a-z0-9-]+\.html)"/g)) if (covered.get(m[1]) !== covered.get(page)) fail(`${page}: tab strip links ${m[1]}, which is outside this page's sidebar group`);
      if (!new RegExp(`href="${page.replace(".", "\\.")}" aria-current="page"`).test(strip)) fail(`${page}: tab strip should mark ${page} with aria-current="page"`);
    }
    if (!/\sid="sb-user"/.test(html)) fail(`${page}: sidebar is missing the user chip slot (id="sb-user")`);
    if (!/\sid="nav-user"/.test(html)) fail(`${page}: top bar is missing the sign-in button slot (id="nav-user")`);
    // signed out, the user chip leads to the sign-up gateway; the footer leads back to the landing ("About Lokal")
    if (!/<div class="sb-user" id="sb-user"><a [^>]*href="(?:\/lokal\/)?start\.html"/.test(html)) fail(`${page}: the signed-out user chip should link to start.html (the sign-up gateway)`);
    if (!/<footer class="site-footer">[^]*?href="(?:\/lokal\/)?index\.html\?about"/.test(html)) fail(`${page}: the footer should link "About Lokal" (index.html?about)`);
    const footProduct = (html.match(/<h4>Product<\/h4>\s*<ul>.*?<\/ul>/) || [""])[0];
    if (!/href="account\.html"/.test(footProduct)) fail(`${page}: footer Product list is missing the Lokal tag page (account.html)`);
    for (const id of ["user", "logout", "updown", "copy", "home", "info"]) if (!new RegExp(`<symbol id="i-${id}"`).test(html)) fail(`${page}: icon sprite is missing i-${id} (used by the user menu)`);
  }

  // The landing and the gateway: their own slim chrome, on purpose (see OWN_CHROME). No app sidebar, a slim top bar,
  // the privacy policy and terms in reach, and a way into the gateway.
  if (OWN_CHROME.has(page)) {
    if (/<aside class="sidebar"/.test(html)) fail(`${page}: has its own chrome, so it must not carry the app sidebar`);
    if (!/<header class="lp-bar">/.test(html)) fail(`${page}: missing its slim top bar (<header class="lp-bar">)`);
    for (const p of ["privacy.html", "terms.html"]) if (!html.includes(`href="${p}"`)) fail(`${page}: should link ${p}`);
    if (page !== "start.html" && !html.includes('href="start.html"')) fail(`${page}: should lead to the sign-up gateway (start.html)`);
    // only the landing sends signed-in visitors to the dashboard; the gateway must never bounce them away
    const gate = /<head>[^]*<script src="assets\/gate\.js"><\/script>[^]*<\/head>/.test(html);
    if (page === "index.html" && !gate) fail("index.html: should load assets/gate.js in <head> (signed-in visitors go to the dashboard)");
    if (page !== "index.html" && /assets\/gate\.js/.test(html)) fail(`${page}: only index.html may load assets/gate.js`);
  }

  // in-page anchors used by the sidebar/nav (#id) must exist on that page
  for (const m of html.matchAll(/\shref="#([A-Za-z][\w-]*)"/g)) {
    if (!new RegExp(`\\sid="${m[1]}"`).test(html)) fail(`${page}: anchor #${m[1]} has no matching id`);
  }
}

// The chrome (sidebar, top bar, footer) is the same markup on every APP page, 404.html included (404.html uses
// absolute /lokal/ URLs because it is served for any missing path). app.html is the reference; scripts/sync-chrome.mjs
// copies it to the others. Icon sprites may differ, since a page can add its own icons; the anchor check above makes
// sure every icon used exists.
//
// Deliberate exception (OWN_CHROME): the landing (index.html, "/") and the sign-up gateway (start.html). The landing
// tells a newcomer the story with a slim top bar (section anchors, Sign in, Get started) instead of dropping them into
// an app sidebar, and the gateway is one calm, focused flow with only the logo and a way out. They have their own
// rules above (no app sidebar, a slim bar, legal links, the way into the gateway, the gate script), and every other
// check (CSP, links, assets, scripts, asset versions) applies to them like any page.
const CHROME = {
  sidebar: /<aside class="sidebar"[^]*?<\/aside>/,
  "top bar": /<div class="nav-wrap">[^]*?<\/nav>\s*<\/div>/,
  footer: /<footer class="site-footer">[^]*?<\/footer>/,
};
const chromeOf = (page) => {
  const html = fs.readFileSync(path.join(SITE, page), "utf8").replaceAll("/lokal/", "");
  return Object.fromEntries(Object.entries(CHROME).map(([k, re]) => [k, (html.match(re) || [null])[0]]));
};
const refChrome = chromeOf("app.html");
for (const page of pages.filter((p) => !OWN_CHROME.has(p))) {
  const c = chromeOf(page);
  for (const k of Object.keys(CHROME)) {
    if (!c[k]) fail(`${page}: missing the ${k}`);
    else if (c[k] !== refChrome[k]) fail(`${page}: the ${k} differs from app.html (run node scripts/sync-chrome.mjs to copy it)`);
  }
}

// Activity is for the signed-in wallet only: without JavaScript (or before it runs) visitors see the sign-in prompt,
// and the table of payments starts hidden.
{
  const tx = fs.readFileSync(path.join(SITE, "transactions.html"), "utf8");
  if (!/<section class="card gate-card" id="gate"/.test(tx)) fail('transactions.html: visitors should see the sign-in prompt (id="gate")');
  if (!/<section class="card" id="tx-card"[^>]*\shidden>/.test(tx)) fail("transactions.html: the payments table must start hidden (it is shown only to the signed-in wallet)");
}

// pages linked from JavaScript (e.g. el("a", { href: "privacy.html" })) must exist too
const assetScripts = fs.readdirSync(path.join(SITE, "assets")).filter((f) => f.endsWith(".js")).map((f) => "assets/" + f);
for (const file of [...assetScripts, ...fs.readdirSync(path.join(SITE, "js")).map((f) => "js/" + f)].filter((f) => f.endsWith(".js"))) {
  const src = fs.readFileSync(path.join(SITE, file), "utf8");
  for (const m of src.matchAll(/href:\s*["'`]([a-z0-9-]+\.html)/gi)) {
    if (!fs.existsSync(path.join(SITE, m[1]))) fail(`${file}: links to missing page "${m[1]}"`);
  }
}

// every url() in the stylesheets must exist and be allowed by each page's CSP (fonts were once silently blocked)
const css = fs.readdirSync(path.join(SITE, "assets")).filter((f) => f.endsWith(".css")).sort()
  .map((f) => fs.readFileSync(path.join(SITE, "assets", f), "utf8")).join("\n");
for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
  const ref = m[1];
  if (/^data:/i.test(ref)) { fail(`styles.css: data: URL "${ref.slice(0, 30)}..." is blocked by the CSP`); continue; }
  if (/^https?:/i.test(ref)) {
    for (const page of pages) {
      const csp = (fs.readFileSync(path.join(SITE, page), "utf8").match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || "";
      const host = new URL(ref).origin;
      if (!csp.includes(host)) fail(`${page}: CSP does not allow ${host} used in styles.css`);
    }
    continue;
  }
  if (!fs.existsSync(path.join(SITE, "assets", ref.split(/[?#]/)[0]))) fail(`styles.css: missing file "${ref}"`);
}
for (const page of pages) {
  const csp = (fs.readFileSync(path.join(SITE, page), "utf8").match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || "";
  if (/@font-face/.test(css) && /url\(\s*["']?fonts\//.test(css) && !/font-src[^;]*'self'/.test(csp)) fail(`${page}: CSP font-src must include 'self' for the self-hosted fonts`);
}

// every script parses
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
for (const file of walk(SITE).filter((f) => f.endsWith(".js") && !f.includes(`${path.sep}_spec${path.sep}`))) {
  try { execFileSync(process.execPath, ["--check", file], { stdio: "pipe" }); }
  catch (e) { fail(`${path.relative(".", file)}: ${String(e.stderr || e.message).split("\n").find((l) => l.trim()) || "syntax error"}`); }
}
for (const file of walk(SITE).filter((f) => f.endsWith(".svg"))) {
  const svg = fs.readFileSync(file, "utf8");
  if (!/^<svg[\s>]/.test(svg.trim()) || !svg.trim().endsWith("</svg>")) fail(`${path.relative(".", file)}: not a well-formed SVG document`);
}
for (const file of walk(SITE).filter((f) => f.endsWith(".json") && !f.endsWith("rate.json"))) {
  try { JSON.parse(fs.readFileSync(file, "utf8")); } catch { fail(`${path.relative(".", file)}: invalid JSON`); }
}

// The Windows installer (irm https://lokalpay.vercel.app/install.ps1 | iex). Windows PowerShell 5.1 decodes a
// download without a BOM as Latin-1 and keeps a BOM as a stray first character, so the file must be ASCII with no BOM.
// It must be served as text (vercel.json) so people can read it in the browser before running it.
{
  const file = path.join(SITE, "install.ps1");
  if (!fs.existsSync(file)) fail("site/install.ps1 is missing (the one-line Windows installer)");
  else {
    const buf = fs.readFileSync(file);
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) fail("site/install.ps1: starts with a UTF-8 BOM");
    const bad = buf.findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09));
    if (bad !== -1) fail(`site/install.ps1: non-ASCII or control byte 0x${buf[bad].toString(16)} at offset ${bad}`);
    const src = buf.toString("ascii");
    if (!/^& \{\r?$/m.test(src) || !/\n\}\s*$/.test(src)) fail("site/install.ps1: the code must be one & { ... } block, so a cut-off download never runs");
    if (/^\s*exit\b/im.test(src)) fail("site/install.ps1: never call exit (it would close the user's window under iex); use return");
    if (!src.includes("https://codeload.github.com/$Repo/zip/$Ref")) fail("site/install.ps1: should download the GitHub codeload zip for $Ref");
  }
  const vercelRaw = fs.readFileSync("vercel.json");
  if (vercelRaw[0] !== 0x7b) fail("vercel.json: must start with '{' (no BOM)");
  const rule = (JSON.parse(vercelRaw.toString("utf8")).headers || []).find((h) => h.source === "/install.ps1");
  const ct = rule && rule.headers.find((h) => h.key.toLowerCase() === "content-type");
  if (!ct || !/^text\/plain;\s*charset=utf-8$/i.test(ct.value)) fail("vercel.json: /install.ps1 must be served as text/plain; charset=utf-8");
}

// The brand images are cached, so every reference carries the same ?v= (scripts/asset-version.mjs bumps it).
{
  const { versions, bare } = assetVersions(SITE);
  for (const b of bare) fail(`${b} has no ?v= version (run: node scripts/asset-version.mjs ${[...versions][0] ?? "<version>"})`);
  if (versions.size > 1) fail(`brand images use more than one ?v= version: ${[...versions].join(", ")} (run: node scripts/asset-version.mjs <version>)`);
}

if (errors.length) {
  console.error(`Site check failed (${errors.length}):\n` + errors.map((e) => "  - " + e).join("\n"));
  process.exit(1);
}
console.log(`Site check passed: ${pages.length} pages, all local links, assets and scripts OK.`);
