// The dashboard (app.html): the signed-in wallet's own Lokal, built in the browser from Celo. Nothing here is stored
// on a server. Your tag and how to share it, the money you received, your recent payments (only yours: the same
// "Yours" rows as Activity), your payment links, "Add <token> to your wallet", and settings (display name, default
// currency, release) as LokalTags calls from your own wallet, each simulated before the wallet opens.
//
// Signed out, it shows a sign-in panel and never redirects: the landing sends signed-in visitors here, so a redirect
// back could bounce between the two (for example when the wallet is locked and reports no account).
import {
  $, el, icon, badge, short, initChrome, toast, ntagUrl, loadRate, currencyOf, formatCurrency, celoscanTx, lagosTime,
  receiptNo, loadRegistrations, registrationStatuses, CORRIDORS, ntagNameError, RELEASE_LOCK_DAYS, num2,
} from "../assets/core.js";
import { getSession, onSessionChange, watchSession, injectedWallet, ensureCelo, rememberNtag, lookupNtag, explainWalletError } from "../assets/session.js";
import {
  LOKAL_TAGS, LOKAL_POTS, readTagOf, readTagInfo, setNameData, setReceiveTokenData, releaseData, simulate, tokenOfCode,
  createPotData, closePotData, decodePotCreated, readPotInfo, readPotLimits,
} from "../assets/lokal-contracts.js";
import {
  potTitleError, cleanTitle, titleRoom, parseUsd6, usd6Text, capsError, CLOSE_PRESETS, closesAtFor, closeTimeError, closeText,
  potState, potUrl, loadHostPots, latestBlock,
} from "../assets/pots.js";
import { potMeter, potBadge, potShare } from "../assets/pot-ui.js";
import { ntagCard, stage, shareBlock, contractEntry, greeting, alertBox, plainError, waitForReceipt, sameAddr } from "../assets/ntag-ui.js";
import { currencyPicker, flagIcon } from "../assets/currency-ui.js";
import { sharedActivity, receivedTotals } from "../assets/my-activity.js";
import { addToWalletRow } from "../assets/wallet-assets.js";
import { wireDisclosure, chevron, receiveName } from "../assets/disclose.js";
import { dashboardView, potsView, canClosePot } from "../assets/front-door.js";

initChrome();

const root = $("#dash-root");
const D = { rendered: undefined, tag: undefined, entry: null, legacyTag: null, busy: false, rate: null, activity: null, note: null };
const isHash = (h) => /^0x[0-9a-fA-F]{64}$/.test(String(h));
const errText = (e) => (e?.plain ? e.message : explainWalletError(e));
const section = (id, title, ...body) => el("section", { class: "card dash-card", id, "aria-labelledby": `${id}-h` },
  el("div", { class: "card-h" }, el("h2", { id: `${id}-h` }, title)), ...body);
const linkRow = (href, text) => el("a", { class: "text-link small", href }, text, " ", el("span", { class: "arrow", "aria-hidden": "true" }, "→"));

function setHead(view, tag) {
  const title = $("#dash-title");
  const eyebrow = $("#dash-eyebrow");
  if (view === "tag") {
    eyebrow.textContent = greeting();
    title.replaceChildren("Hello, ", el("em", {}, "@" + tag));
  } else if (view === "no-tag" || view === "loading") {
    eyebrow.textContent = greeting();
    title.replaceChildren("Welcome to ", el("em", {}, "Lokal"));
  } else {
    eyebrow.textContent = "Dashboard";
    title.replaceChildren("Your ", el("em", {}, "Lokal"));
  }
}

// ---------- signed out ----------
function signedOutPanel() {
  return el("section", { class: "card gate-card", "aria-labelledby": "so-h" },
    el("div", { class: "card-b gate-body" },
      el("span", { class: "gate-icon", "aria-hidden": "true" }, icon("lock")),
      el("div", {},
        el("h2", { id: "so-h" }, "Sign in to see your dashboard"),
        el("p", { class: "soft mt-8" }, "Your dashboard shows your Lokal tag, the money you receive and your payment links. Your wallet is your account: no email, no password. If you were signed in, your wallet may be locked or on another account."),
        el("div", { class: "row mt-16" },
          el("a", { class: "btn btn-primary", href: "start.html" }, "Sign in with your wallet"),
          linkRow("index.html?about", "About Lokal")))));
}

