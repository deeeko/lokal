// The sign-up gateway (start.html): Connect → Sign in → Your tag → Your name → Welcome. Signing up and signing in are
// the same flow, because the wallet is the account (no email, no password). Each step does one thing:
//   Connect   eth_requestAccounts: the wallet shares its address. Nothing is signed or sent.
//   Sign in   the existing free sign-in (session.js signIn: personal_sign of a short message). Nothing is sent.
//   Your tag  choose a @tag; the LokalTags contract answers as you type (free, taken, reserved, on hold, invalid).
//   Your name an optional display name, then ONE claim(tag, name) transaction to LokalTags, simulated first, so the
//             name never costs a second transaction. The tag is read back from the contract before "Welcome".
//   Welcome   your card, your link, "Add <token> to your wallet" and what to do next.
// No currency is asked for: payers choose what you receive on each payment; a default is optional, in Settings.
// Someone already signed in starts at the first step that isn't done (front-door.js gatewayStep).
import { $, $$, el, icon, short, initChrome, toast, ntagUrl, ntagError, ntagNameError, resolveNtags, celoscanTx } from "../assets/core.js";
import { getSession, signIn, onSessionChange, watchSession, injectedWallet, ensureCelo, explainWalletError, rememberNtag, avatar } from "../assets/session.js";
import { LOKAL_TAGS, claimData, simulate, readAvailability, readTagInfo, readTagOf } from "../assets/lokal-contracts.js";
import {
  ntagCard, stage, revealCard, shareBlock, alertBox, availabilityMessage, ntagRules, cleanTagInput, suggestNtags, waitForReceipt,
  plainError, sameAddr, sleep, noWalletHelp, noCeloAlert, celoBalance, slowNotice,
} from "../assets/ntag-ui.js";
import { addToWalletRow } from "../assets/wallet-assets.js";
import { gatewayStep, GATEWAY_STEPS } from "../assets/front-door.js";

initChrome();

