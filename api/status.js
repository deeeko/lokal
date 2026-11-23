// /api/status: the agent's own record of what happened to each deposit, so the site can show exact facts instead of
// guessing from the chain.
//   POST (autopilot, on the owner's PC): { v: 1, ts, events: [...] }, signed with NP_STATUS_SECRET:
//        x-np-ts: <ts>, x-np-signature: hex(HMAC-SHA256(secret, ts + "." + rawBody)). JSON only, at most 64 KB,
//        within 5 minutes of the server clock. Events are checked strictly (lib/status.mjs) and merged into ONE private
//        Vercel Blob, status/summary.json (last 30 days, newest 2,000 entries), read-modify-write with an ETag check.
//   GET  (the site): ?tx=<deposit hash> | ?recipient=<address> | ?tag=<tag> | no query (today's overall total only).
//        At most one blob read per request (none when this instance read the summary in the last 10 s), and answers
//        are cached at Vercel's edge for 10 s. Daily totals are worked out on every read.
//   The first write uses allowOverwrite: false (two first writes can't both win), later writes an ETag (ifMatch).
// Nothing here can move funds. Only data that is already public on Celo leaves the server, plus each deposit's status,
// refusal reason code and receipt number. Without the secret or the Blob store it answers 503 { ok: false,
// reason: "unavailable" }, and the site falls back to reading the chain.
//   Heartbeat (autopilot alive): POST { v: 1, ts, heartbeat: { at, cursorBlock, chainHead, lagBlocks, celoBalance, lowGas,
//        version, autoRefund } }, signed the same way. Strictly validated (lib/status.mjs validateHeartbeat); one older
//        than the newest known is a replay (409). Kept in its own blob, status/agent.json, never with the deposit
//        records. To save blob writes it is stored when something changed or the stored one is AGENT_WRITE_MS old.
//   GET  ?agent=1: { ok, source: "agent", agent: { lastSeen, ageSec, ...heartbeat } | null }.
import {
  AGENT_PATH, MAX_BODY, SUMMARY_PATH, agentView, checkSignature, emptySummary, mergeEvents, normalizeAgent, normalizeSummary,
  parseStatusQuery, pruneSummary, statusView, validateHeartbeat, validateReport,
} from "../lib/status.mjs";

export {
  validateEvent, validateReport, checkSignature, signReport, mergeEvents, pruneSummary, paidLast24h, globalTotals, walletTotals,
  parseStatusQuery, statusView, normalizeSummary, MAX_BODY, MAX_SKEW_SEC, KEEP_DAYS, KEEP_MAX, RECENT_MAX, validateHeartbeat,
  agentView, refundNo, isConflict, RANK,
} from "../lib/status.mjs";

/** A heartbeat is written to the blob at most this often unless lowGas, autoRefund or version changed. */
export const AGENT_WRITE_MS = 4 * 60_000;

const GET_CACHE = "public, s-maxage=10, stale-while-revalidate=30";
const UNAVAILABLE = { ok: false, reason: "unavailable" };
const MIN_SECRET = 32;
export const MEMORY_CACHE_MS = 10_000; // a warm instance reuses the parsed summary this long (varying ?tx= can't run up reads)

/** Thrown by a store's write when the blob changed since it was read (another write won). */
export class StaleWriteError extends Error {}

/**
 * The Vercel Blob store for the summary: read() -> { data, etag, corrupt? } | null (corrupt: the blob isn't JSON),
 * write(data, etag) (throws StaleWriteError when another write won: the ETag no longer matches, or, for the first write
 * (no etag), the blob was created in the meantime). `access` is the store's access type ("private" by default).
 */
export function blobStore({ access = process.env.STATUS_BLOB_ACCESS === "public" ? "public" : "private", path = SUMMARY_PATH, sdk } = {}) {
  // sdk: tests pass a stand-in for @vercel/blob ({ get, put, BlobPreconditionFailedError })
  const blob = async () => (sdk ??= await import("@vercel/blob"));
  return {
    async read({ fresh = false } = {}) {
      const { get } = await blob();
      const r = await get(path, { access, useCache: !fresh });
      if (!r || r.statusCode !== 200 || !r.stream) return null;
      const text = await new Response(r.stream).text();
      const etag = r.blob?.etag ?? null;
      try { return { data: JSON.parse(text), etag }; } catch { return { data: null, etag, corrupt: true }; }
    },
    async write(data, etag) {
      const { put, BlobPreconditionFailedError } = await blob();
      try {
        await put(path, JSON.stringify(data), {
          access, contentType: "application/json", addRandomSuffix: false, cacheControlMaxAge: 60,
          ...(etag ? { ifMatch: etag, allowOverwrite: true } : { allowOverwrite: false }),
        });
      } catch (e) {
        if (e instanceof BlobPreconditionFailedError) throw new StaleWriteError("changed");
        // the first write lost to another first write: the blob exists now, so read it and merge again
        if (!etag && /exist/i.test(String(e?.message ?? ""))) throw new StaleWriteError("created");
        throw e;
      }
    },
    /** Overwrites the blob unconditionally (the agent heartbeat: the newest one simply wins). */
    async replace(data) {
      const { put } = await blob();
      await put(path, JSON.stringify(data), {
        access, contentType: "application/json", addRandomSuffix: false, cacheControlMaxAge: 60, allowOverwrite: true,
      });
    },
  };
}