// ---------- your tag ----------
function heroSection(s) {
  if (!D.tag) {
    const card = ntagCard({ kind: "ghost", address: s.address, tilt: false });
    return el("section", { class: "dash-hero", "aria-labelledby": "hero-h" },
      stage(card),
      el("div", { class: "dash-hero-copy" },
        el("h2", { id: "hero-h", class: "dash-h2" }, "Claim your Lokal tag"),
        el("p", { class: "soft" }, "A tag like @ada is how people pay you: they send dollars and choose what you receive, and the agent pays this wallet. One wallet, one tag. It takes one transaction and a fee well under a cent."),
        D.legacyTag ? alertBox("", "info", el("p", {}, `You hold @${D.legacyTag} from the older memo system. Claim it again to keep it on the LokalTags contract.`)) : null,
        el("div", { class: "row" }, el("a", { class: "btn btn-primary", href: "start.html" }, "Claim your tag"), linkRow("get-paid.html", "Or make a payment link"))));
  }
  const tag = D.tag;
  const card = ntagCard({ tag, name: D.entry?.name, address: s.address, since: D.entry?.since, currency: D.entry?.currency, as: "button", label: `Your Lokal tag @${tag}. Copy the link to your pay page` });
  card.dataset.copy = ntagUrl(tag);
  card.dataset.copyLabel = "Link copied";
  return el("section", { class: "dash-hero", "aria-labelledby": "hero-h" },
    stage(card, "Tap the card to copy your link."),
    el("div", { class: "dash-hero-copy" },
      el("h2", { id: "hero-h", class: "dash-h2" }, "People pay you at ", el("span", { class: "np-tagname" }, "@" + tag)),
      el("p", { class: "soft" }, "Payers send dollars and choose what you receive; the agent pays this wallet."),
      shareBlock(tag),
      el("div", { class: "dash-actions" },
        el("a", { class: "btn btn-secondary btn-sm", href: "get-paid.html" }, icon("link"), "Create a payment link"),
        el("a", { class: "btn btn-secondary btn-sm", href: "quote.html" }, icon("quote"), "Send money"),
        el("button", { class: "btn btn-secondary btn-sm", type: "button", dataset: { openPot: "" } }, icon("bolt"), "Open a pot"),
        linkRow("account.html", "Payments to your tag, with statuses"))));
}

// ---------- money received + recent payments (only this wallet's own rows) ----------
function receivedSection() {
  const body = el("div", { class: "card-b", "aria-busy": "true" }, el("span", { class: "skel lg" }));
  const sec = section("received", "Money received", body,
    el("div", { class: "card-f" }, el("span", { class: "micro muted" }, "Payouts the agent sent to this wallet, read from Celo."), linkRow("cash-out.html", "Get it to your bank")));
  sec.fill = (rows, failed) => {
    body.removeAttribute("aria-busy");
    if (failed) { body.replaceChildren(el("p", { class: "small muted" }, "Couldn't read your payouts from Blockscout right now.")); return; }
    const totals = receivedTotals(rows);
    if (!totals.length) {
      body.replaceChildren(el("div", { class: "dash-empty" },
        el("p", { class: "dash-empty-title" }, "Nothing received yet"),
        el("p", { class: "small soft" }, D.tag ? `When someone pays @${D.tag}, the money lands in this wallet and the total shows here.` : "Claim a tag or make a payment link; what you receive shows here.")));
      return;
    }
    body.replaceChildren(el("ul", { class: "dash-totals" }, totals.map((t) => el("li", {},
      el("span", { class: "cur-inline" }, flagIcon(t.code === "usdt" ? "usd" : t.code), t.code === "usdt" ? "Dollars" : currencyOf(t.code).label),
      el("b", { class: "num" }, t.code === "usdt" ? `$${num2.format(Math.floor(t.amount * 100) / 100)}` : formatCurrency(t.amount, t.code)),
      el("span", { class: "micro muted" }, `${t.count} payout${t.count === 1 ? "" : "s"}`)))));
  };
  return sec;
}

function recentSection() {
  const body = el("div", { class: "card-b", "aria-busy": "true" }, el("p", { class: "small muted" }, el("span", { class: "skel" }), " Reading your payments from Celo…"));
  const sec = section("recent", "Recent payments", body, el("div", { class: "card-f" }, el("span", { class: "micro muted" }, "Only your wallet's payments with Lokal."), linkRow("transactions.html", "All your activity")));
  sec.fill = (rows, failed, retry) => {
    body.removeAttribute("aria-busy");
    if (failed) {
      const b = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, icon("refresh"), "Try again");
      b.addEventListener("click", retry);
      body.replaceChildren(alertBox("err", "alert", el("p", {}, "Couldn't load your payments from Blockscout right now."), el("div", { class: "row mt-8" }, b)));
      return;
    }
    if (!rows.length) {
      body.replaceChildren(el("div", { class: "dash-empty" },
        el("p", { class: "dash-empty-title" }, "No payments yet"),
        el("p", { class: "small soft" }, "Payments you send and receive through Lokal show here, each with its transaction and receipt."),
        el("div", { class: "row mt-8" }, linkRow("quote.html", "Send money"))));
      return;
    }
    body.replaceChildren(el("ul", { class: "dash-list" }, rows.slice(0, 6).map((r) => {
      const no = r.kind === "payout" ? receiptNo(r.hash) : null;
      return el("li", {},
        el("div", { class: "dash-list-main" }, el("span", { class: "dash-list-label" }, r.label),
          el("span", { class: "micro muted" }, [r.sub, r.time ? `${lagosTime(r.time)} WAT` : null].filter(Boolean).join(" · "))),
        el("div", { class: "dash-list-end" }, badge(...r.status),
          no ? el("a", { class: "link small mono", href: `receipt.html#${no}` }, no)
            : el("a", { class: "link small", href: celoscanTx(r.hash), "aria-label": "Transaction on Celoscan" }, "Celoscan ", icon("ext"))));
    })));
  };
  return sec;
}

