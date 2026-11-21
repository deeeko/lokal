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
import { LOKAL_TAGS, readTagOf, readTagInfo, setNameData, setReceiveTokenData, releaseData, simulate, tokenOfCode } from "../assets/lokal-contracts.js";
import { ntagCard, stage, shareBlock, contractEntry, greeting, alertBox, plainError, waitForReceipt, sameAddr } from "../assets/ntag-ui.js";
import { currencyPicker, flagIcon } from "../assets/currency-ui.js";
import { loadMyActivity, receivedTotals } from "../assets/my-activity.js";
import { addToWalletRow } from "../assets/wallet-assets.js";
import { dashboardView } from "../assets/front-door.js";

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
      el("p", { class: "soft" }, "Share your link. Payers send dollars and choose what you receive; the agent converts it on Textile FX and pays this wallet."),
      shareBlock(tag),
      el("div", { class: "dash-actions" },
        el("a", { class: "btn btn-secondary btn-sm", href: "get-paid.html" }, icon("link"), "Create a payment link"),
        el("a", { class: "btn btn-secondary btn-sm", href: "quote.html" }, icon("quote"), "Send money"),
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
        el("p", { class: "small soft" }, "A payment link asks for an exact amount, in the currency you choose. Share it by WhatsApp or QR code.")));
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
async function sendTagCall(addr, data, ctx, onSent, failMessage) {
  const eth = injectedWallet();
  if (!eth) throw plainError("No wallet found in this browser. Open this page in your wallet's browser to change your tag.");
  const accs = await eth.request({ method: "eth_requestAccounts" });
  if (!sameAddr(accs?.[0], addr)) throw plainError(`Your wallet is on ${accs?.[0] ? short(accs[0]) : "no account"}, but you're signed in as ${short(addr)}. Switch back to that account. Nothing was sent.`);
  await ensureCelo(eth);
  const sim = await simulate({ from: addr, to: LOKAL_TAGS, data }, ctx);
  if (!sim.ok) throw plainError(`${sim.message} Nothing was sent.`);
  const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from: addr, to: LOKAL_TAGS, value: "0x0", data }] });
  if (!isHash(hash)) throw plainError("The wallet didn't return a transaction id. Check your wallet's activity before trying again.");
  onSent?.(hash);
  const rc = await waitForReceipt(hash, { failMessage });
  if (!rc) throw plainError("Celo hasn't confirmed it after a few minutes. It may still go through; reload in a moment.");
  return hash;
}
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

  return section("settings", "Settings",
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
  root.replaceChildren(...[note, heroSection(s),
    el("div", { class: "dash-grid" }, received, recent, linksSection(s), walletSection()),
    view === "tag" ? settingsSection(s) : null].filter(Boolean));
  const loadActivity = () => loadMyActivity(s.address).then(({ rows }) => {
    if (my !== seq) return;
    received.fill(rows, false); recent.fill(rows, false, loadActivity);
  }).catch(() => { if (my !== seq) return; received.fill([], true); recent.fill([], true, loadActivity); });
  loadActivity();
}

onSessionChange(() => render());
watchSession();
render();
