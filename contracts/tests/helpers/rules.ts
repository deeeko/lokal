// The nTag rules in TypeScript, three ways, so the tests can prove the contract agrees with the site:
//
//  1. `site`: a verbatim copy of ntagError / ntagNameError from the shared "port" block of site/assets/core.js.
//  2. `loadRepoRules()`: the LIVE block, read from site/assets/core.js (or src/ntags.mjs) at test time and evaluated,
//     so if anyone changes the site's rules without changing the contract, the contract tests go red.
//  3. `contractTagValid` / `contractNameValid`: a port of the contract's own byte-level checks.
//
// The contract checks the tag format and the reserved list separately (reserved is a hash set the admin seeds), so
// "valid onchain" for a tag means: format OK and not reserved, exactly when the site's ntagError(t) returns null.

// ---------- 1. copy of the site's rules (site/assets/core.js, port block) ----------

export const NTAG_RESERVED = new Set([
  "agent", "admin", "administrator", "root", "system", "support", "help", "official", "team", "staff", "mod", "moderator",
  "security", "celo", "minipay", "valora", "opera", "textile", "naira", "nairapayout", "payout", "payouts", "ntag", "ntags",
  "lokal", "lokalpay", "cngn", "usdt", "usdc", "tether", "cusd", "ceur", "wallet", "bank", "cbn", "null", "undefined",
  "anonymous", "everyone", "me", "you", "test", "demo", "api", "www", "app", "pay", "send", "receive",
  "lokal_support", "lokalsupport", "lokal_help", "lokal_team", "lokal_official", "lokalofficial", "support_team",
  "help_desk", "helpdesk", "admin1", "celo_team", "celoteam", "minipay_support", "textile_fx",
]);
const NTAG_RESERVED_ERR = "this tag is reserved";

export function ntagError(t: unknown): string | null {
  if (typeof t !== "string" || !t) return "enter a tag";
  if (/[A-Z]/.test(t)) return "use lowercase letters only";
  if (!/^[a-z0-9_]+$/.test(t)) return "use only letters, numbers and _";
  if (!/^[a-z]/.test(t)) return "must start with a letter";
  if (t.length < 3) return "must be at least 3 characters";
  if (t.length > 20) return "must be 20 characters or fewer";
  if (t.includes("__")) return "can't contain __";
  if (t.endsWith("_")) return "can't end with _";
  if (NTAG_RESERVED.has(t)) return NTAG_RESERVED_ERR;
  return null;
}

export function ntagNameError(n: unknown): string | null {
  if (typeof n !== "string") return "invalid name";
  const v = n.trim();
  if (!v) return "name can't be blank";
  if (v.length > 40) return "name must be 40 characters or fewer";
  if (/[\u0000-\u001f\u007f-\u009f]/.test(v)) return "name can't contain control characters";
  if (/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/.test(v)) return "name can't contain invisible or text-direction characters";
  return null;
}

export const site = { ntagError, ntagNameError, NTAG_RESERVED };

// ---------- 2. the live rules from the repo ----------

export { loadRepoRules, type RepoRules } from "../../config/repo-rules";

// ---------- 3. port of the contract's checks ----------

/** LokalTags._isValidTag on the UTF-8 bytes of `t` (format only; reserved is a separate onchain set). */
export function contractTagValid(t: string): boolean {
  const b = Buffer.from(t, "utf8");
  const n = b.length;
  if (n < 3 || n > 20) return false;
  if (b[0] < 0x61 || b[0] > 0x7a) return false;
  if (b[n - 1] === 0x5f) return false;
  let prevUnderscore = false;
  for (let i = 1; i < n; i++) {
    const c = b[i];
    if (c === 0x5f) {
      if (prevUnderscore) return false;
      prevUnderscore = true;
    } else {
      if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39))) return false;
      prevUnderscore = false;
    }
  }
  return true;
}

/**
 * LokalTags._isValidName, stated the way the site states it: "" (no name), or a string already trimmed by JavaScript's
 * trim(), at most 40 UTF-16 code units, without control characters. (The site trims before sending.)
 */
export function contractNameValid(n: string): boolean {
  if (n === "") return true;
  if (Buffer.byteLength(n, "utf8") > 120) return false;
  if (n !== n.trim()) return false;
  if (n.length > 40) return false;
  return !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/.test(n);
}

/** The onchain claim check on (tag, name), as the site would predict it. */
export function siteSaysClaimable(t: string): boolean {
  return ntagError(t) === null;
}
