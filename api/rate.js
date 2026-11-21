// GET /api/rate — the live Textile FX rates for every currency (same shape as rate.json), cached at Vercel's edge for 60 s:
//   { base: "USDT", rates: { cngn, idrx, wars, wcop }, available: { ... }, maxUsd: { ... }, at, ...the naira fields }
// Read-only. A currency Textile isn't quoting is reported as available: false (the others still show). If Textile is
// down altogether, it carries forward the deployment's static rate.json and marks it stale.
import { buildRate, hasAnyRate } from "../lib/rate.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const result = await buildRate({ timeoutMs: 8_000, carryForwardUrl: host ? `${proto}://${host}/rate.json` : undefined });
  const ok = hasAnyRate(result);
  // short cache: a partial answer (a currency not quoting) is cached for less time, so it recovers quickly
  const partial = Object.values(result.available ?? {}).some((v) => !v);
  res.setHeader("Cache-Control", ok ? `public, s-maxage=${partial ? 30 : 60}, stale-while-revalidate=300` : "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(ok ? 200 : 503).json(result);
}
