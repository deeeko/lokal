import {
  AGENT, HAS_API, $, el, icon, badge, short, num2, lagosTime, celoscanAddr, celoscanTx, initChrome, toast,
  rpc, readContract, ntagUrl, receiptNo, loadNtagOps, resolveNtags, ntagOf, ownerOf, ntagAvailability, ntagNameError,
  encodeNtagClaim, encodeNtagRelease, RELEASE_LOCK_DAYS, DISCONNECT_NOTE_FULL, DISCONNECT_NOTE_PARTIAL, TOKENS, loadRate, usd,
} from "../assets/core.js";
import {
  getSession, signIn, signOut, onSessionChange, watchSession, explainWalletError, injectedWallet, ensureCelo, rememberNtag, avatar,
} from "../assets/session.js";
import {
  ntagCard, stage, revealCard, shareBlock, alertBox, availabilityMessage, ntagRules, cleanTagInput, suggestNtags, waitForReceipt,
  plainError, sameAddr, sleep, nameText, LIMITS, LIMITS_TEXT, REFUSED_NOTE, receivableToday, loadNtagStateFresh, loadTagLedger,
  slowNotice, scrollToNode, focusHeading, noWalletHelp, noCeloAlert, celoBalance,
  agentStatus, allowanceFromStatus, combineAllowance, statusFinal, receivedStale, reasonText, paidText, sourceNote, units6Of,
  STATUS_SOURCE, DELAYED_NOTE, SLOW_NOTE, payoutText,
} from "../assets/ntag-ui.js";
import { currencyOf, formatCurrency } from "../assets/core.js";
import { currencyPicker, flagIcon } from "../assets/currency-ui.js";

initChrome();

// Account: sign in with a wallet, claim / change / release an nTag, share it, see the wallet and payments to the tag.
// Claims and releases are zero-value transactions from the user's own wallet to the agent (site/_spec/NTAGS.md).
// New users follow one guide: Sign in → Your name → Claim your @nTag → Done. Returning users with a tag see their tag.

const root = $("#account-root");
const A = {
  rendered: undefined, // the address the page was built for (null = signed out), so session pings don't rebuild it
  ops: null, st: null, opsErr: false,
  view: null, // null (default for the state) | "change"
  busy: false, // a transaction is in flight: never rebuild under it
  rerender: false, // the session changed while busy: rebuild once it's done
  note: null, // a one-off message for the next render
  rate: null,
};
const prefill = (() => {
  const m = location.hash.match(/claim=([^&]+)/);
  if (!m) return "";
  let t = m[1];
  try { t = decodeURIComponent(t); } catch { /* malformed escape: use it as typed */ }
  return cleanTagInput(t);
})();
const isHash = (h) => /^0x[0-9a-fA-F]{64}$/.test(String(h));
const errText = (e) => (e?.plain || e?.code === "NO_WALLET" ? e.message : explainWalletError(e));
const dollars = (v) => usd(Math.floor(v * 100 + 1e-6) / 100).replace(/\.00$/, "");
/** Marks a transaction as running or finished; a sign-out (or account switch) during it rebuilds the page afterwards. */
function setBusy(on) {
  A.busy = on;
  if (!on && A.rerender) { A.rerender = false; setTimeout(render, 0); }
}

// ---------- shared state ----------
async function loadState(force = false) {
  try {
    A.ops = await loadNtagOps({ force });
    A.st = resolveNtags(A.ops);
    A.opsErr = false;
  } catch {
    A.opsErr = true;
  }
}
/** Reads every nTag straight from Blockscout (no edge cache) and keeps it. Throws if the explorer can't be reached. */
async function loadFresh() {
  const { ops, state } = await loadNtagStateFresh();
  A.ops = ops;
  A.st = state;
  A.opsErr = false;
  return state;
}
/** Polls Blockscout (no cache) until the op `hash` is listed (about 2 minutes). Returns its status, or null if not listed yet. */
async function waitIndexed(hash) {
  for (let i = 0; i < 30; i++) {
    try {
      const st = await loadFresh();
      const op = A.ops.find((o) => String(o.hash).toLowerCase() === String(hash).toLowerCase());
      if (op) return st.statuses.get(op.hash) ?? "invalid";
    } catch { /* explorer hiccup: keep polling */ }
    await sleep(4000);
  }
  return null;
}
/** Asks the wallet for the signed-in account and Celo. Throws a plain error if the wallet is on another account. */
async function walletReady(addr) {
  const eth = injectedWallet();
  if (!eth) throw plainError("No wallet found in this browser. Open this page in your wallet's browser to continue.");
  const accs = await eth.request({ method: "eth_requestAccounts" });
  if (!sameAddr(accs?.[0], addr)) {
    throw plainError(`Your wallet is on ${accs?.[0] ? short(accs[0]) : "no account"}, but you're signed in as ${short(addr)}. Switch back to that account in your wallet and try again. Nothing was sent.`);
  }
  await ensureCelo(eth);
  return eth;
}

// ---------- progress list for a transaction ----------
function progress(items) {
  const rows = new Map();
  const list = el("ol", { class: "nt-progress" }, items.map(([id, title, sub]) => {
    const small = el("small", {}, sub ?? "");
    const b = el("b", {}, title);
    const li = el("li", { dataset: { id } }, el("span", { class: "nt-p-icon", "aria-hidden": "true" }), el("div", {}, b, small));
    rows.set(id, { li, small, b });
    return li;
  }));
  list.set = (id, state, sub, heading) => {
    const r = rows.get(id);
    if (!r) return;
    r.li.className = state ?? "";
    r.li.firstChild.replaceChildren(...(state === "done" ? [icon("check")] : state === "err" ? [icon("x")] : []));
    if (state === "active") r.li.setAttribute("aria-current", "step"); else r.li.removeAttribute("aria-current");
    if (sub !== undefined) r.small.replaceChildren(...[].concat(sub));
    if (heading) r.b.textContent = heading;
  };
  list.small = (id) => rows.get(id)?.small;
  list.active = () => [...rows.keys()].find((k) => rows.get(k).li.classList.contains("active"));
  return list;
}
const txLink = (hash) => el("a", { class: "link", href: celoscanTx(hash) }, "View on Celoscan ", icon("ext"));
/** Waits for a receipt with the "Waiting for Celo to confirm…" step and, after 20 s, an elapsed timer and a Celoscan link. */
async function confirmStep(list, id, hash, failMessage, doneHeading) {
  list.set(id, "active", "Usually a few seconds.", "Waiting for Celo to confirm…");
  const stop = slowNotice(list.small(id), hash);
  try {
    const rc = await waitForReceipt(hash, { failMessage });
    if (rc) list.set(id, "done", "Confirmed.", doneHeading);
    return rc;
  } finally {
    stop();
  }
}

// ---------- the setup guide: Sign in → Your name → Claim your @nTag → Done ----------
const AVAIL_LABEL = { free: "Available", yours: "Yours", taken: "Taken", reserved: "Reserved", locked: "On hold", invalid: "Invalid", checking: "Checking", idle: "" };

/**
 * mode "signin" (signed out), "new" (signed in, no tag) or "change" (has a tag). Completed steps collapse to one line
 * with a check; only the current step is open.
 */
