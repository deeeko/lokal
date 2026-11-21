// Wallet sign-in: the message format shared by site/assets/session.js and api/session.js, and the stateless check.
import test from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { checkSignIn, makeHandler, MAX_BODY, KNOWN_HOSTS } from "../api/session.js";
import { buildSignInMessage, parseSignInMessage, signInMessageError, explainWalletError, ensureCelo } from "../site/assets/session.js";

const account = privateKeyToAccount(generatePrivateKey()); // throwaway key, made for this test only
// stands in for Celo (Forno): no test touches the network. It says "not valid" unless told otherwise.
const noChain = { verifyMessage: async () => false };
const handler = makeHandler({ client: noChain });
const NOW = 1_795_000_000;
const iso = (s) => new Date(s * 1000).toISOString();
const msgFor = (o = {}) => buildSignInMessage({
  host: "lokalpay.vercel.app", origin: "https://lokalpay.vercel.app", address: account.address,
  nonce: "0123456789abcdef", issuedAt: iso(NOW), expiresAt: iso(NOW + 7 * 86400), ...o,
});
const mkRes = () => {
  const r = { code: 0, headers: {}, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
};

test("sign-in message: builds the agreed text and parses back", () => {
  const m = msgFor();
  assert.equal(m, `lokalpay.vercel.app wants you to sign in with your Ethereum account:\n${account.address}\n\n`
    + "Sign in to Lokal. This is free and sends nothing.\n\nURI: https://lokalpay.vercel.app\nVersion: 1\n"
    + `Chain ID: 42220\nNonce: 0123456789abcdef\nIssued At: ${iso(NOW)}\nExpiration Time: ${iso(NOW + 7 * 86400)}`);
  const p = parseSignInMessage(m);
  assert.equal(p.address, account.address);
  assert.equal(p.host, "lokalpay.vercel.app");
  assert.equal(p.chainId, 42220);
  assert.equal(p.exp, NOW + 7 * 86400);
  assert.equal(signInMessageError(p, NOW + 10), null);
  // local preview with a port
  const local = parseSignInMessage(msgFor({ host: "localhost:8080", origin: "http://localhost:8080" }));
  assert.equal(local.host, "localhost:8080");
  assert.equal(signInMessageError(local, NOW), null);
});

test("sign-in message: anything else is refused", () => {
  assert.equal(parseSignInMessage(msgFor() + "\nextra"), null);
  assert.equal(parseSignInMessage(msgFor().replace("Sign in to Lokal", "Sign in to Something")), null);
  assert.equal(parseSignInMessage(msgFor({ nonce: "xyz" })), null);
  assert.equal(parseSignInMessage(42), null);
  assert.equal(signInMessageError(parseSignInMessage(msgFor().replace("Chain ID: 42220", "Chain ID: 1")), NOW), "wrong chain");
  assert.equal(signInMessageError(parseSignInMessage(msgFor({ origin: "https://evil.example" })), NOW), "the URI is not on the signing site");
  assert.equal(signInMessageError(parseSignInMessage(msgFor()), NOW + 8 * 86400), "the sign-in has expired");
  assert.equal(signInMessageError(parseSignInMessage(msgFor({ expiresAt: iso(NOW + 30 * 86400) })), NOW), "the sign-in lasts too long");
  assert.equal(signInMessageError(parseSignInMessage(msgFor({ issuedAt: iso(NOW + 3600) })), NOW), "issued in the future");
});

test("api/session: a real signature for this site passes", async () => {
  const message = msgFor();
  const signature = await account.signMessage({ message });
  const ok = await checkSignIn({ message, signature }, { host: "lokalpay.vercel.app", nowSec: NOW + 60 });
  assert.deepEqual(ok, { ok: true, address: account.address, exp: NOW + 7 * 86400 });
  // a preview deployment signs with its own host, which must match the request's Host header
  const pm = msgFor({ host: "preview-abc.vercel.app", origin: "https://preview-abc.vercel.app" });
  const ps = await account.signMessage({ message: pm });
  assert.equal((await checkSignIn({ message: pm, signature: ps }, { host: "preview-abc.vercel.app", nowSec: NOW })).ok, true);
  assert.equal((await checkSignIn({ message: pm, signature: ps }, { host: "lokalpay.vercel.app", nowSec: NOW })).error, "signed for a different site");
});

test("api/session: the Lokal address and the older addresses are all our sites (rename to Lokal)", async () => {
  assert.deepEqual(KNOWN_HOSTS, ["lokalpay.vercel.app", "naira-payout.vercel.app", "celo-naira-payout-agent.vercel.app"]);
  for (const site of KNOWN_HOSTS) {
    const message = msgFor({ host: site, origin: `https://${site}` });
    const signature = await account.signMessage({ message });
    for (const reqHost of KNOWN_HOSTS) {
      assert.equal((await checkSignIn({ message, signature }, { host: reqHost, nowSec: NOW })).ok, true, `${site} on ${reqHost}`);
    }
  }
  // a sign-in made before the rename ("Sign in to Naira Payout.") stays valid until it expires
  const old = msgFor({ host: "naira-payout.vercel.app", origin: "https://naira-payout.vercel.app" })
    .replace("Sign in to Lokal. This is free", "Sign in to Naira Payout. This is free");
  assert.ok(old.includes("\n\nSign in to Naira Payout. This is free and sends nothing.\n\n"));
  assert.equal(parseSignInMessage(old).host, "naira-payout.vercel.app");
  const oldSig = await account.signMessage({ message: old });
  assert.equal((await checkSignIn({ message: old, signature: oldSig }, { host: "lokalpay.vercel.app", nowSec: NOW })).ok, true);
  // new sign-ins use the Lokal text
  assert.ok(msgFor().includes("\n\nSign in to Lokal. This is free and sends nothing.\n\n"));
});

test("api/session: wrong signer, tampering, expiry and junk are refused", async () => {
  const message = msgFor();
  const other = privateKeyToAccount(generatePrivateKey());
  const bad = await other.signMessage({ message });
  assert.equal((await checkSignIn({ message, signature: bad }, { host: "lokalpay.vercel.app", nowSec: NOW, client: noChain })).ok, false);
  const signature = await account.signMessage({ message });
  const tampered = message.replace("0123456789abcdef", "fedcba9876543210");
  assert.equal((await checkSignIn({ message: tampered, signature }, { host: "lokalpay.vercel.app", nowSec: NOW, client: noChain })).ok, false);
  assert.equal((await checkSignIn({ message, signature }, { host: "lokalpay.vercel.app", nowSec: NOW + 8 * 86400 })).error, "the sign-in has expired");
  assert.equal((await checkSignIn({ message, signature: "0x1234" }, { host: "lokalpay.vercel.app", nowSec: NOW })).ok, false);
  assert.equal((await checkSignIn({}, { host: "x" })).ok, false);
});

test("api/session: smart-contract wallets are checked on Celo (ERC-1271 / ERC-6492), with a timeout", async () => {
  const message = msgFor();
  const opts = { host: "lokalpay.vercel.app", nowSec: NOW };
  const long = "0x" + "ab".repeat(65 + 200); // a wrapped ERC-6492 signature is longer than 65 bytes
  const asked = [];
  const chain = { verifyMessage: async (a) => { asked.push(a); return a.signature === long; } };
  assert.deepEqual(await checkSignIn({ message, signature: long }, { ...opts, client: chain }), { ok: true, address: account.address, exp: NOW + 7 * 86400 });
  assert.equal(asked[0].address, account.address);
  assert.equal(asked[0].message, message);
  // a 65-byte signature from a contract wallet that doesn't recover to the address is also asked onchain
  const sig65 = "0x" + "cd".repeat(65);
  assert.equal((await checkSignIn({ message, signature: sig65 }, { ...opts, client: chain })).error, "the signature does not match the address");
  assert.equal(asked.length, 2);
  // a normal wallet's signature never needs the network
  const signature = await account.signMessage({ message });
  const never = { verifyMessage: async () => { throw new Error("should not be called"); } };
  assert.equal((await checkSignIn({ message, signature }, { ...opts, client: never })).ok, true);
  // odd lengths and absurd lengths are refused before anything else
  assert.equal((await checkSignIn({ message, signature: long + "a" }, { ...opts, client: chain })).error, "invalid signature format");
  assert.equal((await checkSignIn({ message, signature: "0x" + "ab".repeat(2000) }, { ...opts, client: chain })).error, "invalid signature format");
  // Celo doesn't answer: 503 (try again), never a pass
  const hang = { verifyMessage: () => new Promise(() => {}) };
  const slow = await checkSignIn({ message, signature: long }, { ...opts, client: hang, timeoutMs: 30 });
  assert.equal(slow.ok, false);
  assert.equal(slow.status, 503);
  const down = { verifyMessage: async () => { throw new Error("HTTP request failed. URL: https://forno.celo.org"); } };
  assert.equal((await checkSignIn({ message, signature: long }, { ...opts, client: down })).status, 503);
  const reverted = { verifyMessage: async () => { throw new Error("execution reverted"); } };
  assert.equal((await checkSignIn({ message, signature: long }, { ...opts, client: reverted })).status, undefined);
  // the handler passes 503 through
  const r = mkRes();
  await makeHandler({ client: hang, timeoutMs: 30 })({ method: "POST", headers: { "content-type": "application/json", host: "lokalpay.vercel.app" }, body: { message: msgFor({ issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString() }), signature: long } }, r);
  assert.equal(r.code, 503);
  assert.equal(r.body.ok, false);
  assert.equal("status" in r.body, false);
});

test("api/session handler: POST + JSON only, size limit, 400 on a bad sign-in, no caching", async () => {
  const message = msgFor({ issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString() });
  const signature = await account.signMessage({ message });
  const headers = { "content-type": "application/json", host: "lokalpay.vercel.app" };

  const r1 = mkRes(); await handler({ method: "GET", headers }, r1);
  assert.equal(r1.code, 405); assert.equal(r1.headers.Allow, "POST");
  const r2 = mkRes(); await handler({ method: "POST", headers: { ...headers, "content-type": "text/plain" }, body: "{}" }, r2);
  assert.equal(r2.code, 415);
  const r3 = mkRes(); await handler({ method: "POST", headers: { ...headers, "content-length": String(MAX_BODY + 1) }, body: {} }, r3);
  assert.equal(r3.code, 413);
  const r4 = mkRes(); await handler({ method: "POST", headers, body: "{not json" }, r4);
  assert.equal(r4.code, 400);
  const r5 = mkRes(); await handler({ method: "POST", headers, body: { message, signature: "0x" + "11".repeat(65) } }, r5);
  assert.equal(r5.code, 400); assert.equal(r5.body.ok, false);
  const r6 = mkRes(); await handler({ method: "POST", headers, body: { message, signature } }, r6);
  assert.equal(r6.code, 200); assert.equal(r6.body.ok, true); assert.equal(r6.body.address, account.address);
  assert.equal(r6.headers["Cache-Control"], "no-store");
  const r7 = mkRes(); await handler({ method: "POST", headers, body: JSON.stringify({ message, signature }) }, r7);
  assert.equal(r7.code, 200);
  const r8 = mkRes(); await handler({ method: "POST", headers, body: { message: message + "x".repeat(MAX_BODY), signature } }, r8);
  assert.equal(r8.code, 413);
});

test("session.js wallet helpers: plain errors and the Celo switch", async () => {
  assert.equal(explainWalletError({ code: 4001 }), "You cancelled in your wallet. Nothing was sent.");
  assert.match(explainWalletError(new Error("insufficient funds for gas")), /enough CELO/);
  const calls = [];
  let chain = "0x1";
  const eth = { request: async ({ method, params }) => {
    calls.push(method);
    if (method === "eth_chainId") return chain;
    if (method === "wallet_switchEthereumChain") { if (calls.filter((m) => m === method).length === 1) throw Object.assign(new Error("Unrecognized chain"), { code: 4902 }); chain = params[0].chainId; return null; }
    if (method === "wallet_addEthereumChain") { chain = params[0].chainId; return null; }
    throw new Error("unexpected " + method);
  } };
  await ensureCelo(eth);
  assert.deepEqual(calls, ["eth_chainId", "wallet_switchEthereumChain", "wallet_addEthereumChain", "eth_chainId"]);
  assert.equal(chain, "0xa4ec");
});
