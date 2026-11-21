// Loads the nTag rules the site and the agent actually run: the shared "port" block of site/assets/core.js and
// src/ntags.mjs, evaluated as-is. Used by the parity tests and by the deploy script, which refuses to deploy a
// reserved list that differs from the live one.
import fs from "node:fs";
import path from "node:path";

export interface RepoRules {
  file: string;
  ntagError: (t: unknown) => string | null;
  ntagNameError: (n: unknown) => string | null;
  NTAG_RESERVED: Set<string>;
  RELEASE_LOCK_DAYS: number;
  /** The site's resolver: replays claim/release ops in (block, position) order. */
  resolveNtags: (ops: unknown[], atSec?: number) => {
    tags: Map<string, { owner: string; name: string | null; since: number }>;
    byOwner: Map<string, string>;
    locks: Map<string, { owner: string; until: number }>;
    statuses: Map<string, string>;
  };
  ntagAvailability: (state: unknown, tag: string, forAddress: string, nowSec: number) => string;
}

/**
 * Evaluates the shared port block of site/assets/core.js (falling back to src/ntags.mjs). Returns null when this
 * folder is used on its own, outside the repo. Only the pure functions are used; the block's address-dependent bits
 * get harmless stand-ins.
 */
export function loadRepoRules(): RepoRules | null {
  const root = path.resolve(__dirname, "..", "..");
  for (const rel of ["site/assets/core.js", "src/ntags.mjs"]) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const start = text.indexOf("// ---------- port: start");
    const end = text.indexOf("// ---------- port: end");
    if (start < 0 || end < 0) throw new Error(`${rel}: port markers not found`);
    const block = text.slice(text.indexOf("\n", start) + 1, end).replace(/^export /gm, "");
    const AGENT = "0x8a695cf54CB44753c8b784EB36d266f748617a1e";
    const MARKER = "80218021802180218021802180218021";
    const utf8Hex = (s: string) => Buffer.from(s, "utf8").toString("hex");
    const hexBytes = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
    const tagSuffix = () => "";
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const make = new Function(
      "AGENT", "MARKER", "utf8Hex", "hexBytes", "tagSuffix",
      `${block}\nreturn { ntagError, ntagNameError, NTAG_RESERVED, RELEASE_LOCK_DAYS, resolveNtags, ntagAvailability };`,
    );
    return { file: rel, ...make(AGENT, MARKER, utf8Hex, hexBytes, tagSuffix) };
  }
  return null;
}

/** The live reserved list from BOTH src/ntags.mjs and site/assets/core.js, or a list of problems. */
export function liveReservedLists(): { file: string; tags: string[] }[] {
  const root = path.resolve(__dirname, "..", "..");
  return ["src/ntags.mjs", "site/assets/core.js"].map((rel) => {
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    const m = text.match(/NTAG_RESERVED = new Set\(\[([\s\S]*?)\]\)/);
    if (!m) throw new Error(`${rel}: NTAG_RESERVED not found`);
    return { file: rel, tags: [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]) };
  });
}
