// The brand images (logo, favicon, app icon, social card) are cached by browsers and Vercel's CDN (see vercel.json),
// so every page and script asks for them with a version query: logo.svg?v=lokal2. Changing the images means changing
// that version everywhere, or people keep seeing the old ones.
//
//   node scripts/asset-version.mjs            prints the version in use
//   node scripts/asset-version.mjs lokal3     sets ?v=lokal3 on every reference in site/*.html and site/js, site/assets
//
// scripts/brand.mjs calls setAssetVersion() itself whenever it applies a logo variant.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SITE = path.join(ROOT, "site");

export const VERSIONED_ASSETS = ["logo.svg", "logo.png", "favicon.svg", "apple-touch-icon.png", "og.png"];
// a reference: the file name right after a quote or a "/" and right before a quote or ")", with or without ?v=...
export const ASSET_REF_RE = /(?<=["'/(])(logo\.svg|logo\.png|favicon\.svg|apple-touch-icon\.png|og\.png)(?:\?v=([A-Za-z0-9._-]*))?(?=["')])/g;
export const VERSION_RE = /^[A-Za-z0-9._-]{1,40}$/;

/** The files that reference the brand images: every page, and the page scripts. */
export function versionedFiles(site = SITE) {
  const html = fs.readdirSync(site).filter((f) => f.endsWith(".html")).map((f) => path.join(site, f));
  const js = ["js", "assets"].flatMap((d) => fs.readdirSync(path.join(site, d)).filter((f) => f.endsWith(".js")).map((f) => path.join(site, d, f)));
  return [...html, ...js];
}

/** Rewrites every reference to `name?v=<version>`. Returns the files it changed. */
export function setAssetVersion(version, site = SITE) {
  if (!VERSION_RE.test(version)) throw new Error(`Bad version "${version}": use letters, digits, . _ - (max 40).`);
  const changed = [];
  for (const f of versionedFiles(site)) {
    const src = fs.readFileSync(f, "utf8");
    const out = src.replace(ASSET_REF_RE, (_, name) => `${name}?v=${version}`);
    if (out !== src) { fs.writeFileSync(f, out); changed.push(path.relative(ROOT, f)); }
  }
  return changed;
}

/** Every version found in the references (a Set), plus references that carry none. */
export function assetVersions(site = SITE) {
  const versions = new Set(), bare = [];
  for (const f of versionedFiles(site)) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(ASSET_REF_RE)) {
      if (m[2]) versions.add(m[2]); else bare.push(`${path.relative(ROOT, f)}: ${m[1]}`);
    }
  }
  return { versions, bare };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const v = process.argv[2];
  if (!v) {
    const { versions, bare } = assetVersions();
    console.log(versions.size ? [...versions].join(", ") : "(none)");
    if (bare.length) console.log(`Without a version: ${bare.join("; ")}`);
  } else {
    const changed = setAssetVersion(v);
    console.log(`?v=${v} on the brand images in ${changed.length} file(s)${changed.length ? ": " + changed.join(", ") : ""}.`);
  }
}
