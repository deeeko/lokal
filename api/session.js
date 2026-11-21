// POST /api/session — checks a wallet sign-in. Body: { message, signature } (JSON, at most 4 KB).
// Stateless: no cookies, no database, nothing is stored or logged. It checks that the message is our sign-in text for
// this site, on Celo, and not expired, and that the address signed it: a normal wallet (EIP-191) is checked locally; a
// smart-contract wallet (ERC-1271, or ERC-6492 before it is deployed) is checked on Celo through Forno, with a timeout.
// Returns { ok, address, exp }, 400 when the sign-in is wrong, or 503 when Celo couldn't be asked in time.
import { createPublicClient, http, verifyMessage, getAddress } from "viem";
import { celo } from "viem/chains";
import { parseSignInMessage, signInMessageError } from "../site/assets/session.js";

export const MAX_BODY = 4096;
// lokalpay.vercel.app is the address since the rename to Lokal; the older ones keep working.
export const KNOWN_HOSTS = ["lokalpay.vercel.app", "naira-payout.vercel.app", "celo-naira-payout-agent.vercel.app"];
export const VERIFY_TIMEOUT_MS = 8000;
// 65 bytes for a normal wallet; contract wallets may return longer signatures (still bounded by the body size)
const SIGNATURE_RE = /^0x(?:[0-9a-fA-F]{2}){65,1900}$/;

let defaultClient = null;
const celoClient = () => (defaultClient ??= createPublicClient({ chain: celo, transport: http("https://forno.celo.org", { timeout: VERIFY_TIMEOUT_MS, retryCount: 0 }) }));

/** Resolves true/false, or throws { unreachable: true } when Celo didn't answer within `ms`. */
async function verifyOnchain(client, args, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { unreachable: true })), ms); });
  try {
    return Boolean(await Promise.race([client.verifyMessage(args), timeout]));
  } catch (e) {
    if (e?.unreachable) throw e;
    // a revert means "not a valid signature"; a transport failure means we couldn't ask
    if (/HTTP request failed|fetch failed|timed? ?out|ECONN|ENOTFOUND|network/i.test(String(e?.message ?? e))) throw Object.assign(e, { unreachable: true });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks { message, signature } signed for `host`. Resolves { ok: true, address, exp } or { ok: false, error, status }.
 * opts.client: a viem public client (anything with verifyMessage) for contract wallets; Celo mainnet via Forno by default.
 */
export async function checkSignIn(body, { host, nowSec = Math.floor(Date.now() / 1000), client, timeoutMs = VERIFY_TIMEOUT_MS } = {}) {
  const { message, signature } = body ?? {};
  if (typeof message !== "string" || typeof signature !== "string") return { ok: false, error: "message and signature are required" };
  if (!SIGNATURE_RE.test(signature)) return { ok: false, error: "invalid signature format" };
  const p = parseSignInMessage(message);
  const err = signInMessageError(p, nowSec);
  if (err) return { ok: false, error: err };
  const reqHost = String(host ?? "").toLowerCase();
  if (p.host !== reqHost && !KNOWN_HOSTS.includes(p.host)) return { ok: false, error: "signed for a different site" };
  let valid = false;
  if (signature.length === 132) {
    try { valid = await verifyMessage({ address: p.address, message, signature }); } catch { valid = false; }
  }
  if (!valid) {
    try {
      valid = await verifyOnchain(client ?? celoClient(), { address: p.address, message, signature }, timeoutMs);
    } catch {
      return { ok: false, status: 503, error: "couldn't reach Celo to check a smart-wallet signature; try again" };
    }
  }
  if (!valid) return { ok: false, error: "the signature does not match the address" };
  return { ok: true, address: getAddress(p.address), exp: p.exp };
}

/** The request handler. opts.client is for tests (see checkSignIn). */
export function makeHandler(opts = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }
    if (!/^application\/json\b/i.test(String(req.headers?.["content-type"] ?? ""))) {
      return res.status(415).json({ ok: false, error: "Send JSON" });
    }
    if (Number(req.headers?.["content-length"] ?? 0) > MAX_BODY) return res.status(413).json({ ok: false, error: "Body too large" });
    let body = req.body;
    try {
      if (typeof body === "string" || Buffer.isBuffer(body)) {
        if (body.length > MAX_BODY) return res.status(413).json({ ok: false, error: "Body too large" });
        body = JSON.parse(String(body));
      } else if (body && JSON.stringify(body).length > MAX_BODY) {
        return res.status(413).json({ ok: false, error: "Body too large" });
      }
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid JSON" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return res.status(400).json({ ok: false, error: "Invalid body" });
    const result = await checkSignIn(body, { host: req.headers?.["x-forwarded-host"] || req.headers?.host, ...opts });
    const { status, ...out } = result;
    return res.status(result.ok ? 200 : status ?? 400).json(out);
  };
}

export default makeHandler();