// ---------- your payment links ("Get paid") ----------
function linksSection(s) {
  const body = el("div", { class: "card-b", "aria-busy": "true" }, el("p", { class: "small muted" }, el("span", { class: "skel" }), " Looking for your payment links…"));
  const sec = section("links", "Your payment links", body, el("div", { class: "card-f" }, el("span", { class: "micro muted" }, "Links made from this wallet in the last 8 days."), linkRow("get-paid.html", "Create a payment link")));
  loadRegistrations().then((regs) => {
    const st = registrationStatuses(regs, Math.floor(Date.now() / 1000));
    const mine = regs.filter((r) => sameAddr(r.from, s.address)).sort((a, b) => b.time - a.time);
    body.removeAttribute("aria-busy");
    if (!mine.length) {
      body.replaceChildren(el("div", { class: "dash-empty" }, el("p", { class: "dash-empty-title" }, "No payment links yet"),
        el("p", { class: "small soft" }, "A payment link asks for an exact amount, in the currency you choose. Share it in any chat.")));
      return;
    }
    const LABEL = { active: ["Active", "ok"], "in-use": ["Amount in use", "warn"], expired: ["Expired", "neutral"], invalid: ["Not valid", "err"] };
    body.replaceChildren(el("ul", { class: "dash-list" }, mine.slice(0, 5).map((r) => {
      const c = CORRIDORS[r.req.d];
      const url = new URL(`pay.html#tx=${r.hash}`, location.href).href;
      const what = c.sell === "cNGN" ? `₦${r.req.a} → you get dollars` : `$${r.req.a} → you get ${currencyOf(c.currency)?.plural ?? "naira"}`;
      return el("li", {},
        el("div", { class: "dash-list-main" }, el("span", { class: "dash-list-label" }, what),
          el("span", { class: "micro muted" }, [r.req.m || r.req.n, `until ${lagosTime(r.req.e * 1000)} WAT`].join(" · "))),
        el("div", { class: "dash-list-end" }, badge(...(LABEL[st.get(r.hash)] ?? LABEL.invalid)),
          el("button", { class: "icon-btn sm", type: "button", "aria-label": "Copy payment link", dataset: { copy: url, copyLabel: "Link copied" } }, icon("copy")),
          el("a", { class: "link small", href: url }, "Open")));
    })));
  }).catch(() => {
    body.removeAttribute("aria-busy");
    body.replaceChildren(el("p", { class: "small muted" }, "Couldn't read payment links from Blockscout right now. ", el("a", { class: "link", href: "get-paid.html" }, "Make a new one"), "."));
  });
  return sec;
}

// ---------- add to wallet ----------
function walletSection() {
  return section("wallet", "Add to your wallet",
    el("div", { class: "card-b stack", style: "gap:14px" },
      el("p", { class: "small soft" }, "So the money you receive shows up in your wallet's token list. Your wallet asks you to confirm; nothing is sent and nothing is signed."),
      addToWalletRow({ compact: true }),
      el("p", { class: "micro muted" }, "MiniPay shows only USDT, USDC and USDm, so in MiniPay choose dollars.")));
}

// ---------- settings: display name, default currency, release (LokalTags calls from your own wallet) ----------
/** One contract call from the signed-in wallet: same account, on Celo, simulated first, then sent and confirmed. */
async function sendCall(to, addr, data, ctx, onSent, failMessage, { prepare } = {}) {
  const eth = injectedWallet();
  if (!eth) throw plainError("No wallet found in this browser. Open this page in your wallet's browser to continue.");
  const accs = await eth.request({ method: "eth_requestAccounts" });
  if (!sameAddr(accs?.[0], addr)) throw plainError(`Your wallet is on ${accs?.[0] ? short(accs[0]) : "no account"}, but you're signed in as ${short(addr)}. Switch back to that account. Nothing was sent.`);
  await ensureCelo(eth);
  if (prepare) data = await prepare();
  const sim = await simulate({ from: addr, to, data }, ctx);
  if (!sim.ok) throw plainError(/Nothing was sent\.$/.test(sim.message) ? sim.message : `${sim.message} Nothing was sent.`);
  const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from: addr, to, value: "0x0", data }] });
  if (!isHash(hash)) throw plainError("The wallet didn't return a transaction id. Check your wallet's activity before trying again.");
  onSent?.(hash);
  const rc = await waitForReceipt(hash, { failMessage });
  if (!rc) throw plainError("Celo hasn't confirmed it after a few minutes. It may still go through; reload in a moment.");
  return { hash, receipt: rc };
}
const sendTagCall = (addr, data, ctx, onSent, failMessage) => sendCall(LOKAL_TAGS, addr, data, ctx, onSent, failMessage).then((r) => r.hash);
const sentLine = (hash) => el("p", { class: "small soft" }, "Sent. Waiting for Celo… ", el("a", { class: "link", href: celoscanTx(hash) }, "View on Celoscan ", icon("ext")));