function guide(mode, s, current) {
  const addr = s?.address ?? null;
  const ids = mode === "change" ? ["name", "claim", "done"] : ["signin", "name", "claim", "done"];
  const labels = { signin: "Sign in", name: "Your name", claim: mode === "change" ? "Your Lokal tag" : "Claim your Lokal tag", done: "Done" };
  const f = { tag: mode === "change" ? current.tag : prefill, name: current?.name ?? "", agree: false, hash: null, celoAnyway: false };
  const isRename = () => mode === "change" && f.tag === current.tag;
  let started = false; // focus follows the steps only after the person has done something

  const preview = ntagCard({ tag: f.tag, name: f.name, address: addr, kind: "preview" });
  const side = el("div", { class: "nt-claim-side" }, stage(preview, "Live preview"));
  const steps = new Map();
  const list = el("ol", { class: "nt-guide", "aria-label": "Steps" });
  ids.forEach((id, i) => {
    const dot = el("span", { class: "nt-g-dot", "aria-hidden": "true" }, String(i + 1));
    const h = el("h3", { class: "nt-g-title" }, labels[id]);
    const sum = el("span", { class: "nt-g-sum" });
    const edit = el("button", { class: "btn btn-ghost btn-sm nt-g-edit", type: "button", hidden: true, "aria-label": `Change ${labels[id].toLowerCase()}` }, "Change");
    const body = el("div", { class: "nt-g-body", hidden: true });
    const li = el("li", { class: "nt-g-step", dataset: { state: "todo", step: id } },
      el("div", { class: "nt-g-head" }, dot, el("div", { class: "nt-g-text" }, h, sum), edit), body);
    steps.set(id, { li, dot, h, sum, edit, body, n: i + 1 });
    list.append(li);
  });
  steps.get("name").edit.addEventListener("click", () => { if (!A.busy) go("name"); });
  const layout = el("div", { class: "nt-claim" }, el("div", { class: "stack", style: "gap:20px" }, list), side);
  const head = el("div", { class: "card-h" }, el("h2", { id: "claim-h" }, mode === "change" ? "Change your Lokal tag" : "Set up your Lokal tag"));
  if (mode === "change") {
    const cancel = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, icon("x"), "Cancel");
    cancel.addEventListener("click", () => { if (A.busy) return; A.view = null; renderTag(s); focusHeading($("#tag-h")); });
    head.append(cancel);
  } else {
    head.append(badge("Tiny network fee", "neutral"));
  }
  const section = el("section", { class: "card", id: "tag-section", "aria-labelledby": "claim-h" }, head, el("div", { class: "card-b" }, layout));

  const summary = {
    signin: () => (addr ? ["Signed in as ", el("span", { class: "mono" }, short(addr))] : []),
    name: () => (f.name ? [nameText(f.name)] : ["No display name"]),
    claim: () => [el("span", { class: "np-tagname", style: "color:var(--celo)" }, "@" + f.tag)],
    done: () => [],
  };
  function go(id) {
    const at = ids.indexOf(id);
    for (const [k, st] of steps) {
      const i = ids.indexOf(k);
      const state = i < at || (id === "done" && k === "done") ? "done" : i === at ? "current" : "todo";
      st.li.dataset.state = state;
      if (state === "current") st.li.setAttribute("aria-current", "step"); else st.li.removeAttribute("aria-current");
      st.dot.replaceChildren(...(state === "done" ? [icon("check")] : [String(st.n)]));
      st.sum.replaceChildren(...(state === "done" ? summary[k]() : []));
      st.edit.hidden = !(k === "name" && state === "done" && id === "claim");
      st.body.hidden = state !== "current" && !(id === "done" && k === "done");
      if (st.body.hidden) st.body.replaceChildren();
    }
    layout.classList.toggle("is-done", id === "done");
    side.hidden = id === "done";
    const st = steps.get(id);
    st.body.replaceChildren(...{ signin: signinBody, name: nameBody, claim: claimBody, done: doneBody }[id]());
    st.body.classList.remove("nt-panel");
    void st.body.offsetWidth;
    st.body.classList.add("nt-panel");
    if (started) focusHeading(st.h);
  }

  // 1. sign in (signed out only)
  function signinBody() {
    const eth = injectedWallet();
    const msg = el("div", { "aria-live": "polite" });
    const parts = [el("p", { class: "soft" }, "No password and no email. Your wallet proves it's you, and the site never sees your keys. Signing in is free and sends nothing.",
      prefill ? ` Then claim @${prefill}.` : "")];
    if (!eth) {
      parts.push(noWalletHelp({ action: "sign in" }));
    } else {
      const b = el("button", { class: "btn btn-primary btn-lg", type: "button" }, icon("wallet"), el("span", {}, "Sign in with your wallet"));
      b.addEventListener("click", async () => {
        b.disabled = true;
        b.lastChild.textContent = "Check your wallet…";
        msg.replaceChildren(el("p", { class: "small muted", role: "status" }, "Approve the connection, then sign the message. Signing is free."));
        try {
          await signIn(eth);
          toast("Signed in");
        } catch (e) {
          b.disabled = false;
          b.lastChild.textContent = "Sign in with your wallet";
          msg.replaceChildren(alertBox("err", "alert", el("p", {}, errText(e))));
        }
      });
      parts.push(el("div", { class: "nt-actions" }, b));
    }
    if (A.note) { parts.push(alertBox("", "info", el("p", {}, A.note))); A.note = null; }
    parts.push(msg);
    return [el("div", { class: "stack", style: "gap:14px" }, ...parts)];
  }

  // 2. your name
  function nameBody() {
    const had = (current?.name ?? "").trim();
    const baseHint = mode === "change"
      ? "Names can be changed but not removed. Shown on your card and pay page; up to 40 characters."
      : "Optional. Shown on your card and pay page, up to 40 characters. It's public and stays onchain; you can change it later, but not remove it.";
    const nameIn = el("input", { class: "input", id: "claim-name", type: "text", value: f.name, maxlength: "40", autocomplete: "name", placeholder: "Ada Obi", "aria-describedby": "claim-name-hint" });
    const hint = el("p", { class: "hint", id: "claim-name-hint" }, baseHint);
    const next = el("button", { class: "btn btn-primary btn-lg", type: "button" }, "Continue", icon("right"));
    const problem = () => {
      const v = nameIn.value.trim();
      if (v) return ntagNameError(nameIn.value) ? `The ${ntagNameError(nameIn.value)}.` : null;
      return mode === "change" && had ? "Names can be changed but not removed. Enter a name." : null;
    };
    const update = () => {
      f.name = nameIn.value.trim();
      preview.update({ name: nameIn.value });
      const p = problem();
      hint.classList.toggle("err", !!p);
      hint.textContent = p ?? baseHint;
      nameIn.setAttribute("aria-invalid", String(!!p));
      next.disabled = !!p;
      next.firstChild.textContent = !f.name && mode !== "change" ? "Skip for now" : "Continue";
    };
    nameIn.addEventListener("input", () => { started = true; update(); });
    nameIn.addEventListener("keydown", (e) => { if (e.key === "Enter" && !next.disabled) next.click(); });
    next.addEventListener("click", () => { update(); if (!problem()) { started = true; go("claim"); } });
    setTimeout(() => { update(); if (started) nameIn.focus({ preventScroll: true }); }, 0);
    return [el("div", { class: "stack", style: "gap:14px" },
      el("label", { class: "label", for: "claim-name" }, mode === "change" ? "Display name" : "Display name (optional)"),
      nameIn, hint, el("div", { class: "nt-actions" }, next))];
  }

  // 3. claim your @nTag: pick, check, agree, send, confirm
  function claimBody() {
    const input = el("input", {
      id: "claim-tag", type: "text", value: f.tag, placeholder: "yourname", autocomplete: "off", autocapitalize: "none",
      spellcheck: "false", maxlength: "21", enterkeyhint: "done", "aria-describedby": "claim-msg claim-rules",
    });
    const pillText = el("span", { class: "nt-avail-text" });
    const pill = el("span", { class: "nt-avail", dataset: { state: "idle" }, "aria-hidden": "true" }, el("span", { class: "nt-avail-dot" }, icon("check")), pillText);
    const box = el("div", { class: "nt-taginput", dataset: { state: "idle" } }, el("span", { class: "nt-at", "aria-hidden": "true" }, "@"), input, pill);
    const ruleEls = ntagRules("").map((r) => el("li", { dataset: { rule: r.id } }, r.label));
    const rules = el("ul", { class: "nt-rules", id: "claim-rules", "aria-label": "Tag rules" }, ruleEls);
    const msg = el("p", { class: "nt-msg", id: "claim-msg", role: "status", "aria-live": "polite" });
    const sugg = el("div", { class: "nt-suggest" });
    const switchNote = el("div", {});
    const agree = el("input", { type: "checkbox", id: "claim-agree" });
    agree.checked = f.agree;
    const go3 = el("button", { class: "btn btn-primary btn-lg", type: "button", disabled: true }, "Claim");
    const out = el("div", { "aria-live": "polite" });
    const after = el("div", { class: "nt-actions" });
    const pick = el("div", { class: "stack", style: "gap:14px" },
      el("p", { class: "small soft" }, "This is how people find and pay you. Lowercase; we tidy it up as you type."),
      el("label", { class: "sr-only", for: "claim-tag" }, "Your Lokal tag"),
      box, msg, sugg, rules,
      el("ul", { class: "kv-list" },
        el("li", {}, el("span", {}, "Wallet"), el("a", { class: "mono link", href: celoscanAddr(addr), title: addr }, short(addr))),
        el("li", {}, el("span", {}, "Sends"), el("span", {}, "0 CELO to the agent, with your tag in the data")),
        el("li", {}, el("span", {}, "Network fee"), el("span", {}, "Paid in CELO, usually well under $0.01"))),
      switchNote,
      alertBox("", "lock", el("p", {}, el("b", {}, "Public and permanent. "),
        "Your tag, display name and wallet address are written to Celo, where anyone can read them. You can release a tag later, but the record stays onchain.")),
      el("label", { class: "toggle", for: "claim-agree" }, agree, "I understand my tag, name and wallet are public and permanent."),
      el("div", { class: "nt-actions" }, go3));
    const wrap = el("div", { class: "stack", style: "gap:16px" }, pick, out, after);
    let timer = null, kind = "idle", running = false;

    const setPill = (k) => { pill.dataset.state = k; box.dataset.state = k; pillText.textContent = AVAIL_LABEL[k] ?? ""; };
    const renameProblem = () => {
      if (!isRename()) return null;
      if (!f.name) return `Names can be changed but not removed. To keep @${f.tag}, go back and enter a new display name.`;
      if (f.name === (current.name ?? "").trim()) return `That's already your name on @${f.tag}. Change the display name, or pick a different tag.`;
      return null;
    };
    const canGo = () => !running && f.agree && (kind === "free" || (kind === "yours" && isRename() && !renameProblem()));
    const refresh = () => {
      go3.disabled = !canGo();
      go3.textContent = isRename() ? "Update my name" : f.tag ? `Claim @${f.tag}` : "Claim";
      switchNote.replaceChildren(...(mode === "change" && !isRename() && kind === "free" ? [alertBox("warn", "alert", el("p", {}, el("b", {}, `@${current.tag} will be released.`),
        ` For ${RELEASE_LOCK_DAYS} days only you can claim it back; after that anyone can. Payments sent to @${current.tag} after the switch are refused, not paid.`))] : []));
    };
    const showSuggestions = (t, st) => {
      sugg.replaceChildren();
      const picks = suggestNtags(t, f.name, st, addr);
      if (!picks.length) return;
      sugg.append(el("span", { class: "nt-suggest-label" }, "Free right now:"));
      for (const p of picks) {
        const c = el("button", { class: "nt-chip", type: "button", "aria-label": `Use @${p}` }, el("span", { class: "ntag-at" }, "@"), p);
        c.addEventListener("click", () => { if (running) return; input.value = p; onTag(); input.focus(); });
        sugg.append(c);
      }
    };
    const evaluate = () => {
      const t = f.tag;
      if (!t) { setPill("idle"); msg.textContent = ""; sugg.replaceChildren(); kind = "idle"; refresh(); return; }
      kind = ntagAvailability(A.st, t, addr);
      setPill(kind);
      let text = availabilityMessage(t, kind, { owner: ownerOf(A.st, t), lock: A.st.locks.get(t) }).text;
      if (kind === "taken") text = `@${t} is taken — pick another.`;
      if (kind === "yours") text = mode === "change" ? (renameProblem() ?? `@${t} is already yours. Claiming it again updates the display name.`) : text;
      if (kind === "free" && mode === "change") text = `@${t} is available. @${current.tag} will be released when you switch.`;
      msg.replaceChildren(text);
      if (kind === "taken" || kind === "locked" || kind === "reserved") showSuggestions(t, A.st); else sugg.replaceChildren();
      refresh();
    };
    const onTag = () => {
      const clean = cleanTagInput(input.value);
      if (clean !== input.value) {
        const atEnd = input.selectionStart === input.value.length;
        input.value = clean;
        if (atEnd) input.setSelectionRange(clean.length, clean.length);
      }
      f.tag = clean;
      preview.update({ tag: clean });
      ntagRules(clean).forEach((r, i) => { ruleEls[i].classList.toggle("ok", r.ok === true); ruleEls[i].classList.toggle("bad", r.ok === false); });
      clearTimeout(timer);
      go3.disabled = true;
      if (!clean) { evaluate(); return; }
      setPill("checking");
      timer = setTimeout(evaluate, 250);
    };
    input.addEventListener("input", () => { started = true; out.replaceChildren(); after.replaceChildren(); onTag(); });
    agree.addEventListener("change", () => { f.agree = agree.checked; refresh(); });
    go3.addEventListener("click", () => { if (canGo()) run("check"); });

    const lock = (on) => { running = on; input.disabled = on; agree.disabled = on; for (const b of sugg.querySelectorAll("button")) b.disabled = on; refresh(); };
    const steps2 = () => progress([
      ["wallet", "Confirm in your wallet", "It sends 0 CELO. You pay only the network fee."],
      ["chain", "Celo confirms it", ""],
      ["index", "The explorer lists your claim", "Up to about a minute."],
      ["yours", isRename() ? "Your name is updated" : `@${f.tag} is yours`, "Checked against every claim, in order."],
    ]);
    let plist = null;
    /** A taken (or on-hold) tag: say so plainly, with fresh suggestions, and let them pick again. */
    const takenNow = (t, st, why) => {
      kind = ntagAvailability(st, t, addr);
      setPill(kind);
      msg.replaceChildren(why);
      showSuggestions(t, st);
      lock(false);
      input.focus({ preventScroll: true });
    };
    const fail = (e) => {
      setBusy(false);
      lock(false);
      const at = plist?.active();
      if (at) plist.set(at, e.pending ? "" : "err");
      const hash = e.hash ?? f.hash;
      out.replaceChildren(alertBox(e.pending ? "warn" : "err", "alert", el("p", {}, errText(e), ...(hash ? [" ", txLink(hash)] : []))));
      after.replaceChildren();
      if (e.race) {
        // someone else's claim landed first: explain, refresh the suggestions and let them pick again
        takenNow(f.tag, A.st, `@${f.tag} is taken — pick another.`);
        f.hash = null;
      } else if (e.pending) {
        lock(true);
        const again = el("button", { class: "btn btn-primary", type: "button" }, icon("refresh"), "Check again");
        again.addEventListener("click", () => { out.replaceChildren(); after.replaceChildren(); run(e.indexing ? "index" : "chain"); });
        after.append(again);
      }
    };

    async function run(from) {
      setBusy(true);
      lock(true);
      const t = f.tag;
      try {
        if (from === "check") {
          go3.textContent = `Checking @${t}…`;
          out.replaceChildren();
          after.replaceChildren();
          // right before the wallet opens: re-read every claim straight from Blockscout (no cache)
          let st;
          try { st = await loadFresh(); } catch { throw plainError("Couldn't reach the Celo explorer to re-check the tag, so nothing was sent. Try again in a moment."); }
          const k = ntagAvailability(st, t, addr);
          if (k === "taken" || k === "locked" || k === "reserved" || k === "invalid") {
            setBusy(false);
            takenNow(t, st, k === "taken" ? `@${t} is taken — pick another.` : `${availabilityMessage(t, k, { lock: st.locks.get(t) }).text} Pick another.`);
            return;
          }
          if (k === "yours" && !isRename()) throw plainError(`@${t} is already yours, so nothing was sent.`);
          if (isRename() && ownerOf(st, t)?.name === f.name) throw plainError(`That's already your name on @${t}, so nothing was sent.`);
          if (!f.celoAnyway && (await celoBalance(addr)) === 0n) {
            setBusy(false);
            lock(false);
            out.replaceChildren(noCeloAlert(() => { f.celoAnyway = true; out.replaceChildren(); run("check"); }, "Claim anyway"));
            out.querySelector("button")?.focus();
            return;
          }
          plist?.remove();
          plist = steps2();
          wrap.insertBefore(plist, out);
          plist.set("wallet", "active");
          go3.textContent = "Check your wallet…";
          const eth = await walletReady(addr);
          const data = encodeNtagClaim(f.name ? { t, n: f.name } : { t });
          const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from: addr, to: AGENT, value: "0x0", data }] });
          if (!isHash(hash)) throw plainError("The wallet didn't return a transaction id. Check your wallet's activity before trying again.");
          f.hash = hash;
          plist.set("wallet", "done", ["Sent. ", txLink(hash)]);
          go3.textContent = isRename() ? "Updating…" : `Claiming @${t}…`;
          from = "chain";
        }
        if (from === "chain") {
          const rc = await confirmStep(plist, "chain", f.hash, "The claim transaction failed on Celo, so nothing changed. Only the network fee was spent.", "Celo confirmed it");
          if (!rc) throw plainError("Celo hasn't confirmed it after three minutes. It may still go through.", { pending: true });
          from = "index";
        }
        plist.set("index", "active");
        const status = await waitIndexed(f.hash);
        if (status == null) throw plainError("Celo confirmed it, but the explorer hasn't listed it yet. It still counts in the order it was made.", { pending: true, indexing: true });
        plist.set("index", "done", "Listed.");
        // re-resolve: the claim counts only if nobody else's landed first
        if (ntagOf(A.st, addr) === t && (!isRename() || ownerOf(A.st, t)?.name === f.name)) {
          const entry = ownerOf(A.st, t);
          plist.set("yours", "done");
          rememberNtag(addr, t, entry?.name ?? null);
          setBusy(false);
          renderPayments(s);
          setTimeout(() => { started = true; go("done"); }, 450);
          return;
        }
        plist.set("yours", "active");
        if (status === "taken") throw plainError(`Someone else claimed @${t} a moment before you, so it went to them. Your transaction changed nothing; only the network fee was spent.`, { race: true });
        if (status === "locked") throw plainError(`@${t} is on hold for its previous owner, so your claim changed nothing. Only the network fee was spent.`, { race: true });
        throw plainError(`The claim was recorded but didn't take effect (${status}). Only the network fee was spent.`);
      } catch (e) {
        fail(e);
      }
    }
    if (mode === "change" && f.tag === current.tag && !f.name) f.tag = ""; // nothing to rename to: start with an empty tag
    input.value = f.tag;
    setTimeout(() => { onTag(); if (started) input.focus({ preventScroll: true }); }, 0);
    return [wrap];
  }

  // 4. done: the celebration, share, and what to do next
  function doneBody() {
    const t = f.tag;
    const entry = ownerOf(A.st, t);
    const url = ntagUrl(t);
    const card = ntagCard({ tag: t, name: entry?.name ?? f.name, address: addr, since: entry?.since ?? Math.floor(Date.now() / 1000), as: "button", label: `Your Lokal tag @${t}. Copy the link to your pay page` });
    card.dataset.copy = url;
    card.dataset.copyLabel = "Link copied";
    const doneBtn = el("button", { class: "btn btn-ghost", type: "button" }, "Go to your account");
    doneBtn.addEventListener("click", () => {
      A.view = null;
      renderTag(s);
      renderPayments(s);
      const h = $("#tag-h");
      focusHeading(h);
      scrollToNode($("#tag-section"));
    });
    requestAnimationFrame(() => revealCard(card, isRename() ? "Updated" : "Claimed"));
    return [el("div", { class: "nt-done" },
      stage(card),
      el("div", {}, el("p", { class: "nt-done-title" }, isRename() ? "Name updated" : el("span", {}, el("span", { class: "np-tagname", style: "color:var(--celo)" }, "@" + t), " is yours")),
        el("p", { class: "soft mt-8" }, "Share your link. Anyone can pay you in dollars or naira, and the agent pays this wallet.")),
      shareBlock(t),
      el("div", { class: "nt-next" },
        el("p", { class: "label" }, "What next?"),
        el("div", { class: "nt-actions", style: "justify-content:center" },
          el("a", { class: "btn btn-secondary", href: "quote.html" }, icon("quote"), "Send money"),
          el("a", { class: "btn btn-secondary", href: "get-paid.html" }, icon("wallet"), "Get paid"),
          doneBtn)))];
  }

  // signed in just now, or opened "Change" on purpose: focus follows the steps from the first one
  started = mode !== "signin" && Boolean(A.interacted);
  go(mode === "signin" ? "signin" : "name");
  return section;
}

