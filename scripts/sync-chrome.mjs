// Copies the app chrome (sidebar, top bar, footer) from site/app.html to every other app page, so editing it once is
// enough: node scripts/sync-chrome.mjs. scripts/check-site.mjs fails when the copies differ.
// 404.html gets the same markup with absolute /lokal/ URLs (it is served for any missing path).
// The landing (index.html) and the sign-up gateway (start.html) have their own chrome and are left alone.
import fs from "node:fs";
import path from "node:path";

const SITE = path.resolve("site");
const OWN_CHROME = new Set(["index.html", "start.html"]);
const BLOCKS = [
  /<aside class="sidebar"[^]*?<\/aside>/,
  /<div class="nav-wrap">[^]*?<\/nav>\s*<\/div>/,
  /<footer class="site-footer">[^]*?<\/footer>/,
];
const ref = fs.readFileSync(path.join(SITE, "app.html"), "utf8");
const blocks = BLOCKS.map((re) => {
  const m = ref.match(re);
  if (!m) throw new Error(`app.html is missing ${re}`);
  return m[0];
});
/** Relative page/asset URLs -> /lokal/... (external links, anchors and mailto stay as they are). */
const absolute = (html) => html.replace(/(\s(?:href|src)=")(?!https?:|mailto:|#|\/)([^"]+)"/g, '$1/lokal/$2"');

let changed = 0;
for (const page of fs.readdirSync(SITE).filter((f) => f.endsWith(".html") && f !== "app.html" && !OWN_CHROME.has(f))) {
  const file = path.join(SITE, page);
  const before = fs.readFileSync(file, "utf8");
  let html = before;
  BLOCKS.forEach((re, i) => {
    if (!re.test(html)) throw new Error(`${page} is missing ${re}`);
    html = html.replace(re, () => (page === "404.html" ? absolute(blocks[i]) : blocks[i]));
  });
  html = html.replace('<meta name="theme-color" content="#040806">', '<meta name="theme-color" content="#06110c">');
  if (html !== before) { fs.writeFileSync(file, html); changed++; console.log(`updated ${page}`); }
}
console.log(changed ? `${changed} page(s) updated.` : "Every page already has the app chrome.");