function settingsSection(s) {
  const addr = s.address, tag = D.tag, entry = D.entry ?? {};
  const after = async (msg) => {
    D.busy = false;
    const info = await readTagInfo(tag).catch(() => null);
    if (info) { D.entry = contractEntry(info); rememberNtag(addr, tag, D.entry.name); }
    D.note = msg;
    toast(msg);
    D.rendered = undefined;
    render();
  };

  // display name
  const nameIn = el("input", { class: "input", id: "set-name", type: "text", value: entry.name ?? "", maxlength: "40", autocomplete: "name", placeholder: "Ada Obi", "aria-describedby": "set-name-hint" });
  const nameHint = el("p", { class: "hint", id: "set-name-hint" }, "Public on the LokalTags contract. Up to 40 characters; empty removes it.");
  const nameSave = el("button", { class: "btn btn-secondary btn-sm", type: "button", disabled: true }, "Save name");
  const nameMsg = el("div", { "aria-live": "polite" });
  const nameCheck = () => {
    const v = nameIn.value.trim();
    const bad = v ? ntagNameError(nameIn.value) : null;
    nameHint.classList.toggle("err", Boolean(bad));
    nameHint.textContent = bad ? `The ${bad}.` : "Public on the LokalTags contract. Up to 40 characters; empty removes it.";
    nameSave.disabled = D.busy || Boolean(bad) || v === (entry.name ?? "");
    nameSave.textContent = v ? "Save name" : "Remove name";
  };
  nameIn.addEventListener("input", nameCheck);
  nameSave.addEventListener("click", async () => {
    if (D.busy) return;
    D.busy = true; nameSave.disabled = true; nameSave.textContent = "Check your wallet…"; nameMsg.replaceChildren();
    try {
      await sendTagCall(addr, setNameData(nameIn.value.trim()), { tag }, (h) => nameMsg.replaceChildren(sentLine(h)), "The contract refused the change on Celo, so nothing changed. Only the network fee was spent.");
      await after(nameIn.value.trim() ? "Name saved" : "Name removed");
    } catch (e) { D.busy = false; nameMsg.replaceChildren(alertBox("err", "alert", el("p", {}, errText(e)))); nameCheck(); }
  });
  nameCheck();

  // default currency (optional; payers still choose per payment)
  const saved = entry.receive === "usdt" ? "usd" : entry.receive ?? null;
  const curSave = el("button", { class: "btn btn-secondary btn-sm", type: "button", disabled: true }, "Saved");
  const curMsg = el("div", { "aria-live": "polite" });
  const picker = currencyPicker({ label: "Your default currency", value: saved ?? "cngn", remember: false,
    extra: [{ code: "usd", label: "Dollars", flag: "usd", title: "Dollars (USD₮)" }], onChange: () => curPaint() });
  const curPaint = () => {
    const changed = picker.value !== (saved ?? "") ;
    curSave.disabled = D.busy || !changed || !picker.isAvailable(picker.value);
    curSave.textContent = changed ? "Save default" : "Saved";
    picker.note(saved ? "Payers see this first and can still choose another currency." : "Not set: payers see naira first and can choose any currency.");
  };
  curSave.addEventListener("click", async () => {
    if (D.busy) return;
    const want = picker.value === "usd" ? "usdt" : picker.value;
    D.busy = true; curSave.disabled = true; curSave.textContent = "Check your wallet…"; curMsg.replaceChildren();
    try {
      await sendTagCall(addr, setReceiveTokenData(tokenOfCode(want)), { tag }, (h) => curMsg.replaceChildren(sentLine(h)), "The contract refused the change on Celo, so nothing changed. Only the network fee was spent.");
      await after("Default currency saved");
    } catch (e) { D.busy = false; curMsg.replaceChildren(alertBox("err", "alert", el("p", {}, errText(e)))); curPaint(); }
  });
  loadRate().then((r) => { picker.setAvailability(r.available); curPaint(); }).catch(() => curPaint());
  curPaint();

  // release
  const agree = el("input", { type: "checkbox", id: "rel-agree" });
  const relBtn = el("button", { class: "btn btn-danger btn-sm", type: "button", disabled: true }, `Release @${tag}`);
  const relMsg = el("div", { "aria-live": "polite" });
  agree.addEventListener("change", () => { relBtn.disabled = D.busy || !agree.checked; });
  relBtn.addEventListener("click", async () => {
    if (D.busy || !agree.checked) return;
    D.busy = true; relBtn.disabled = true; agree.disabled = true; relBtn.textContent = "Check your wallet…"; relMsg.replaceChildren();
    try {
      await sendTagCall(addr, releaseData(), { tag }, (h) => relMsg.replaceChildren(sentLine(h)), "The release failed on Celo, so you still have the tag. Only the network fee was spent.");
      D.busy = false;
      rememberNtag(addr, null);
      D.tag = null; D.entry = null;
      D.note = `Released @${tag}. For ${RELEASE_LOCK_DAYS} days only you can claim it back.`;
      toast(`Released @${tag}`);
      D.rendered = undefined;
      render();
    } catch (e) { D.busy = false; agree.disabled = false; relBtn.disabled = !agree.checked; relBtn.textContent = `Release @${tag}`; relMsg.replaceChildren(alertBox("err", "alert", el("p", {}, errText(e)))); }
  });

  // folded: a heading with one button; the three settings open on demand (open at once on app.html#settings)
  const toggle = el("button", { class: "dc-toggle dash-settings-toggle", type: "button", "aria-expanded": "false", "aria-controls": "settings-panel" },
    el("span", { class: "dc-sum" }, el("b", {}, "Settings"), el("span", { class: "micro muted" }, ` · display name, default currency${D.entry?.receive ? ` (${receiveName(D.entry.receive)})` : ""}, release @${tag}`)),
    el("span", { class: "dc-more" }, el("span", { class: "dc-more-text" }, "Show"), chevron()));
  toggle.dataset.closedLabel = "Show"; toggle.dataset.openLabel = "Hide";
  const panel = el("div", { class: "dc-panel", id: "settings-panel", hidden: true });
  const sec = el("section", { class: "card dash-card dash-settings-card", id: "settings", "aria-labelledby": "settings-h" },
    el("h2", { id: "settings-h", class: "dash-settings-h" }, toggle), panel);
  const dc = wireDisclosure(toggle, panel, { onToggle: (open) => { D.settingsOpen = open; } });
  if (D.settingsOpen || location.hash === "#settings") dc.open({ instant: true });
  panel.append(
    el("div", { class: "card-b dash-settings" },
      el("div", { class: "dash-set" },
        el("h3", { class: "label" }, el("label", { for: "set-name" }, "Display name")),
        el("div", { class: "dash-set-row" }, nameIn, nameSave), nameHint, nameMsg),
      el("div", { class: "dash-set" },
        el("h3", { class: "label" }, "Default currency (optional)"),
        el("p", { class: "micro muted" }, "What your pay page shows first. One transaction, only the network fee."),
        picker.el, el("div", { class: "row" }, curSave), curMsg),
      el("details", { class: "dash-set dash-release" },
        el("summary", {}, el("span", { class: "label" }, "Release your tag"), el("span", { class: "micro muted" }, "Give up @" + tag)),
        alertBox("warn", "alert", el("p", {}, `After this the contract refuses payments to @${tag} before any money moves. For ${RELEASE_LOCK_DAYS} days only you can claim it back; after that anyone can.`)),
        el("label", { class: "toggle", for: "rel-agree" }, agree, `I understand payments to @${tag} stop working.`),
        el("div", { class: "row" }, relBtn), relMsg)),
    el("div", { class: "card-f" }, el("span", { class: "micro muted" }, "Your tag, name and default currency are public on the LokalTags contract."), linkRow("account.html", "Switch to another tag")));
  return sec;
}