// ---------- owned tag ----------
function ownedView(s, tag, entry) {
  const addr = s.address;
  const url = ntagUrl(tag);
  const card = ntagCard({ tag, name: entry.name, address: addr, since: entry.since, currency: entry.currency, as: "button", label: `Your Lokal tag @${tag}. Copy the link to your pay page` });
  card.dataset.copy = url;
  card.dataset.copyLabel = "Link copied";
  const receive = preferredCurrency(s, tag, entry);
  const change = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, "Change tag or name");
  change.addEventListener("click", () => { A.view = "change"; A.interacted = true; renderTag(s); focusHeading($("#claim-h")); });
  const releaseBtn = el("button", { class: "btn btn-ghost btn-sm", type: "button", "aria-expanded": "false", "aria-controls": "release-box" }, "Release tag");
  const releaseBox = el("div", { class: "nt-release stack", id: "release-box", hidden: true });
  releaseBtn.addEventListener("click", () => {
    if (A.busy) return;
    const open = releaseBox.hidden;
    releaseBox.hidden = !open;
    releaseBtn.setAttribute("aria-expanded", String(open));
    if (open) { releaseBox.replaceChildren(...releaseParts(s, tag)); releaseBox.querySelector("input")?.focus(); }
  });
  const today = el("p", { class: "small soft" }, "Checking how much more you can receive today…");
  loadAllowanceInto(today, addr);
  const note = A.note ? alertBox("", "info", el("p", {}, A.note)) : null;
  A.note = null;
  return el("section", { class: "card", id: "tag-section", "aria-labelledby": "tag-h" },
    el("div", { class: "card-h" }, el("h2", { id: "tag-h" }, "Your Lokal tag"), el("span", { class: "badge ok" }, el("span", { class: "dot" }), "Live")),
    el("div", { class: "card-b stack" },
      note,
      el("div", { class: "nt-owned" },
        stage(card, "Tap the card to copy your link."),
        el("div", { class: "stack" },
          el("div", {}, el("h3", { class: "section-title" }, "People can pay ", el("span", { class: "np-tagname", style: "color:var(--celo)" }, "@" + tag)),
            el("p", { class: "soft mt-8" }, "Share your link. People pay in dollars, and the agent converts it on Textile FX and pays this wallet in the currency you choose below.")),
          receive,
          shareBlock(tag),
          el("div", { class: "nt-limits" }, today, el("p", { class: "micro muted" }, LIMITS_TEXT, ". ", REFUSED_NOTE)),
          el("ul", { class: "kv-list" },
            el("li", {}, el("span", {}, "Display name"), entry.name ? el("span", {}, nameText(entry.name)) : el("span", {}, "None")),
            el("li", {}, el("span", {}, "You receive"), entry.currency
              ? el("span", { class: "cur-inline" }, flagIcon(entry.currency), `${currencyOf(entry.currency).label} (${currencyOf(entry.currency).token})`)
              : el("span", {}, "Naira (the default)")),
            el("li", {}, el("span", {}, "Claimed"), el("span", {}, `${lagosTime(entry.since * 1000)} WAT`)),
            el("li", {}, el("span", {}, "Claim transaction"), el("a", { class: "mono link", href: celoscanTx(entry.hash), title: entry.hash }, short(entry.hash)))),
          el("div", { class: "row" }, change, releaseBtn),
          releaseBox))));
}
/**
 * "You receive": the currency payers see pre-selected on your pay page. Saving sends one zero-value transaction from your
 * wallet to the agent, {"t":"<tag>","c":"<code>"} (like a name change): it changes nothing else about the tag. Payers can
 * still choose another currency for their own payment.
 */
