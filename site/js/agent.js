import { initChrome, AGENT, AGENT_ID, REGISTRY, REPUTATION, SEL, TAG, TOKENS, EXPLORER_API, celoscanAddr, num2, short, lagosClock, $, el, badge, icon, getJson, readContract, loadIdentity, loadBalances } from "../assets/core.js";

initChrome();

const DASH = "—";
const set = (node, ...children) => node.replaceChildren(...children);
const errorAlert = (message, href, linkText) =>
  el("div", { class: "alert err", role: "alert" }, icon("alert"),
    el("span", {}, message + " ", el("a", { class: "link", href }, linkText), "."));

// ---------- static facts (known constants, no network) ----------
const regLink = $("#id-registry");
regLink.href = celoscanAddr(REGISTRY);
regLink.textContent = short(REGISTRY);
regLink.title = REGISTRY;

$("#w-addr").textContent = AGENT;
$("#w-copy").dataset.copy = AGENT;
$("#w-link").href = celoscanAddr(AGENT);
$("#tag-text").textContent = TAG;
$("#tag-copy").dataset.copy = TAG;

// ---------- identity + registration file ----------
const text = (v) => el("span", {}, v == null || v === "" ? DASH : String(v));
const yesNo = (v) => (v === true ? badge("Yes", "ok") : v === false ? badge("No", "neutral") : text(null));

async function renderIdentity() {
  const body = $("#id-body");
  try {
    const { ok, owner, file } = await loadIdentity();

    const ownerLink = el("a", { class: "link mono", href: celoscanAddr(owner), title: owner }, short(owner));
    set($("#id-owner"), ownerLink);
    set($("#id-status"), ok ? badge("Verified owner", "ok") : badge("Owner mismatch", "err"));

    set($("#id-name"), text(file?.name));
    set($("#id-desc"), text(file?.description));
    set($("#id-active"), yesNo(file?.active));
    set($("#id-x402"), yesNo(file?.x402Support));

    const regs = Array.isArray(file?.registrations) ? file.registrations : [];
    const matches = regs.some((r) => String(r?.agentId) === AGENT_ID.toString());
    set($("#id-cross"), file == null ? text(null) : matches ? badge("Matches onchain ID", "ok") : badge("No matching ID in file", "warn"));

    if (!ok) {
      const e = $("#id-error");
      set(e, el("div", { class: "alert warn" }, icon("alert"),
        el("span", {}, "The registry reports a different owner than the agent wallet. Check the identity NFT on ",
          el("a", { class: "link", href: celoscanAddr(REGISTRY) }, "Celoscan"), ".")));
      e.hidden = false;
    }

    renderFile(file);
  } catch (err) {
    for (const id of ["#id-owner", "#id-name", "#id-desc", "#id-active", "#id-x402", "#id-cross"]) set($(id), text(null));
    set($("#id-status"), badge("Unavailable", "err"));
    const e = $("#id-error");
    set(e, errorAlert("Could not read the identity from Celo right now. Try reloading, or view it on", celoscanAddr(REGISTRY), "Celoscan"));
    e.hidden = false;
    renderFile(undefined);
  } finally {
    body.removeAttribute("aria-busy");
  }
}

function renderFile(file) {
  const pre = $("#file-json");
  const btn = $("#file-copy");
  if (file) {
    const json = JSON.stringify(file, null, 2);
    pre.textContent = json;
    btn.dataset.copy = json;
    btn.disabled = false;
    return;
  }
  $("#file-wrap").hidden = true;
  const e = $("#file-error");
  set(e, file === null
    ? errorAlert("The registry returned a token URI that is not an inline JSON file, so it is not shown here. Inspect it on", celoscanAddr(REGISTRY), "Celoscan")
    : errorAlert("Could not load the registration file. Try reloading, or read it on", celoscanAddr(REGISTRY), "Celoscan"));
  e.hidden = false;
}

// ---------- balances ----------
const balCells = () => [$("#b-celo"), $("#b-usdt"), $("#b-cngn")];
const skel = () => el("span", { class: "skel", style: "width:70px" });

async function renderBalances() {
  const btn = $("#bal-refresh");
  const err = $("#bal-error");
  btn.disabled = true;
  err.hidden = true;
  for (const c of balCells()) set(c, skel());
  $("#bal-time").textContent = "Reading balances…";
  try {
    const { celo, usdt, cngn } = await loadBalances();
    const [a, b, c] = balCells();
    a.textContent = num2.format(celo);
    b.textContent = num2.format(usdt);
    c.textContent = num2.format(cngn);
    $("#bal-time").textContent = `Read at ${lagosClock(Date.now())} WAT`;
  } catch {
    for (const c of balCells()) c.textContent = DASH;
    set(err, errorAlert("Could not read balances from Celo right now. Try refresh, or check the wallet on", celoscanAddr(AGENT), "Celoscan"));
    err.hidden = false;
    $("#bal-time").textContent = "Balances unavailable";
  } finally {
    btn.disabled = false;
  }
}

$("#bal-refresh").addEventListener("click", renderBalances);

// ---------- reviews (ERC-8004 Reputation Registry) ----------
const REVIEW_COLS = 4;
const reviewEmptyRow = (message) => el("tr", { class: "empty" }, el("td", { colspan: String(REVIEW_COLS) }, message));