const defaultEnv = () => ({
  secret: process.env.NP_STATUS_SECRET,
  hasBlob: Boolean(process.env.BLOB_READ_WRITE_TOKEN || (process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN)),
});

/** The raw request body as a string (at most `max` bytes), or null when it is larger. */
async function rawBody(req, max) {
  if (typeof req.rawBody === "string" || Buffer.isBuffer(req.rawBody)) return String(req.rawBody);
  // A plain Node request whose body nobody has read yet: read it here, so the signature covers the exact bytes.
  if (req.readable && req.readableEnded === false && typeof req.on === "function" && typeof req[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > max) return null;
      chunks.push(Buffer.from(c));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const b = req.body;
  if (typeof b === "string" || Buffer.isBuffer(b)) return String(b);
  // Vercel already parsed the JSON: autopilot sends JSON.stringify output, which survives a parse + stringify unchanged.
  return b == null ? "" : JSON.stringify(b);
}

function queryOf(req) {
  if (req.query && typeof req.query === "object") return { ...req.query };
  try { return Object.fromEntries(new URL(req.url ?? "/", "http://x").searchParams); } catch { return {}; }
}

/**
 * The request handler. opts: { store (see blobStore), env: () => ({ secret, hasBlob }), now: () => ms } (tests).
 */
export function makeHandler(opts = {}) {
  const env = opts.env ?? defaultEnv;
  const now = opts.now ?? (() => Date.now());
  let store = opts.store ?? null;
  const getStore = () => (store ??= blobStore());
  let memo = null; // { at, got }: the last summary this instance read or wrote
  let agentStore = opts.agentStore ?? null;
  const getAgentStore = () => (agentStore ??= blobStore({ path: AGENT_PATH }));
  // the newest heartbeat this instance knows: { readAt, stored ({ heartbeat, lastSeen } | null), latestAt (ms) }
  let agentMemo = null;

  /** The stored heartbeat, from memory when this instance read or wrote it in the last 10 s (`fresh`: always read). */
  async function readAgent({ fresh = false } = {}) {
    const t = now();
    if (!fresh && agentMemo && t - agentMemo.readAt >= 0 && t - agentMemo.readAt < MEMORY_CACHE_MS) return agentMemo.stored;
    const got = await getAgentStore().read({ fresh });
    const stored = got && !got.corrupt ? normalizeAgent(got.data) : null;
    const latestAt = Math.max(agentMemo?.latestAt ?? 0, stored ? Date.parse(stored.heartbeat.at) : 0);
    agentMemo = { readAt: t, stored, latestAt };
    return stored;
  }

  /** A signed heartbeat: replays refused, stored when it changed something or the stored one is getting old. */
  async function onHeartbeat(body, ts, t, res) {
    const v = validateHeartbeat(body, ts);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    const hb = v.heartbeat;
    try {
      // the first heartbeat this instance sees: read what is stored, so a replay can be recognised
      const stored = agentMemo ? agentMemo.stored : await readAgent({ fresh: true });
      if (Date.parse(hb.at) <= (agentMemo?.latestAt ?? 0)) return res.status(409).json({ ok: false, error: "old heartbeat" });
      agentMemo.latestAt = Date.parse(hb.at);
      const prev = stored?.heartbeat;
      const changed = !prev || prev.lowGas !== hb.lowGas || prev.autoRefund !== hb.autoRefund || prev.version !== hb.version;
      if (!changed && t - Date.parse(stored.lastSeen) < AGENT_WRITE_MS) return res.status(200).json({ ok: true, stored: 0 });
      const record = { v: 1, heartbeat: hb, lastSeen: new Date(t).toISOString() };
      await getAgentStore().replace(record);
      agentMemo = { readAt: now(), stored: { heartbeat: hb, lastSeen: record.lastSeen }, latestAt: Date.parse(hb.at) };
      return res.status(200).json({ ok: true, stored: 1 });
    } catch (e) {
      console.error("status: heartbeat write failed:", e?.name ?? "", String(e?.message ?? e).slice(0, 200));
      return res.status(503).json(UNAVAILABLE);
    }
  }

  async function readCached() {
    const t = now();
    if (memo && t - memo.at >= 0 && t - memo.at < MEMORY_CACHE_MS) return memo.got;
    const got = await getStore().read();
    memo = got && !got.corrupt ? { at: t, got } : null;
    return got;
  }

  async function onGet(req, res) {
    const q = parseStatusQuery(queryOf(req));
    if (!q) {
      res.setHeader("Cache-Control", GET_CACHE);
      return res.status(400).json({ ok: false, error: "bad query" });
    }
    const { hasBlob } = env();
    const unavailable = () => { res.setHeader("Cache-Control", "no-store"); return res.status(503).json(UNAVAILABLE); };
    if (q.by === "agent") {
      if (!hasBlob && !opts.agentStore) return unavailable();
      let stored;
      try { stored = await readAgent(); } catch { return unavailable(); }
      res.setHeader("Cache-Control", GET_CACHE);
      return res.status(200).json(agentView(stored ? { ...stored } : null, now()));
    }
    if (!hasBlob && !opts.store) return unavailable();
    let got;
    try { got = await readCached(); } catch { return unavailable(); }
    if (!got || got.corrupt) return unavailable(); // nothing reported yet (or unreadable): the site reads the chain
    const t = now();
    res.setHeader("Cache-Control", GET_CACHE);
    return res.status(200).json(statusView(normalizeSummary(got.data, t), q, t));
  }

  async function onPost(req, res) {
    const { secret, hasBlob } = env();
    if (!secret || String(secret).trim().length < MIN_SECRET || (!hasBlob && !opts.store)) return res.status(503).json(UNAVAILABLE);
    if (!/^application\/json\b/i.test(String(req.headers?.["content-type"] ?? ""))) return res.status(415).json({ ok: false, error: "send JSON" });
    if (Number(req.headers?.["content-length"] ?? 0) > MAX_BODY) return res.status(413).json({ ok: false, error: "body too large" });
    let raw;
    try { raw = await rawBody(req, MAX_BODY); } catch { return res.status(400).json({ ok: false, error: "invalid body" }); }
    if (raw == null || Buffer.byteLength(raw, "utf8") > MAX_BODY) return res.status(413).json({ ok: false, error: "body too large" });
    const ts = req.headers?.["x-np-ts"];
    const t = now();
    if (!checkSignature(String(secret).trim(), ts, raw, req.headers?.["x-np-signature"], Math.floor(t / 1000))) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    let body;
    try { body = JSON.parse(raw); } catch { return res.status(400).json({ ok: false, error: "invalid body" }); }
    if (body && typeof body === "object" && !Array.isArray(body) && Object.prototype.hasOwnProperty.call(body, "heartbeat")) {
      if (!hasBlob && !opts.agentStore) return res.status(503).json(UNAVAILABLE);
      return onHeartbeat(body, ts, t, res);
    }
    const v = validateReport(body, ts, t);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    // invalid events are named back (rejected) and skipped; the valid ones in the same batch are still stored
    const done = (stored) => res.status(200).json({ ok: true, stored, rejected: v.rejected });
    if (!v.events.length) return done(0); // a signed ping (or nothing valid): no storage touched
    try {
      for (let attempt = 0; ; attempt++) {
        const got = await getStore().read({ fresh: true });
        // an unreadable blob is replaced (with its ETag), so one bad write can't block every later report
        const summary = got && !got.corrupt ? normalizeSummary(got.data, t) : emptySummary();
        const changed = mergeEvents(summary, v.events);
        if (!changed) return done(0);
        summary.updatedAt = new Date(t).toISOString();
        pruneSummary(summary, t);
        try {
          await getStore().write(summary, got?.etag ?? null);
          memo = { at: now(), got: { data: summary, etag: null } };
          return done(changed);
        } catch (e) {
          if (!(e instanceof StaleWriteError) || attempt >= 4) throw e;
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); // let the store's read catch up before merging again
        }
      }
    } catch (e) {
      console.error("status: report write failed:", e?.name ?? "", String(e?.message ?? e).slice(0, 200)); // no secrets in here
      return res.status(503).json(UNAVAILABLE);
    }
  }

  return async function handler(req, res) {
    if (req.method === "GET" || req.method === "HEAD") return onGet(req, res);
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, HEAD, POST");
      return res.status(405).json({ ok: false, error: "method not allowed" });
    }
    return onPost(req, res);
  };
}

export default makeHandler();