const MINIPAY_NOTE = "Using MiniPay? Choose dollars (USD₮); MiniPay doesn't show local tokens yet. Payers pick Dollars on your pay page.";
function preferredCurrency(s, tag, entry) {
  const addr = s.address;
  const saved = entry.currency ?? null;
  const status = el("div", { "aria-live": "polite" });
  const save = el("button", { class: "btn btn-primary btn-sm", type: "button", disabled: true }, "Save");
  const picker = currencyPicker({
    label: "The currency you receive", describedBy: "receive-h", value: saved ?? "cngn", remember: false,
    onChange: () => paint(),
  });
  const est = el("p", { class: "micro muted", "aria-live": "polite" });
  function paint() {
    const c = currencyOf(picker.value);
    const changed = picker.value !== (saved ?? "cngn") || (saved == null && picker.value !== "cngn");
    save.disabled = A.busy || !changed || !picker.isAvailable(picker.value);
    save.textContent = changed ? `Save ${c.label}` : "Saved";
    picker.note(`${saved ? `Payers see ${currencyOf(saved).plural} first on your pay page.` : "Not chosen yet: payers see naira first."} ${MINIPAY_NOTE}`);
    const r = A.rate?.available?.[c.code] ? A.rate.rates[c.code] : null;
    est.textContent = r ? `$10 from a payer ≈ ${formatCurrency(10 * r, c.code)} for you today (rounded down; the rate moves).` : " ";
  }
  save.addEventListener("click", async () => {
    if (A.busy) return;
    const code = picker.value, c = currencyOf(code);
    setBusy(true);
    save.disabled = true;
    save.textContent = "Check your wallet…";
    status.replaceChildren();
    try {
      const eth = await walletReady(addr);
      const data = encodeNtagClaim({ t: tag, c: code });
      const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from: addr, to: AGENT, value: "0x0", data }] });
      if (!isHash(hash)) throw plainError("The wallet didn't return a transaction id. Check your wallet's activity before trying again.");
      save.textContent = "Waiting for Celo…";
      status.replaceChildren(el("p", { class: "small soft" }, "Sent. ", el("a", { class: "link", href: celoscanTx(hash) }, "View on Celoscan ", icon("ext"))));
      const rc = await waitForReceipt(hash, { failMessage: "The transaction failed on Celo, so nothing changed. Only the network fee was spent." });
      if (!rc) throw plainError("Celo hasn't confirmed it after a few minutes. It may still go through; check back soon.");
      save.textContent = "Listing it…";
      const st = await waitIndexed(hash);
      if (st == null) throw plainError("Celo confirmed it, but the explorer hasn't listed it yet. It counts anyway; reload in a minute.");
      if (ownerOf(A.st, tag)?.currency !== code) throw plainError(`The change was recorded but didn't take effect (${st}). Only the network fee was spent.`);
      A.note = `Saved: you receive ${c.plural} (${c.token}). Payers see it first on your pay page.`;
      setBusy(false);
      A.rendered = undefined; // rebuild with the new preference
      render();
    } catch (e) {
      setBusy(false);
      status.replaceChildren(alertBox("err", "alert", el("p", {}, errText(e))));
      paint();
    }
  });
  if (!A.rate) loadRate().then((r) => { A.rate = r; picker.setAvailability(r.available); paint(); }).catch(() => {});
  else picker.setAvailability(A.rate.available);
  paint();
  return el("div", { class: "nt-receive stack", style: "gap:10px" },
    el("div", {}, el("h4", { class: "label", id: "receive-h" }, "You receive"), el("p", { class: "micro muted" }, "Pick what you'd like to be paid in. Changing it is one free transaction from your wallet (only the network fee).")),
    picker.el, el("div", { class: "row", style: "gap:12px;flex-wrap:wrap" }, save), est, status);
}