const root = $("#gw-root");
const G = { step: null, account: null, tag: undefined, pick: "", name: "", agree: false, busy: false, hash: null, claimed: null };
const errText = (e) => (e?.plain || e?.code === "NO_WALLET" ? e.message : explainWalletError(e));
const prefill = (() => { const m = location.hash.match(/(?:^#|&)tag=([^&]+)/); try { return m ? cleanTagInput(decodeURIComponent(m[1])) : ""; } catch { return ""; } })();
if (prefill) G.pick = prefill;

function progress(step) {
  const at = GATEWAY_STEPS.findIndex((s) => s.id === step);
  for (const li of $$("#gw-progress li")) {
    const i = GATEWAY_STEPS.findIndex((s) => s.id === li.dataset.step);
    const state = step === "welcome" || i < at ? "done" : i === at ? "current" : "todo";
    li.dataset.state = state;
    if (state === "current") li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
  }
}

/** One step: "Step 2 of 4", a title, a lead and the body. Focus moves to the title so screen readers hear the change. */
function screen(step, title, lead, ...body) {
  G.step = step;
  progress(step);
  const n = GATEWAY_STEPS.findIndex((s) => s.id === step);
  const h = el("h1", { class: "gw-title", tabindex: "-1" }, ...[].concat(title));
  const node = el("section", { class: "gw-step", "aria-labelledby": "gw-h" },
    n >= 0 ? el("p", { class: "gw-count" }, `Step ${n + 1} of ${GATEWAY_STEPS.length}`) : el("p", { class: "gw-count" }, "All set"),
    h, lead ? el("p", { class: "gw-lead" }, lead) : null, el("div", { class: "gw-body" }, ...body));
  h.id = "gw-h";
  root.replaceChildren(node);
  if (document.activeElement !== document.body || G.focus) h.focus({ preventScroll: true });
  G.focus = true;
  window.scrollTo(0, 0);
}
const fact = (text) => el("li", {}, icon("check"), el("span", {}, text));

// ---------- 1. connect ----------
function connectStep() {
  const eth = injectedWallet();
  const msg = el("div", { "aria-live": "polite" });
  const parts = [el("ul", { class: "gw-facts" },
    fact("Your wallet is your account: no email, no password."),
    fact("Connecting only shares your wallet address. Nothing is signed or sent."),
    fact("MetaMask, MiniPay or another Celo wallet."))];
  if (!eth) parts.push(noWalletHelp({ action: "get started" }));
  else {
    const b = el("button", { class: "btn btn-primary btn-lg", type: "button" }, icon("wallet"), el("span", {}, "Connect wallet"));
    b.addEventListener("click", async () => {
      b.disabled = true; b.lastChild.textContent = "Check your wallet…"; msg.replaceChildren();
      try {
        const accs = await eth.request({ method: "eth_requestAccounts" });
        if (!/^0x[0-9a-fA-F]{40}$/.test(String(accs?.[0]))) throw plainError("The wallet returned no account. Unlock it and try again.");
        G.account = accs[0];
        signStep();
      } catch (e) {
        b.disabled = false; b.lastChild.textContent = "Connect wallet";
        msg.replaceChildren(alertBox("err", "alert", el("p", {}, errText(e))));
      }
    });
    parts.push(el("div", { class: "gw-actions" }, b, el("a", { class: "text-link", href: "quote.html" }, "Only paying someone? No account needed ", el("span", { class: "arrow", "aria-hidden": "true" }, "→"))));
  }
  parts.push(msg);
  screen("connect", ["Connect your ", el("em", {}, "wallet"), "."], "Get paid at your own @tag, in your own money. It takes about a minute.", ...parts);
}

// ---------- 2. sign in ----------
function signStep() {
  const eth = injectedWallet();
  const msg = el("div", { "aria-live": "polite" });
  const b = el("button", { class: "btn btn-primary btn-lg", type: "button" }, el("span", {}, "Sign in"));
  b.addEventListener("click", async () => {
    b.disabled = true; b.firstChild.textContent = "Check your wallet…"; msg.replaceChildren();
    try {
      const s = await signIn(eth);
      G.account = s.address;
      toast("Signed in");
      await afterSignIn(s);
    } catch (e) {
      b.disabled = false; b.firstChild.textContent = "Sign in";
      msg.replaceChildren(alertBox("err", "alert", el("p", {}, errText(e))));
    }
  });
  screen("sign", ["Sign in to ", el("em", {}, "Lokal"), "."], "Your wallet shows a short message to sign. It proves this wallet is yours.",
    el("div", { class: "gw-who" }, avatar(G.account, "lg"), el("div", {}, el("span", { class: "mono", title: G.account }, short(G.account)), el("small", {}, "Connected on Celo"))),
    el("ul", { class: "gw-facts" }, fact("Free: no gas, no transaction, nothing sent."), fact("The message names this site and expires in 7 days."), fact("No approval and no spending permission is asked for.")),
    el("div", { class: "gw-actions" }, b), msg);
}

/** After sign-in: a wallet that already holds a tag goes straight to Welcome. */
async function afterSignIn(s) {
  root.replaceChildren(el("p", { class: "small muted", role: "status" }, el("span", { class: "skel" }), " Checking for your Lokal tag on Celo…"));
  try { G.tag = await readTagOf(s.address); } catch { G.tag = null; }
  if (G.tag) { G.claimed = { tag: G.tag, name: (await readTagInfo(G.tag).catch(() => ({}))).name || "", fresh: false }; welcomeStep(); }
  else tagStep();
}

// ---------- 3. your tag ----------
const AVAIL = { free: "Available", yours: "Yours", taken: "Taken", reserved: "Reserved", locked: "On hold", invalid: "Invalid", checking: "Checking", idle: "" };
function tagStep() {
  const addr = getSession()?.address;
  if (!addr) return connectStep();
  const input = el("input", { id: "gw-tag", type: "text", value: G.pick, placeholder: "yourname", autocomplete: "off", autocapitalize: "none", spellcheck: "false", maxlength: "21", enterkeyhint: "next", "aria-describedby": "gw-tag-msg gw-tag-rules" });
  const pillText = el("span", { class: "nt-avail-text" });
  const pill = el("span", { class: "nt-avail", dataset: { state: "idle" }, "aria-hidden": "true" }, el("span", { class: "nt-avail-dot" }, icon("check")), pillText);
  const box = el("div", { class: "nt-taginput", dataset: { state: "idle" } }, el("span", { class: "nt-at", "aria-hidden": "true" }, "@"), input, pill);
  const ruleEls = ntagRules("").map((r) => el("li", { dataset: { rule: r.id } }, r.label));
  const msg = el("p", { class: "nt-msg", id: "gw-tag-msg", role: "status", "aria-live": "polite" });
  const sugg = el("div", { class: "nt-suggest" });
  const next = el("button", { class: "btn btn-primary btn-lg", type: "button", disabled: true }, "Continue");
  const card = ntagCard({ tag: G.pick, address: addr, kind: "preview" });
  let kind = "idle", timer = null, seq = 0;
  const setPill = (k) => { kind = k; pill.dataset.state = k; box.dataset.state = k; pillText.textContent = AVAIL[k] ?? ""; next.disabled = k !== "free"; };
  const suggest = async (t) => {
    sugg.replaceChildren();
    const cands = suggestNtags(t, "", resolveNtags([]), addr, 8);
    const kinds = await Promise.all(cands.map((c) => readAvailability(c, addr).catch(() => "error")));
    const picks = cands.filter((c, i) => kinds[i] === "free").slice(0, 3);
    if (!picks.length || G.pick !== t) return;
    sugg.append(el("span", { class: "nt-suggest-label" }, "Free right now:"));
    for (const p of picks) {
      const c = el("button", { class: "nt-chip", type: "button", "aria-label": `Use @${p}` }, el("span", { class: "ntag-at" }, "@"), p);
      c.addEventListener("click", () => { input.value = p; onInput(); input.focus(); });
      sugg.append(c);
    }
  };
  const evaluate = async () => {
    const t = G.pick, my = ++seq;
    if (!t) { setPill("idle"); msg.textContent = ""; sugg.replaceChildren(); return; }
    const local = ntagError(t);
    let k;
    try { k = local && !/reserved/.test(local) ? "invalid" : await readAvailability(t, addr); }
    catch { if (my === seq) { setPill("idle"); msg.textContent = "Couldn't reach Celo to check this tag. Try again in a moment."; } return; }
    if (my !== seq) return;
    let lock = null;
    if (k === "locked") lock = { until: (await readTagInfo(t).catch(() => ({}))).lockedUntil };
    setPill(k);
    msg.textContent = k === "taken" ? `@${t} is taken. Pick another.` : availabilityMessage(t, k, { lock }).text;
    if (k === "taken" || k === "locked" || k === "reserved") suggest(t); else sugg.replaceChildren();
  };
  const onInput = () => {
    const clean = cleanTagInput(input.value);
    if (clean !== input.value) input.value = clean;
    G.pick = clean;
    card.update({ tag: clean });
    ntagRules(clean).forEach((r, i) => { ruleEls[i].classList.toggle("ok", r.ok === true); ruleEls[i].classList.toggle("bad", r.ok === false); });
    clearTimeout(timer);
    next.disabled = true;
    if (!clean) { evaluate(); return; }
    setPill("checking");
    timer = setTimeout(evaluate, 250);
  };
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !next.disabled) next.click(); });
  next.addEventListener("click", () => { if (kind === "free") nameStep(); });
  screen("tag", ["Choose your ", el("em", {}, "@tag"), "."], "This is how people find and pay you. Lowercase letters, numbers and _, 3 to 20 characters.",
    el("div", { class: "gw-preview" }, stage(card)),
    el("label", { class: "sr-only", for: "gw-tag" }, "Your Lokal tag"), box, msg, sugg,
    el("ul", { class: "nt-rules", id: "gw-tag-rules", "aria-label": "Tag rules" }, ruleEls),
    el("div", { class: "gw-actions" }, next, el("a", { class: "text-link", href: "app.html" }, "Skip for now ", el("span", { class: "arrow", "aria-hidden": "true" }, "→"))));
  setTimeout(() => { onInput(); input.focus({ preventScroll: true }); }, 0);
}

// ---------- 4. your name, then the one claim transaction ----------
function nameStep() {
  const addr = getSession()?.address;
  if (!addr) return connectStep();
  const t = G.pick;
  const card = ntagCard({ tag: t, name: G.name, address: addr, kind: "preview" });
  const nameIn = el("input", { class: "input", id: "gw-name", type: "text", value: G.name, maxlength: "40", autocomplete: "name", placeholder: "Ada Obi", "aria-describedby": "gw-name-hint" });
  const hint = el("p", { class: "hint", id: "gw-name-hint" }, "Optional. Shown on your card and pay page, up to 40 characters.");
  const agree = el("input", { type: "checkbox", id: "gw-agree" });
  agree.checked = G.agree;
  const go = el("button", { class: "btn btn-primary btn-lg", type: "button", disabled: true }, `Claim @${t}`);
  const back = el("button", { class: "text-link gw-skip", type: "button" }, el("span", { class: "arrow", "aria-hidden": "true", style: "transform:scaleX(-1)" }, "→"), " Change tag");
  const out = el("div", { "aria-live": "polite" });
  const steps = el("ol", { class: "nt-progress", hidden: true });
  const row = (id, title, sub) => { const li = el("li", { dataset: { id } }, el("span", { class: "nt-p-icon", "aria-hidden": "true" }), el("div", {}, el("b", {}, title), el("small", {}, sub ?? ""))); steps.append(li); return li; };
  const rows = { wallet: row("wallet", "Confirm in your wallet", "One call to the LokalTags contract. It sends 0 CELO; you pay only the network fee."), chain: row("chain", "Celo confirms it", ""), yours: row("yours", `@${t} is yours`, "Read back from the contract.") };
  const mark = (id, state, sub) => {
    const li = rows[id];
    li.className = state ?? "";
    li.firstChild.replaceChildren(...(state === "done" ? [icon("check")] : state === "err" ? [icon("x")] : []));
    if (sub !== undefined) li.querySelector("small").replaceChildren(...[].concat(sub));
  };
  const problem = () => (nameIn.value.trim() && ntagNameError(nameIn.value) ? `The ${ntagNameError(nameIn.value)}.` : null);
  const refresh = () => {
    G.name = nameIn.value.trim();
    card.update({ name: nameIn.value });
    const p = problem();
    hint.classList.toggle("err", Boolean(p));
    hint.textContent = p ?? "Optional. Shown on your card and pay page, up to 40 characters.";
    go.disabled = G.busy || Boolean(p) || !agree.checked;
  };
  nameIn.addEventListener("input", refresh);
  agree.addEventListener("change", () => { G.agree = agree.checked; refresh(); });
  back.addEventListener("click", () => { if (!G.busy) tagStep(); });
  let celoAnyway = false;
  const lock = (on) => { G.busy = on; nameIn.disabled = on; agree.disabled = on; back.disabled = on; refresh(); };
  go.addEventListener("click", async () => {
    if (G.busy) return;
    lock(true);
    out.replaceChildren();
    go.textContent = `Checking @${t}…`;
    try {
      // right before the wallet opens: ask the contract again, and check there is CELO for the fee
      const k = await readAvailability(t, addr).catch(() => { throw plainError("Couldn't reach Celo to re-check the tag, so nothing was sent. Try again in a moment."); });
      if (k !== "free") { lock(false); go.textContent = `Claim @${t}`; G.pick = t; out.replaceChildren(alertBox("err", "alert", el("p", {}, `${availabilityMessage(t, k).text} Nothing was sent. Go back and pick another.`))); return; }
      if (!celoAnyway && (await celoBalance(addr)) === 0n) {
        lock(false); go.textContent = `Claim @${t}`;
        out.replaceChildren(noCeloAlert(() => { celoAnyway = true; out.replaceChildren(); go.click(); }, "Claim anyway"));
        return;
      }
      steps.hidden = false;
      mark("wallet", "active");
      go.textContent = "Check your wallet…";
      const eth = injectedWallet();
      if (!eth) throw plainError("No wallet found in this browser. Open this page in your wallet's browser to continue.");
      const accs = await eth.request({ method: "eth_requestAccounts" });
      if (!sameAddr(accs?.[0], addr)) throw plainError(`Your wallet is on ${accs?.[0] ? short(accs[0]) : "no account"}, but you signed in as ${short(addr)}. Switch back to that account. Nothing was sent.`);
      await ensureCelo(eth);
      const data = claimData(t, G.name);
      const sim = await simulate({ from: addr, to: LOKAL_TAGS, data }, { tag: t });
      if (!sim.ok) throw plainError(`${sim.message} Nothing was sent.`);
      const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from: addr, to: LOKAL_TAGS, value: "0x0", data }] });
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash))) throw plainError("The wallet didn't return a transaction id. Check your wallet's activity before trying again.");
      G.hash = hash;
      mark("wallet", "done", ["Sent. ", el("a", { class: "link", href: celoscanTx(hash) }, "View on Celoscan ", icon("ext"))]);
      mark("chain", "active", "Usually a few seconds.");
      go.textContent = `Claiming @${t}…`;
      const stop = slowNotice(rows.chain.querySelector("small"), hash);
      let rc;
      try { rc = await waitForReceipt(hash, { failMessage: "The contract refused the claim on Celo (someone may have claimed the tag a moment before you), so nothing changed. Only the network fee was spent." }); }
      finally { stop(); }
      if (!rc) throw plainError("Celo hasn't confirmed it after three minutes. It may still go through; reload this page in a moment.");
      mark("chain", "done", "Confirmed.");
      mark("yours", "active");
      let now = null;
      for (let i = 0; i < 5 && now !== t; i++) { now = await readTagOf(addr).catch(() => null); if (now !== t) await sleep(2000); }
      if (now !== t) throw plainError("Celo confirmed it, but the contract doesn't show the tag yet. Reload in a moment.");
      mark("yours", "done");
      rememberNtag(addr, t, G.name || null);
      G.busy = false;
      G.tag = t;
      G.claimed = { tag: t, name: G.name, fresh: true };
      setTimeout(welcomeStep, 400);
    } catch (e) {
      lock(false);
      go.textContent = `Claim @${t}`;
      for (const id of Object.keys(rows)) if (rows[id].classList.contains("active")) mark(id, "err");
      out.replaceChildren(alertBox("err", "alert", el("p", {}, errText(e))));
    }
  });
  screen("name", ["Add your ", el("em", {}, "name"), "."], `Then claim @${t}. A name is optional; you can change it later.`,
    el("div", { class: "gw-preview" }, stage(card)),
    el("label", { class: "label", for: "gw-name" }, "Display name (optional)"), nameIn, hint,
    alertBox("", "lock", el("p", {}, el("b", {}, "Public and permanent. "), "Your tag, name and wallet address are written to the LokalTags contract on Celo, where anyone can read them. You can release the tag later, but the record stays.")),
    el("label", { class: "toggle", for: "gw-agree" }, agree, "I understand my tag, name and wallet are public."),
    el("div", { class: "gw-actions" }, go, back), steps, out);
  refresh();
  setTimeout(() => nameIn.focus({ preventScroll: true }), 0);
}

