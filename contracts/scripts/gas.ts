/**
 * Gas used by the everyday calls, measured on the in-process chain with mock tokens (OpenZeppelin ERC-20s). Real USD₮
 * on Celo sits behind a proxy, which adds a few thousand gas to every token call.
 *
 *   cd contracts && npm run gas
 */
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { POT_DEFAULTS, RESERVED_TAGS, USDT_LIMITS } from "../config/celo";

const usd = (n: number) => ethers.parseUnits(String(n), 6);

async function main() {
  const [, payout, ada, bob, carol, dave] = await ethers.getSigners();
  const usdt = await (await ethers.getContractFactory("MockPermitERC20")).deploy();
  const U = await usdt.getAddress();
  const tags = await (await ethers.getContractFactory("LokalTags")).deploy(payout.address, [...RESERVED_TAGS], [{ token: U, limits: USDT_LIMITS }]);
  const router = await tags.getAddress();
  for (const p of [carol, dave]) {
    await usdt.mint(p.address, usd(1000));
    await usdt.connect(p).approve(router, ethers.MaxUint256);
  }
  await usdt.mint(payout.address, usd(1)); // the agent wallet already holds some USD₮, as on mainnet
  await time.increaseTo((Math.floor((await time.latest()) / 86_400) + 1) * 86_400 + 3600);

  const rows: [string, bigint][] = [];
  const measure = async (label: string, p: Promise<any>) => rows.push([label, (await (await p).wait()).gasUsed]);

  const deployRc = await tags.deploymentTransaction()!.wait();
  rows.push(["deploy LokalTags (63 reserved tags, 1 token)", deployRc!.gasUsed]);
  await measure("claim(tag, name) - first tag, 7-char name", tags.connect(ada).claim("ada", "Ada Obi"));
  await measure("claim(tag, \"\") - first tag, no name", tags.connect(bob).claim("bob", ""));
  await measure("claim - switch to another tag (releases the old one)", tags.connect(ada).claim("ada_obi", "Ada Obi"));
  await measure("setName", tags.connect(ada).setName("Ada O."));
  await measure("payTag - first payment ever to this recipient", tags.connect(carol).payTag("ada_obi", U, usd(5), ethers.ZeroHash, ethers.ZeroAddress));
  await measure("payTag - same recipient, same day", tags.connect(dave).payTag("ada_obi", U, usd(5), ethers.ZeroHash, ethers.ZeroAddress));
  await time.increase(86_400);
  await measure("payTag - same recipient, next day", tags.connect(carol).payTag("ada_obi", U, usd(5), ethers.ZeroHash, ethers.ZeroAddress));

  const signer = (await ethers.getSigners())[12];
  await usdt.mint(signer.address, usd(100));
  const deadline = BigInt((await time.latest()) + 3600);
  const { chainId } = await ethers.provider.getNetwork();
  const sig = ethers.Signature.from(await signer.signTypedData(
    { name: "Tether USD", version: "1", chainId, verifyingContract: U },
    { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    { owner: signer.address, spender: router, value: usd(5), nonce: 0n, deadline },
  ));
  await measure("payTagWithPermit (no separate approve)", tags.connect(signer).payTagWithPermit("bob", U, usd(5), ethers.ZeroHash, ethers.ZeroAddress, deadline, sig.v, sig.r, sig.s));
  const pots = await (await ethers.getContractFactory("LokalPots")).deploy(router, POT_DEFAULTS.maxPotCapUsd6, POT_DEFAULTS.maxPerPayerCapUsd6, POT_DEFAULTS.maxPerHostDailyUsd6, POT_DEFAULTS.maxDailyUsd6, [{ token: U, unitsPerUsd: 1_000_000n }]);
  rows.push(["deploy LokalPots (1 token rate)", (await pots.deploymentTransaction()!.wait())!.gasUsed]);
  for (const p of [carol, dave]) await usdt.connect(p).approve(await pots.getAddress(), ethers.MaxUint256);
  await measure("createPot (22-byte title)", pots.connect(ada).createPot("Ada & Tunde's wedding", (await time.latest()) + 3600, 100_000_000n, 5_000_000n));
  await measure("payPot - first guest", pots.connect(carol).payPot(1, U, usd(2), ethers.ZeroHash, ethers.ZeroAddress));
  await measure("payPot - second guest", pots.connect(dave).payPot(1, U, usd(2), ethers.ZeroHash, ethers.ZeroAddress));
  await measure("payPot - same guest again", pots.connect(dave).payPot(1, U, usd(1), ethers.ZeroHash, ethers.ZeroAddress));
  await measure("closePot", pots.connect(ada).closePot(1));
  await measure("release", tags.connect(bob).release());

  const w = Math.max(...rows.map(([l]) => l.length));
  console.log(`| Call | Gas |\n| --- | ---: |`);
  for (const [l, g] of rows) console.log(`| ${l.padEnd(w)} | ${g.toLocaleString("en-US")} |`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