async function loadAllowanceInto(node, addr) {
  const lim = `limit $${LIMITS.perPersonDay} per person per day`;
  try {
    // the chain always, the agent's records when fresh; the smaller room wins (see combineAllowance)
    if (!A.rate) A.rate = await loadRate().catch(() => null);
    const [server, chain] = await Promise.all([
      agentStatus({ recipient: addr }).then((a) => allowanceFromStatus(a)).catch(() => null),
      receivableToday(addr, A.rate).catch(() => null),
    ]);
    const a = combineAllowance(server, chain);
    if (!a) throw new Error("no allowance");
    node.replaceChildren(el("b", {}, `You can receive ${a.exact ? "" : "about "}${dollars(a.leftUsd)} more today`), ` · ${lim}. `, sourceNote(a.source === "agent"));
  } catch {
    node.textContent = `Couldn't check how much more you can receive today (${lim}). The agent still checks it before paying.`;
  }
}

function releaseParts(s, tag) {
  const addr = s.address;
  const agree = el("input", { type: "checkbox", id: "release-agree" });
  const go = el("button", { class: "btn btn-danger", type: "button", disabled: true }, `Release @${tag}`);
  const cancel = el("button", { class: "btn btn-ghost", type: "button" }, "Keep it");
  const msg = el("div", { "aria-live": "polite" });
  const actions = el("div", { class: "nt-actions" }, cancel, go);
  const list = progress([
    ["wallet", "Confirm in your wallet", "It sends 0 CELO. You pay only the network fee."],
    ["chain", "Celo confirms it", ""],
    ["index", "The explorer lists it", "Up to about a minute."],
  ]);
  list.hidden = true;
  let hash = null, celoAnyway = false;
  agree.addEventListener("change", () => { go.disabled = !agree.checked; });
  cancel.addEventListener("click", () => { if (!A.busy) { A.view = null; renderTag(s); focusHeading($("#tag-h")); } });
  const released = () => {
    rememberNtag(addr, null);
    setBusy(false);
    A.note = `Released @${tag}. For ${RELEASE_LOCK_DAYS} days only you can claim it back. Pick a new tag below whenever you like.`;
    A.view = null;
    toast(`Released @${tag}`);
    renderTag(s);
    renderPayments(s);
    focusHeading($("#claim-h"));
  };
  async function run(from) {
    setBusy(true);
    go.disabled = true; cancel.disabled = true; agree.disabled = true;
    msg.replaceChildren();
    try {
      if (from === "wallet") {
        if (!celoAnyway && (await celoBalance(addr)) === 0n) {
          setBusy(false);
          go.disabled = false; cancel.disabled = false; agree.disabled = false;
          msg.replaceChildren(noCeloAlert(() => { celoAnyway = true; msg.replaceChildren(); run("wallet"); }, "Release anyway"));
          return;
        }
        list.hidden = false;
        list.set("wallet", "active");
        const eth = await walletReady(addr);
        hash = await eth.request({ method: "eth_sendTransaction", params: [{ from: addr, to: AGENT, value: "0x0", data: encodeNtagRelease() }] });
        if (!isHash(hash)) throw plainError("The wallet didn't return a transaction id. Check your wallet's activity before trying again.");
        list.set("wallet", "done", ["Sent. ", txLink(hash)]);
        from = "chain";
      }
      if (from === "chain") {
        const rc = await confirmStep(list, "chain", hash, "The release failed on Celo, so you still have the tag. Only the network fee was spent.", "Celo confirmed it");
        if (!rc) throw plainError("Celo hasn't confirmed it after three minutes. It may still go through.", { pending: true });
      }
      list.set("index", "active");
      const status = await waitIndexed(hash);
      if (status == null) throw plainError("Released on Celo. The explorer hasn't listed it yet, so this page may show the tag for a minute more.", { pending: true, indexing: true });
      list.set("index", "done", "Listed.");
      released();
    } catch (e) {
      setBusy(false);
      const at = list.active();
      if (at) list.set(at, e.pending ? "" : "err");
      msg.replaceChildren(alertBox(e.pending ? "warn" : "err", "alert", el("p", {}, errText(e), ...(hash ? [" ", txLink(hash)] : []))));
      if (e.pending) {
        // the release may still land: never offer to send a second one, only to look again
        go.disabled = true; agree.disabled = true; cancel.disabled = false;
        const again = el("button", { class: "btn btn-primary", type: "button" }, icon("refresh"), "Check again");
        again.addEventListener("click", () => { again.remove(); run(e.indexing ? "index" : "chain"); });
        actions.append(again);
      } else {
        go.disabled = !agree.checked; cancel.disabled = false; agree.disabled = false;
      }
    }
  }
  go.addEventListener("click", () => { if (!A.busy && agree.checked) run("wallet"); });
  return [
    alertBox("warn", "alert",
      el("p", {}, el("b", {}, `Release @${tag}?`)),
      el("p", { class: "mt-8" }, `Payments sent to @${tag} after this are refused and not paid. For ${RELEASE_LOCK_DAYS} days only you can claim @${tag} back; after that anyone can.`)),
    el("label", { class: "toggle", for: "release-agree" }, agree, `I understand payments to @${tag} stop working.`),
    list, msg, actions,
  ];
}