// ---------- pots: open one, share it, watch it fill, close it (LokalPots calls from your own wallet) ----------
function potsSection(s) {
  const view = potsView(s, D.tag);
  const newBtn = el("button", { class: "btn btn-secondary btn-sm", type: "button", "aria-expanded": "false", "aria-controls": "pot-new" }, icon("bolt"), "New pot");
  const panel = el("div", { class: "pot-new", id: "pot-new", hidden: true });
  const list = el("div", { "aria-live": "polite" });
  const sec = el("section", { class: "card dash-card dash-pots", id: "pots", "aria-labelledby": "pots-h" },
    el("div", { class: "card-h" }, el("div", {}, el("h2", { id: "pots-h" }, "Your pots"),
      el("p", { class: "micro muted pot-sub" }, "One link and QR code for many guests.")),
      view === "host" ? newBtn : null),
    el("div", { class: "card-b stack" }, panel, list),
    el("div", { class: "card-f" }, el("span", { class: "micro muted" }, "Guests need no account."),
      el("a", { class: "text-link small", href: "https://celoscan.io/address/" + LOKAL_POTS }, "LokalPots on Celoscan ", el("span", { class: "arrow", "aria-hidden": "true" }, "→"))));
  if (view !== "host") {
    list.replaceChildren(el("div", { class: "dash-empty" }, el("p", { class: "dash-empty-title" }, "Claim your tag to host a pot"),
      el("p", { class: "small soft" }, "Pots are hosted from a Lokal tag, so the agent knows who to pay."),
      el("div", { class: "row mt-8" }, linkRow("start.html", "Claim your tag"))));
    return sec;
  }
  const toggle = (open) => {
    if (open && panel.hidden) { panel.replaceChildren(createPotForm(s, { onDone: (id) => { loadList(id); }, onCancel: () => toggle(false) })); }
    panel.hidden = !open;
    newBtn.setAttribute("aria-expanded", String(open));
    newBtn.hidden = open;
    if (open) panel.querySelector("input")?.focus();
  };
  newBtn.addEventListener("click", () => toggle(true));
  sec.openNew = () => { toggle(true); sec.scrollIntoView({ behavior: "smooth", block: "start" }); };

  const loadList = async (justOpened = null) => {
    list.setAttribute("aria-busy", "true");
    if (!list.firstChild) list.replaceChildren(el("p", { class: "small muted" }, el("span", { class: "skel" }), " Looking for your pots…"));
    try {
      const found = (await loadHostPots(s.address)).slice(0, 12);
      const pots = (await Promise.all(found.map((p) => readPotInfo(p.potId).then((i) => ({ potId: BigInt(p.potId), ...i })).catch(() => null)))).filter(Boolean);
      if (justOpened != null && !pots.some((p) => p.potId === BigInt(justOpened))) {
        const i = await readPotInfo(justOpened).catch(() => null);
        if (i) pots.unshift({ potId: BigInt(justOpened), ...i });
      }
      list.removeAttribute("aria-busy");
      if (!pots.length) {
        list.replaceChildren(el("div", { class: "dash-empty" }, el("p", { class: "dash-empty-title" }, "No pots yet"),
          el("p", { class: "small soft" }, "Open one for a wedding, a birthday or a group gift.")));
        return;
      }
      list.replaceChildren(el("ul", { class: "pot-rows" }, pots.map((p) => potRow(s, p, () => loadList()))));
    } catch {
      list.removeAttribute("aria-busy");
      const b = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, icon("refresh"), "Try again");
      b.addEventListener("click", () => loadList());
      list.replaceChildren(alertBox("err", "alert", el("p", {}, "Couldn't read your pots from Celo right now."), el("div", { class: "row mt-8" }, b)));
    }
  };
  loadList();
  if (location.hash === "#pots-new") setTimeout(() => sec.openNew(), 300);
  return sec;
}