// ---------- welcome ----------
function welcomeStep() {
  const addr = getSession()?.address;
  const { tag, name, fresh } = G.claimed ?? { tag: G.tag, name: "" };
  const card = ntagCard({ tag, name, address: addr, since: Math.floor(Date.now() / 1000), as: "button", label: `Your Lokal tag @${tag}. Copy the link to your pay page` });
  card.dataset.copy = ntagUrl(tag);
  card.dataset.copyLabel = "Link copied";
  screen("welcome", ["Welcome, ", el("em", {}, "@" + tag), "."], fresh ? "Your tag is yours. Share your link: people pay you in dollars and choose what you receive, and the agent pays this wallet." : "You already hold this tag. Here is your link, and what to do next.",
    el("div", { class: "gw-welcome" }, stage(card, "Tap the card to copy your link.")),
    shareBlock(tag),
    el("div", { class: "stack", style: "gap:10px" },
      el("h2", { class: "label" }, "See your money in your wallet"),
      el("p", { class: "small soft" }, "Add the tokens you can receive to your wallet's list. Your wallet asks you to confirm; nothing is sent."),
      addToWalletRow({ compact: true })),
    el("ul", { class: "gw-next" },
      el("li", {}, el("div", {}, el("b", {}, "Your dashboard"), el("p", {}, "Money received, your payments, links and settings.")), el("a", { class: "btn btn-primary", href: "app.html" }, "Open dashboard")),
      el("li", {}, el("div", {}, el("b", {}, "A default currency"), el("p", {}, "Optional. What your pay page shows first; payers can still choose.")), el("a", { class: "text-link", href: "app.html#settings" }, "Settings ", el("span", { class: "arrow", "aria-hidden": "true" }, "→"))),
      el("li", {}, el("div", {}, el("b", {}, "A payment link"), el("p", {}, "Ask for an exact amount with a link you share.")), el("a", { class: "text-link", href: "get-paid.html" }, "Get paid ", el("span", { class: "arrow", "aria-hidden": "true" }, "→"))),
      el("li", {}, el("div", {}, el("b", {}, "Cash out"), el("p", {}, "How to get each currency to a bank.")), el("a", { class: "text-link", href: "cash-out.html" }, "Read the guide ", el("span", { class: "arrow", "aria-hidden": "true" }, "→")))));
  if (fresh) requestAnimationFrame(() => revealCard(card, "Claimed"));
}

// ---------- start ----------
async function begin() {
  const s = getSession();
  const eth = injectedWallet();
  let account = null;
  if (eth?.request) { try { account = (await eth.request({ method: "eth_accounts" }))?.[0] ?? null; } catch { account = null; } }
  G.account = account ?? s?.address ?? null;
  const step = gatewayStep({ session: s, account, tag: s ? undefined : null });
  if (step === "connect") return connectStep();
  if (step === "sign") return signStep();
  return afterSignIn(s);
}
onSessionChange((s) => {
  if (G.busy) return;
  if (!s && (G.step === "tag" || G.step === "name" || G.step === "welcome")) { G.tag = undefined; begin(); }
});
watchSession();
begin();