// ---------- the tag section ----------
const tagSlot = el("div", {});
function renderTag(s) {
  if (A.opsErr || !A.st) {
    const retry = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, icon("refresh"), "Try again");
    retry.addEventListener("click", async () => { tagSlot.replaceChildren(tagSkeleton()); await loadState(true); renderTag(s); renderPayments(s); });
    tagSlot.replaceChildren(el("section", { class: "card", id: "tag-section" },
      el("div", { class: "card-h" }, el("h2", {}, "Your Lokal tag")),
      el("div", { class: "card-b" }, alertBox("err", "alert", el("p", {}, "Couldn't reach the Celo explorer to look up Lokal tags. Your tag is safe onchain; this page just can't read it right now."), el("div", { class: "row mt-8" }, retry)))));
    return;
  }
  const tag = ntagOf(A.st, s.address);
  const entry = tag ? ownerOf(A.st, tag) : null;
  if (!tag || A.view === "change") {
    const note = !tag && A.note ? alertBox("", "info", el("p", {}, A.note)) : null;
    A.note = null;
    const flow = guide(tag ? "change" : "new", s, tag ? { tag, name: entry?.name ?? "" } : null);
    tagSlot.replaceChildren(...(note ? [note, flow] : [flow]));
    if (note) note.style.marginBottom = "18px";
    return;
  }
  tagSlot.replaceChildren(ownedView(s, tag, entry));
}
const tagSkeleton = () => el("section", { class: "card", id: "tag-section", "aria-busy": "true" },
  el("div", { class: "card-h" }, el("h2", {}, "Your Lokal tag"), el("span", { class: "skel" })),
  el("div", { class: "card-b" }, el("p", { class: "small muted", role: "status" }, el("span", { class: "skel", style: "width:14px;height:14px;border-radius:50%;margin-right:8px" }), "Reading Lokal tags from Celo…")));