/** Text-only star display: rounded to whole stars, exact value in the accessible label. */
function stars(value) {
  const full = Math.max(0, Math.min(5, Math.round(value)));
  const wrap = el("span", { class: "stars", role: "img", "aria-label": `${value.toFixed(1)} out of 5 stars` });
  for (let i = 0; i < 5; i++) wrap.append(el("span", { class: i < full ? "on" : "off", "aria-hidden": "true" }, "★"));
  return wrap;
}

/** Addresses (lowercase) that ever sent one of the agent's tokens (USD₮, cNGN, ...) to the agent, from Blockscout. Reads up to 5 pages. */
async function loadPayers() {
  const tokens = new Set(Object.values(TOKENS).map((t) => t.address.toLowerCase()));
  const payers = new Set();
  let next = null;
  for (let page = 0; page < 5; page++) {
    const qs = new URLSearchParams({ type: "ERC-20", filter: "to", ...(next ?? {}) });
    const d = await getJson(`${EXPLORER_API}/addresses/${AGENT}/token-transfers?${qs}`);
    if (!Array.isArray(d.items)) throw new Error("unexpected explorer response");
    for (const t of d.items) {
      const token = String(t.token?.address_hash ?? t.token?.address ?? "").toLowerCase();
      const to = String(t.to?.hash ?? "").toLowerCase();
      const from = String(t.from?.hash ?? "").toLowerCase();
      if (tokens.has(token) && to === AGENT.toLowerCase() && from) payers.add(from);
    }
    next = d.next_page_params ?? null;
    if (!next) break;
  }
  return payers;
}

async function loadReviews() {
  const [clients] = await readContract(REPUTATION, SEL.getClients, ["uint256"], [AGENT_ID], ["address[]"]);
  if (!clients.length) return [];
  const [who, idx, values, decimals, tag1s, tag2s, revoked] = await readContract(
    REPUTATION, SEL.readAllFeedback,
    ["uint256", "address[]", "string", "string", "bool"], [AGENT_ID, clients, "", "", false],
    ["address[]", "uint64[]", "int128[]", "uint8[]", "string[]", "string[]", "bool[]"],
  );
  const out = [];
  who.forEach((client, i) => {
    if (revoked[i] || tag1s[i] !== "starred") return;
    const score = Number(values[i]) / 10 ** Number(decimals[i]); // 0–100
    const s = score / 20;
    if (!(s >= 0 && s <= 5)) return; // outside the 1–5 star scale: not a star rating
    out.push({ client, index: idx[i], stars: s, context: tag2s[i] });
  });
  return out.reverse(); // most recently added clients last on chain, show them first
}

async function renderReviews() {
  const region = $("#rev-region");
  const rows = $("#rev-rows");
  const err = $("#rev-error");
  $("#rev-link").href = celoscanAddr(REPUTATION);
  try {
    // Reviews are required; the payer check is a best-effort extra and must not block them.
    const [reviews, payers] = await Promise.all([loadReviews(), loadPayers().catch(() => null)]);

    set($("#rev-count"), String(reviews.length));
    if (!reviews.length) {
      set($("#rev-avg"), DASH);
      set($("#rev-verified"), payers ? "0" : DASH);
      set($("#rev-status"), badge("No reviews yet", "neutral"));
      set(rows, reviewEmptyRow("No reviews yet. Payers can rate a payout from its receipt."));
      return;
    }

    const avg = reviews.reduce((a, r) => a + r.stars, 0) / reviews.length;
    set($("#rev-avg"), avg.toFixed(1), stars(avg));
    const verifiedCount = payers ? reviews.filter((r) => payers.has(r.client.toLowerCase())).length : null;
    set($("#rev-verified"), verifiedCount == null ? DASH : String(verifiedCount));
    set($("#rev-status"), badge(`${reviews.length} ${reviews.length === 1 ? "review" : "reviews"}`, "ok"));

    set(rows, ...reviews.map((r) => {
      const check = payers == null ? badge("Not checked", "neutral")
        : payers.has(r.client.toLowerCase()) ? badge("Verified payer", "ok")
        : badge("Unverified", "neutral");
      return el("tr", {},
        el("td", { class: "lead-cell", "data-label": "Rating" }, stars(r.stars)),
        el("td", { "data-label": "Reviewer" }, el("a", { class: "mono", href: celoscanAddr(r.client), title: r.client }, short(r.client))),
        el("td", { "data-label": "Payer check" }, check),
        el("td", { "data-label": "Context" }, el("span", { class: "small soft" }, r.context ? r.context : DASH)),
      );
    }));

    if (payers == null) {
      set(err, el("div", { class: "alert warn" }, icon("alert"),
        el("span", {}, "Couldn't check reviewers against deposits right now, so no one is marked as a verified payer. Reload to try again, or see deposits on ",
          el("a", { class: "link", href: celoscanAddr(AGENT) + "#tokentxns" }, "Celoscan"), ".")));
      err.hidden = false;
    }
  } catch {
    for (const id of ["#rev-avg", "#rev-count", "#rev-verified"]) set($(id), DASH);
    set($("#rev-status"), badge("Unavailable", "err"));
    set(rows, reviewEmptyRow("Reviews couldn't be loaded."));
    set(err, errorAlert("Could not read reviews from Celo right now. Try reloading, or view the reputation registry on", celoscanAddr(REPUTATION), "Celoscan"));
    err.hidden = false;
  } finally {
    region.removeAttribute("aria-busy");
  }
}

renderIdentity();
renderBalances();
renderReviews();