/** One of the host's pots: progress, state, link and QR, and Close (two steps, simulated first). */
function potRow(s, p, reload) {
  const now = Math.floor(Date.now() / 1000);
  const st = potState(p, now);
  const meter = potMeter(p, { size: "sm" });
  const url = potUrl(p.potId);
  // Share opens Share · Copy link and "Show QR code" (the QR is drawn only when that is opened too)
  const shareId = `pot-share-${p.potId}`;
  const qrBox = el("div", { class: "dc-panel pot-row-share", id: shareId, hidden: true });
  const share = el("button", { class: "btn btn-ghost btn-sm", type: "button", "aria-expanded": "false", "aria-controls": shareId }, icon("link"), "Share");
  wireDisclosure(share, qrBox, { render: (panel) => panel.append(el("div", { class: "dc-inner" }, potShare(p.potId, p.title, { link: false }))) });
  const msg = el("div", { "aria-live": "polite" });
  const end = el("div", { class: "dash-list-end" },
    el("button", { class: "icon-btn sm", type: "button", "aria-label": `Copy the link to ${p.title}`, dataset: { copy: url, copyLabel: "Pot link copied" } }, icon("copy")),
    share,
    el("a", { class: "btn btn-secondary btn-sm", href: url }, "Open"));
  if ((st === "open" || st === "full") && canClosePot(s, p)) {
    const close = el("button", { class: "btn btn-ghost btn-sm pot-close", type: "button" }, "Close pot");
    let armed = false;
    close.addEventListener("click", async () => {
      if (D.busy) return;
      if (!armed) {
        armed = true;
        close.textContent = "Close it now?";
        close.classList.add("is-armed");
        msg.replaceChildren(el("p", { class: "micro muted" }, "Guests can't spray after this, and it can't be reopened. Press again to close it."));
        setTimeout(() => { if (armed && !D.busy) { armed = false; close.textContent = "Close pot"; close.classList.remove("is-armed"); msg.replaceChildren(); } }, 6000);
        return;
      }
      D.busy = true; close.disabled = true; close.textContent = "Check your wallet…";
      try {
        await sendCall(LOKAL_POTS, s.address, closePotData(p.potId), { potId: p.potId }, (h) => msg.replaceChildren(sentLine(h)),
          "The contract refused to close the pot on Celo, so it is still open. Only the network fee was spent.");
        D.busy = false;
        toast("Pot closed");
        reload();
      } catch (e) {
        D.busy = false; armed = false; close.disabled = false; close.textContent = "Close pot"; close.classList.remove("is-armed");
        msg.replaceChildren(alertBox("err", "alert", el("p", {}, errText(e))));
      }
    });
    end.append(close);
  }
  return el("li", { class: "pot-row" },
    el("div", { class: "pot-row-main" },
      el("div", { class: "pot-row-title" }, el("a", { class: "dash-list-label", href: url }, el("bdi", {}, p.title)), potBadge(st)),
      meter.el,
      el("span", { class: "micro muted" }, [`Pot #${p.potId}`, `${p.payerCount} guest${p.payerCount === 1 ? "" : "s"}`, `up to ${usd6Text(p.perPayerCapUsd6)} each`,
        st === "open" || st === "full" ? `closes ${closeText(p.closesAt)}` : st === "closed" ? "closed by you" : `ended ${closeText(p.closesAt)}`].join(" · "))),
    end, qrBox, msg);
}