// ---------- wallet ----------
const walletSlot = el("div", {});
async function tokenBalance(token, addr) {
  const [[bal], [dec]] = await Promise.all([
    readContract(token, "0x70a08231", ["address"], [addr], ["uint256"]),
    readContract(token, "0x313ce567", [], [], ["uint8"]),
  ]);
  return Number(bal) / 10 ** Number(dec);
}
function renderWallet(s) {
  const addr = s.address;
  const bal = (label) => { const b = el("b", {}, el("span", { class: "skel" })); return { tile: el("div", { class: "nt-bal" }, el("span", {}, label), b), b }; };
  const usdt = bal("USD₮"), cngn = bal("cNGN"), celo = bal("CELO");
  const status = el("div", { class: "small muted", "aria-live": "polite" });
  const load = () => {
    for (const x of [usdt, cngn, celo]) x.b.replaceChildren(el("span", { class: "skel" }));
    status.replaceChildren();
    Promise.all([
      tokenBalance(TOKENS.USDT.address, addr), tokenBalance(TOKENS.cNGN.address, addr),
      rpc("eth_getBalance", [addr, "latest"]).then((h) => Number(BigInt(h)) / 1e18),
    ]).then(([u, n, c]) => {
      usdt.b.textContent = num2.format(u);
      cngn.b.textContent = num2.format(n);
      celo.b.textContent = c > 0 && c < 0.01 ? "<0.01" : num2.format(c);
      status.replaceChildren(...(c === 0 ? [el("p", {}, "No CELO for network fees. Add a few cents of CELO before claiming or releasing a tag. ",
        el("a", { class: "link", href: "https://celo.org", target: "_blank", rel: "noopener" }, "Get CELO ", icon("ext")))] : []));
    }).catch(() => {
      for (const x of [usdt, cngn, celo]) x.b.textContent = "—";
      status.replaceChildren(el("p", {}, "Couldn't read balances from Celo right now. Try refresh."));
    });
  };
  const refresh = el("button", { class: "icon-btn sm", type: "button", "aria-label": "Refresh balances", title: "Refresh balances" }, icon("refresh"));
  refresh.addEventListener("click", load);
  const out = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, icon("logout"), "Sign out");
  out.addEventListener("click", async () => {
    if (A.busy) { toast("Wait for the transaction to finish first"); return; }
    out.disabled = true;
    const revoked = await signOut();
    A.note = revoked ? DISCONNECT_NOTE_FULL : DISCONNECT_NOTE_PARTIAL;
    A.rendered = "signing-out"; // rebuild once more so the note shows
    render();
    toast("Signed out");
  });
  walletSlot.replaceChildren(el("section", { class: "card", "aria-labelledby": "wallet-h" },
    el("div", { class: "card-h" }, el("h2", { id: "wallet-h" }, "Wallet"), el("span", { class: "badge ok" }, el("span", { class: "dot" }), "Signed in")),
    el("div", { class: "card-b stack" },
      el("div", { class: "nt-who" }, avatar(addr, "lg"),
        el("div", {}, el("a", { class: "mono link", href: celoscanAddr(addr), title: addr }, short(addr)), el("div", { class: "micro muted" }, "Celo mainnet")),
        el("button", { class: "icon-btn sm", type: "button", style: "margin-left:auto", "aria-label": "Copy wallet address", dataset: { copy: addr, copyLabel: "Address copied" } }, icon("copy"))),
      el("div", {}, el("div", { class: "row between", style: "margin-bottom:10px" }, el("span", { class: "label" }, "Balances"), refresh),
        el("div", { class: "nt-balances" }, usdt.tile, cngn.tile, celo.tile), status),
      el("ul", { class: "kv-list" },
        el("li", {}, el("span", {}, "Session ends"), el("span", { class: "num" }, lagosTime(s.exp * 1000) + " WAT")),
        el("li", {}, el("span", {}, "Sign-in checked"), el("span", {}, HAS_API ? "By this site's server" : "In this browser"))),
      el("div", { class: "row" }, out))));
  load();
}

// ---------- payments to your tag ----------
const paySlot = el("div", {});
const amountText = (units, token) => `${num2.format(Number(units) / 1e6)} ${token === "USDT" ? "USD₮" : "cNGN"}`;
const watTime = (ms) => `${lagosTime(ms)} WAT`;

