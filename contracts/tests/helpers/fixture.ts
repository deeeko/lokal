import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { POT_DEFAULTS, RESERVED_TAGS, TOKENS, defaultLimits, unitsPerUsd, type Limits } from "../../config/celo";

export const usd = (n: number | string): bigint => ethers.parseUnits(String(n), 6);
export const DAY = 86_400;
export const LOCK = 30 * DAY;

export const limitsTuple = (l: Limits) =>
  [l.minPerPayment, l.maxPerPayment, l.maxPerRecipientPerDay, l.maxPerPayerPerDay, l.maxPerDay] as const;

/** Default limits for each mainnet token, by symbol (USDT 6, cNGN 6, IDRX 2, wARS 18, wCOP 18 decimals). */
export const LIMITS: Record<string, Limits> = Object.fromEntries(TOKENS.map((t) => [t.symbol, defaultLimits(t)]));
export const DECIMALS: Record<string, number> = Object.fromEntries(TOKENS.map((t) => [t.symbol, t.decimals]));
/** LokalPots dollar rates by symbol (base units per US dollar). */
export const RATES: Record<string, bigint> = Object.fromEntries(TOKENS.map((t) => [t.symbol, unitsPerUsd(t)]));

/**
 * A fresh LokalTags on the in-process chain with a mock of every mainnet token at its real decimals (USD₮ with
 * permit), plus an unlisted token. Payers get plenty of each token and approve the router for all of it.
 */
export async function deployFixture() {
  const signers = await ethers.getSigners();
  const [admin, payout, ada, bob, carol, dave, erin, frank, gina, stranger] = signers;

  const Permit = await ethers.getContractFactory("MockPermitERC20");
  const Mock = await ethers.getContractFactory("MockERC20");
  const usdt = await Permit.deploy();
  const cngn = await Mock.deploy("cNGN", "cNGN", 6);
  const idrx = await Mock.deploy("IDRX", "IDRX", 2);
  const wars = await Mock.deploy("Wrapped ARS", "wARS", 18);
  const wcop = await Mock.deploy("Wrapped COP", "wCOP", 18);
  const other = await Mock.deploy("Other", "OTH", 6);
  const bySymbol = { USDT: usdt, cNGN: cngn, IDRX: idrx, wARS: wars, wCOP: wcop } as const;

  const setup = [];
  for (const [sym, t] of Object.entries(bySymbol)) setup.push({ token: await t.getAddress(), limits: LIMITS[sym] });
  const tags = await (await ethers.getContractFactory("LokalTags")).deploy(payout.address, [...RESERVED_TAGS], setup);
  const router = await tags.getAddress();
  const rates = [];
  for (const [sym, t] of Object.entries(bySymbol)) rates.push({ token: await t.getAddress(), unitsPerUsd: RATES[sym] });
  const pots = await (await ethers.getContractFactory("LokalPots")).deploy(
    router, POT_DEFAULTS.maxPotCapUsd6, POT_DEFAULTS.maxPerPayerCapUsd6, POT_DEFAULTS.maxPerHostDailyUsd6, POT_DEFAULTS.maxDailyUsd6, rates,
  );
  const potsAddress = await pots.getAddress();

  const payers = [ada, bob, carol, dave, erin, frank, gina, stranger];
  for (const p of payers) {
    for (const [sym, t] of [...Object.entries(bySymbol), ["OTH", other] as const]) {
      const dec = sym === "OTH" ? 6 : DECIMALS[sym];
      await t.mint(p.address, 10n ** BigInt(dec) * 100_000_000n);
      await t.connect(p).approve(router, ethers.MaxUint256);
      await t.connect(p).approve(potsAddress, ethers.MaxUint256);
    }
  }
  const clock = await (await ethers.getContractFactory("BlockTime")).deploy();
  // Start every test at 01:00 UTC, so a run near midnight can't split a test across two day buckets.
  await time.increaseTo(nextDayStart(await time.latest()) + 3600);

  return {
    tags, router, pots, potsAddress, usdt, cngn, idrx, wars, wcop, other, bySymbol,
    admin, payout, ada, bob, carol, dave, erin, frank, gina, stranger, signers, clock,
  };
}

/** The LokalTags custom error a call hits, by name, or null if it would go through. Throws on anything else. */
export async function revertName(
  contract: { interface: { parseError(data: string): { name: string } | null } },
  call: () => Promise<unknown>,
): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (e: any) {
    const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
    const parsed = typeof data === "string" && data.length >= 10 ? contract.interface.parseError(data) : null;
    if (parsed) return parsed.name;
    throw e;
  }
}

/** Start of the next UTC day (unix seconds) after `ts`. */
export const nextDayStart = (ts: number): number => (Math.floor(ts / DAY) + 1) * DAY;

/**
 * Ten different wallets (signers 10-19), each holding a tag wallet0..wallet9, each paying the next one `amount` of `token`:
 * with the default limits ($25 per payer and per recipient, $250 a day) that is exactly a token's whole day, and
 * the least it takes: no single payer or recipient can carry more than $25 of it.
 */
export async function fillDay(
  f: Awaited<ReturnType<typeof deployFixture>>,
  token: { getAddress(): Promise<string>; mint(to: string, amount: bigint): Promise<unknown>; connect(s: any): any },
  amount: bigint,
) {
  const wallets = f.signers.slice(10, 20);
  const t = await token.getAddress();
  for (const [i, w] of wallets.entries()) {
    if ((await f.tags.tagOf(w.address)) === "") await f.tags.connect(w).claim(`wallet${i}`, "");
    await token.mint(w.address, amount);
    await token.connect(w).approve(f.router, ethers.MaxUint256);
  }
  for (const [i, w] of wallets.entries()) {
    await f.tags.connect(w).payTag(`wallet${(i + 1) % wallets.length}`, t, amount, ethers.id(`fill-${i}`), ethers.ZeroAddress);
  }
  return wallets;
}