/** The "New pot" form: title, closing time, the pot's cap and the per-guest cap, within the contract's maxima. */
function createPotForm(s, { onDone, onCancel }) {
  const F = { limits: null, preset: "14d", custom: null, busy: false };
  const titleIn = el("input", { class: "input", id: "pot-title-in", type: "text", maxlength: "60", autocomplete: "off", placeholder: "Ada & Tunde's wedding", "aria-describedby": "pot-title-hint" });
  const titleHint = el("p", { class: "hint", id: "pot-title-hint" });
  const presetBtns = [...CLOSE_PRESETS.map((p) => ({ id: p.id, label: p.label })), { id: "custom", label: "Pick a time" }].map((p) => {
    const b = el("button", { type: "button", "aria-pressed": String(p.id === F.preset), dataset: { id: p.id } }, p.label);
    b.addEventListener("click", () => { F.preset = p.id; for (const x of presetBtns) x.setAttribute("aria-pressed", String(x.dataset.id === p.id)); customWrap.hidden = p.id !== "custom"; if (p.id === "custom") customIn.focus(); paint(); });
    return b;
  });
  const pad = (n) => String(n).padStart(2, "0");
  const localValue = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const customIn = el("input", { class: "input", id: "pot-close-in", type: "datetime-local", "aria-describedby": "pot-close-hint" });
  const customWrap = el("div", { class: "field", hidden: true }, el("label", { class: "label", for: "pot-close-in" }, "Closes at (your time)"), customIn);
  const closeHint = el("p", { class: "hint", id: "pot-close-hint" });
  const capIn = el("input", { id: "pot-cap-in", type: "text", inputmode: "decimal", autocomplete: "off", size: "6", "aria-describedby": "pot-cap-hint" });
  const eachIn = el("input", { id: "pot-each-in", type: "text", inputmode: "decimal", autocomplete: "off", size: "6", "aria-describedby": "pot-each-hint" });
  const capHint = el("p", { class: "hint", id: "pot-cap-hint" }), eachHint = el("p", { class: "hint", id: "pot-each-hint" });
  const summary = el("p", { class: "small soft pot-new-sum" });
  const openBtn = el("button", { class: "btn btn-primary", type: "button", disabled: true }, "Open the pot");
  const cancelBtn = el("button", { class: "btn btn-ghost", type: "button" }, "Cancel");
  const msg = el("div", { "aria-live": "polite" });
  cancelBtn.addEventListener("click", () => { if (!F.busy) onCancel(); });
  let touched = {};
  for (const [k, n] of [["title", titleIn], ["cap", capIn], ["each", eachIn], ["close", customIn]]) {
    n.addEventListener("input", () => { touched[k] = true; paint(); });
    n.addEventListener("blur", () => { touched[k] = true; paint(); });
  }

  /** { title, closeChoice, potCapUsd6, perPayerCapUsd6 } or { errors } (by field). */
  function read() {
    const errors = {};
    const tErr = potTitleError(titleIn.value);
    if (tErr) errors.title = tErr;
    let closeChoice = { preset: F.preset };
    const now = Math.floor(Date.now() / 1000);
    if (F.preset === "custom") {
      const at = customIn.value ? Math.floor(new Date(customIn.value).getTime() / 1000) : NaN;
      const cErr = closeTimeError(at, now);
      if (cErr) errors.close = cErr; else closeChoice = { at };
    }
    const cap = parseUsd6(capIn.value), each = parseUsd6(eachIn.value);
    if (cap.error) errors.cap = cap.error;
    if (each.error) errors.each = each.error;
    if (!cap.error && !each.error && F.limits) {
      const c = capsError({ potCapUsd6: cap.usd6, perPayerCapUsd6: each.usd6 }, F.limits);
      if (c) errors[c.field] = c.message;
    }
    return { errors, title: cleanTitle(titleIn.value), closeChoice, potCapUsd6: cap.usd6, perPayerCapUsd6: each.usd6 };
  }
  function paint() {
    const r = read();
    const set = (hint, key, input, fallback) => {
      const show = r.errors[key] && touched[key];
      hint.classList.toggle("err", Boolean(show));
      hint.textContent = show ? r.errors[key] : fallback;
      input?.setAttribute("aria-invalid", String(Boolean(show)));
    };
    const room = titleRoom(titleIn.value);
    set(titleHint, "title", titleIn, room >= 0 ? `${room} characters left.` : " ");
    set(closeHint, "close", customIn, F.preset === "custom" ? "Between 10 minutes and 14 days from now." : "You can close it sooner.");
    const max = F.limits;
    set(capHint, "cap", capIn, max ? `Up to ${usd6Text(max.maxPotCapUsd6)}, the contract's maximum.` : "Reading the contract's maximum…");
    set(eachHint, "each", eachIn, max ? `$1 to ${usd6Text(max.maxPerPayerCapUsd6)} per guest, the contract's range.` : " ");
    const ok = !Object.keys(r.errors).length && F.limits;
    if (ok) {
      const at = r.closeChoice.at ?? Math.floor(Date.now() / 1000) + CLOSE_PRESETS.find((p) => p.id === F.preset).seconds;
      summary.replaceChildren("Guests spray ", el("b", {}, `$1 to ${usd6Text(r.perPayerCapUsd6)} each`), " until it holds ", el("b", {}, usd6Text(r.potCapUsd6)),
        " or ", el("b", {}, closeText(at)), ".");
    } else summary.textContent = " ";
    openBtn.disabled = F.busy || !ok;
  }
  readPotLimits().then((l) => {
    F.limits = l;
    if (!capIn.value) capIn.value = usd6Text(l.maxPotCapUsd6).slice(1).replace(/,/g, "");
    if (!eachIn.value) eachIn.value = usd6Text(l.maxPerPayerCapUsd6).slice(1).replace(/,/g, "");
    paint();
  }).catch(() => { msg.replaceChildren(alertBox("err", "alert", el("p", {}, "Couldn't read the contract's maximums from Celo. Reload the page in a moment."))); });
  customIn.min = localValue(new Date(Date.now() + 15 * 60_000));
  customIn.max = localValue(new Date(Date.now() + 14 * 86_400_000 - 5 * 60_000));

  openBtn.addEventListener("click", async () => {
    touched = { title: true, cap: true, each: true, close: true };
    const r = read();
    paint();
    if (Object.keys(r.errors).length || F.busy || D.busy) return;
    F.busy = true; D.busy = true; openBtn.disabled = true; cancelBtn.disabled = true; openBtn.textContent = "Check your wallet…"; msg.replaceChildren();
    let closesAt = null;
    try {
      const { receipt } = await sendCall(LOKAL_POTS, s.address, null, { creating: true }, (h) => { openBtn.textContent = "Waiting for Celo…"; msg.replaceChildren(sentLine(h)); },
        "The contract refused the pot on Celo, so nothing was opened. Only the network fee was spent.",
        { prepare: async () => {
          // the closing time is set by the chain's clock, never later than the contract's 14 days
          closesAt = closesAtFor(r.closeChoice, (await latestBlock()).timestamp);
          return createPotData({ title: r.title, closesAt, potCapUsd6: r.potCapUsd6, perPayerCapUsd6: r.perPayerCapUsd6 });
        } });
      const created = (receipt.logs ?? []).map((l) => decodePotCreated(l)).find(Boolean);
      F.busy = false; D.busy = false;
      toast("Pot opened");
      const panel = openBtn.closest(".pot-new");
      if (created) {
        panel.replaceChildren(el("div", { class: "pot-made" },
          el("div", { class: "pot-made-copy" },
            el("span", { class: "eyebrow" }, `Pot #${created.potId} is open`),
            el("h3", { class: "dash-h2" }, el("bdi", {}, created.title)),
            el("p", { class: "soft" }, "Share it with your guests. The QR code is there when you need it.")),
          potShare(created.potId, created.title)));
        onDone(created.potId);
      } else {
        panel.replaceChildren(alertBox("", "check", el("p", {}, "Your pot is open. It shows in the list below in a moment.")));
        onDone(null);
      }
    } catch (e) {
      F.busy = false; D.busy = false; cancelBtn.disabled = false; openBtn.textContent = "Open the pot";
      msg.replaceChildren(alertBox("err", "alert", el("p", {}, errText(e))));
      paint();
    }
  });
  paint();
  return el("div", { class: "pot-form-new stack" },
    el("div", { class: "field" }, el("label", { class: "label", for: "pot-title-in" }, "What's it for?"), titleIn, titleHint),
    el("div", { class: "field" }, el("span", { class: "label", id: "pot-close-l" }, "Closes in"),
      el("div", { class: "segmented pot-closes", role: "group", "aria-labelledby": "pot-close-l" }, presetBtns), customWrap, closeHint),
    el("div", { class: "pot-caps" },
      el("div", { class: "field" }, el("label", { class: "label", for: "pot-cap-in" }, "The pot can hold"), el("div", { class: "money sm" }, el("span", { class: "pot-cur", "aria-hidden": "true" }, "$"), capIn), capHint),
      el("div", { class: "field" }, el("label", { class: "label", for: "pot-each-in" }, "Each guest can spray up to"), el("div", { class: "money sm" }, el("span", { class: "pot-cur", "aria-hidden": "true" }, "$"), eachIn), eachHint)),
    summary,
    el("div", { class: "row" }, openBtn, cancelBtn),
    el("p", { class: "micro muted" }, "One transaction, checked before your wallet opens."),
    msg);
}