/** A row for a deposit the agent reported but the chain list didn't include (older, or the list was cut short). */
function rowFromEvent(e) {
  return { hash: e.depositTx, ts: Date.parse(e.at), from: e.payer, units: units6Of(e.amount), token: e.token === "USDT" ? "USDT" : "CNGN", agent: e };
}
function payRow(d, tag) {
  const meta = el("span", { class: "meta" }, "From ", el("a", { class: "mono link", href: celoscanAddr(d.from), title: d.from }, short(d.from)), ` · ${watTime(d.ts)}`);
  let end;
  // the agent's own record of this deposit: "paid" / "refused" are final; otherwise a payout found on the chain wins
  const ev = d.agent && (statusFinal(d.agent) || d.status !== "paid") ? d.agent : null;
  if (ev?.status === "paid") {
    const got = paidText(ev);
    end = [el("span", { class: "badge ok" }, el("span", { class: "dot" }), got ? `Paid ${got}` : "Paid"),
      el("a", { class: "link small", href: `receipt.html#${ev.receiptNo}` }, ev.receiptNo, " ", icon("right")),
      el("a", { class: "link small", href: "cash-out.html" }, "Cash out")];
  } else if (ev?.status === "refused") {
    end = [badge("Not paid", "err"), el("span", { class: "micro muted" }, `${reasonText(ev.reason)}. The payer can ask the agent's owner for a refund.`)];
  } else if (ev?.status === "failed") {
    end = [badge("Payout delayed", "warn"), el("span", { class: "micro muted" }, DELAYED_NOTE)];
  } else if (ev?.status === "received" && receivedStale(ev)) {
    end = [badge("Waiting for the agent", "warn"), el("span", { class: "micro muted" }, `${SLOW_NOTE} The agent recorded it but hasn't reported the payout yet.`)];
  } else if (ev?.status === "received") {
    end = [badge("Received · paying now", "warn"), el("span", { class: "micro muted" }, "The agent has it and is paying you")];
  } else if (d.status === "ineligible") {
    const k = d.reason.kind;
    if (k === "self") end = [badge("Not paid: sent from your own wallet", "err")];
    else if (k === "min") end = [badge("Below the minimum: not paid", "err"), el("span", { class: "micro muted" }, d.reason.text)];
    else end = [badge("Above the limit — not paid automatically", "err"), el("span", { class: "micro muted" }, d.reason.text)];
  } else if (d.status === "paid") {
    const no = receiptNo(d.payout.hash);
    end = [el("span", { class: "badge ok" }, el("span", { class: "dot" }), `Paid ${payoutText(d.payout.token, d.payout.units)}`),
      el("a", { class: "link small", href: `receipt.html#${no}` }, no, " ", icon("right")),
      el("a", { class: "link small", href: "cash-out.html" }, "Cash out")];
  } else if (d.status === "maybe") {
    const no = receiptNo(d.payout.hash);
    end = [badge("Possibly paid", "warn"),
      el("span", { class: "micro muted" }, `A payout to @${tag} was sent at ${watTime(d.payout.ts)}; it may be for another payment.`),
      el("a", { class: "link small", href: `receipt.html#${no}` }, no, " ", icon("right"))];
  } else if (Date.now() - d.ts < 48 * 3600_000) end = [badge("Waiting for the agent", "warn"), el("span", { class: "micro muted" }, "Paid when autopilot next runs")];
  else end = [badge("Not paid", "neutral"), el("a", { class: "link micro", href: "autopilot.html" }, "Check autopilot")];
  return el("div", { class: "nt-pay-row" },
    el("div", {}, el("div", { class: "amt" }, amountText(d.units, d.token)), meta, " ", el("a", { class: "link micro", href: celoscanTx(d.hash), "aria-label": "Deposit on Celoscan" }, icon("ext"))),
    el("div", { class: "end" }, ...end));
}
let paySeq = 0;
function renderPayments(s) {
  const my = ++paySeq;
  const tag = A.st ? ntagOf(A.st, s.address) : null;
  const entry = tag ? ownerOf(A.st, tag) : null;
  const body = el("div", { class: "card-b" });
  const head = el("div", { class: "card-h" }, el("h2", { id: "payments-h" }, tag ? el("span", {}, "Payments to ", el("span", { class: "np-tagname", style: "font-size:17px" }, "@" + tag)) : "Payments to your tag"));
  paySlot.replaceChildren(el("section", { class: "card", "aria-labelledby": "payments-h" }, head, body));
  if (!A.st) { body.replaceChildren(el("p", { class: "small muted" }, "Waiting for the Lokal tag lookup.")); return; }
  if (!tag) {
    body.replaceChildren(el("div", { class: "nt-empty" }, el("span", { class: "nt-empty-icon" }, icon("receipt")),
      el("p", {}, "Claim a tag above and payments to it show up here, with a receipt for each payout.")));
    return;
  }
  const refresh = el("button", { class: "icon-btn sm", type: "button", "aria-label": "Refresh payments", title: "Refresh payments" }, icon("refresh"));
  refresh.addEventListener("click", () => renderPayments(s));
  head.append(refresh);
  body.setAttribute("aria-busy", "true");
  body.replaceChildren(el("p", { class: "small muted", role: "status" }, el("span", { class: "skel", style: "width:14px;height:14px;border-radius:50%;margin-right:8px" }), `Looking for payments to @${tag}…`));
  (async () => {
    if (!A.rate) A.rate = await loadRate().catch(() => null);
    // the chain list (as before) and the agent's own records (exact statuses), side by side
    const [ledger, agent] = await Promise.all([
      loadTagLedger({ tag, owner: s.address, sinceSec: entry.since, rate: A.rate }).catch((error) => ({ error })),
      agentStatus({ tag }),
    ]);
    if (ledger.error && !agent) throw ledger.error;
    // this tag's deposits since the claim: paid to this wallet, or not paid to anyone (refused)
    const events = (agent?.events ?? []).filter((e) => e.kind === "ntag" && e.tag === tag && e.depositTx
      && (e.recipient ? sameAddr(e.recipient, s.address) : Date.parse(e.at) >= entry.since * 1000));
    // matched by the full "<tx>:<logIndex>" id, so two transfers in one transaction never swap statuses
    const idOf = (d) => `${String(d.hash).toLowerCase()}:${Number(d.logIndex)}`;
    const byId = new Map(events.map((e) => [e.id, e]));
    const deposits = (ledger.error ? [] : ledger.deposits).map((d) => ({ ...d, agent: byId.get(idOf(d)) ?? null }));
    const listed = new Set(deposits.map(idOf));
    for (const e of events) if (!listed.has(e.id)) deposits.push(rowFromEvent(e));
    deposits.sort((a, b) => b.ts - a.ts);
    return { deposits, partial: Boolean(ledger.error || ledger.partial), fromAgent: Boolean(agent), chainFailed: Boolean(ledger.error) };
  })().then(({ deposits, partial, fromAgent, chainFailed }) => {
    if (my !== paySeq) return;
    body.removeAttribute("aria-busy");
    if (!deposits.length) {
      body.replaceChildren(el("div", { class: "nt-empty" }, el("span", { class: "nt-empty-icon" }, icon("wallet")),
        el("p", {}, `No payments to @${tag} yet. Share your link; each payment shows up here a few seconds after it lands.`),
        el("button", { class: "btn btn-secondary btn-sm", type: "button", dataset: { copy: ntagUrl(tag), copyLabel: "Link copied" } }, icon("copy"), "Copy your link")));
      return;
    }
    const where = chainFailed ? "Payments the agent reported; Blockscout couldn't be reached for the full list."
      : partial ? "Your most recent payments, read from Blockscout. Older ones may not be listed." : "Payments since you claimed the tag, read from Blockscout.";
    body.replaceChildren(...deposits.map((d) => payRow(d, tag)),
      el("p", { class: "micro muted mt-16" }, where,
        ` Statuses: ${fromAgent ? STATUS_SOURCE.agent : STATUS_SOURCE.chain}.`,
        ` Limits: ${LIMITS_TEXT}. `, REFUSED_NOTE));
  }).catch(() => {
    if (my !== paySeq) return;
    body.removeAttribute("aria-busy");
    const retry = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, icon("refresh"), "Try again");
    retry.addEventListener("click", () => renderPayments(s));
    body.replaceChildren(alertBox("err", "alert", el("p", {}, "Couldn't load payments from Blockscout right now."), el("div", { class: "row mt-8" }, retry)));
  });
}

// ---------- page ----------
async function render() {
  const s = getSession();
  const key = s ? s.address.toLowerCase() : null;
  if (A.busy) { if (key !== A.rendered) A.rerender = true; return; } // rebuild once the transaction is done
  if (key === A.rendered) return; // same account: keep what's on screen (and any running animation)
  const first = A.rendered === undefined;
  const focusWasInside = root.contains(document.activeElement);
  A.rendered = key;
  if (!s) {
    A.view = null;
    root.replaceChildren(guide("signin", null, null));
    if (!first && focusWasInside) focusHeading($("#claim-h"));
    return;
  }
  A.view = null;
  tagSlot.replaceChildren(tagSkeleton());
  root.replaceChildren(tagSlot, el("div", { class: "grid-main" }, paySlot, walletSlot));
  renderWallet(s);
  renderPayments(s);
  await loadState(false);
  if (A.rendered !== key) return;
  A.interacted = !first; // signed in just now on this page: the guide's focus follows the steps
  renderTag(s);
  renderPayments(s);
  if (!first && (focusWasInside || document.activeElement === document.body)) focusHeading($("#claim-h") ?? $("#tag-h"));
  if (first && prefill && !A.opsErr && !ntagOf(A.st, s.address)) $("#claim-name")?.focus({ preventScroll: false });
}

onSessionChange(() => { render(); });
watchSession();
render();