// ---------- page ----------
let seq = 0;
async function render() {
  const s = getSession();
  const key = s ? s.address.toLowerCase() : null;
  if (D.busy) return;
  if (key === D.rendered) return;
  D.rendered = key;
  const my = ++seq;
  if (dashboardView(s, undefined) === "signed-out") {
    setHead("signed-out");
    root.replaceChildren(signedOutPanel());
    return;
  }
  setHead("loading");
  root.replaceChildren(el("p", { class: "small muted", role: "status" }, el("span", { class: "skel" }), " Reading your Lokal tag from Celo…"));
  try {
    D.tag = await readTagOf(s.address);
    D.entry = D.tag ? contractEntry(await readTagInfo(D.tag)) : null;
    D.legacyTag = null;
    if (!D.tag) { const l = await lookupNtag(s.address, { force: true }).catch(() => null); D.legacyTag = l?.tag ?? null; }
  } catch {
    if (my !== seq) return;
    const retry = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, icon("refresh"), "Try again");
    retry.addEventListener("click", () => { D.rendered = undefined; render(); });
    root.replaceChildren(alertBox("err", "alert", el("p", {}, "Couldn't reach Celo to read your Lokal tag. Your tag is safe onchain; this page just can't read it right now."), el("div", { class: "row mt-8" }, retry)));
    return;
  }
  if (my !== seq) return;
  const view = dashboardView(s, D.tag);
  setHead(view, D.tag);
  const received = receivedSection();
  const recent = recentSection();
  const note = D.note ? alertBox("", "info", el("p", {}, D.note)) : null;
  D.note = null;
  const pots = potsSection(s);
  const hero = heroSection(s);
  hero.querySelector("[data-open-pot]")?.addEventListener("click", () => pots.openNew?.());
  root.replaceChildren(...[note, hero, pots,
    el("div", { class: "dash-grid" }, received, recent, linksSection(s), walletSection()),
    view === "tag" ? settingsSection(s) : null].filter(Boolean));
  const loadActivity = (force = false) => sharedActivity(s.address, { force }).then(({ rows }) => {
    if (my !== seq) return;
    received.fill(rows, false); recent.fill(rows, false, loadActivity);
  }).catch(() => { if (my !== seq) return; received.fill([], true); recent.fill([], true, loadActivity); });
  loadActivity();
}

onSessionChange(() => render());
watchSession();
render();
