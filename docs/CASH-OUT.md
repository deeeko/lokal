# Cash out to your bank

LokalPay pays you in a local stablecoin on Celo: cNGN (naira), IDRX (rupiah), wARS (Argentine peso) or wCOP (Colombian peso), or in USD₮. This guide explains how to turn that into money in your bank account.

The short version is on the website: [lokalpay.vercel.app/cash-out.html](https://lokalpay.vercel.app/cash-out.html). This page has the same routes in more depth, with sources.

**Last checked: 21 November 2026.** Apps and exchanges change which tokens and networks they support. Check inside the app before you send, and tell us in [GitHub issues](https://github.com/deeeko/lokal/issues) if something here is out of date.

- [Before you send anything](#before-you-send-anything)
- [Using MiniPay](#using-minipay)
- [Summary](#summary)
- [Naira (cNGN)](#naira-cngn)
- [Rupiah (IDRX)](#rupiah-idrx)
- [Argentine peso (wARS)](#argentine-peso-wars)
- [Colombian peso (wCOP)](#colombian-peso-wcop)
- [Dollars (USD₮ on Celo)](#dollars-usd-on-celo)
- [About this guide](#about-this-guide)
- [Sources](#sources)

## Before you send anything

1. **Send a small test amount first.** Wait until it arrives on the other side, then send the rest.
2. **Only send on a network the receiving app lists for that token.** Your tokens are on the **Celo** network. If the app's deposit page doesn't show Celo for that exact token, don't send it there: tokens sent on an unsupported network can be lost, and recovering them (if possible at all) is up to that app.
3. **Check the token address, not just the name.** Different coins can share a similar name or symbol. Compare the contract address in your wallet with the one in this guide.
4. **LokalPay never asks for your seed phrase** (your recovery words). No real support team does. Anyone who asks for it is trying to take your money.

## Using MiniPay

MiniPay shows only **USDT, USDC and USDm**. Local tokens (cNGN, IDRX, wARS, wCOP) sent to a MiniPay address are on the blockchain, but they won't appear in the app, and you can't withdraw them from there.

If you cash out through MiniPay, **receive USD₮, or swap to USD₮ first**, then send it to MiniPay. Several routes below end this way.

## Summary

| Currency | Token | Recommended route | Status |
|---|---|---|---|
| Naira | cNGN | Swap to USD₮ on Celo → MiniPay Withdraw (Fonbnk Instant Pay) | Indirect: no exchange confirms cNGN on Celo |
| Rupiah | IDRX | Redeem on home.idrx.co → BI-FAST to your bank | Official issuer route |
| Argentine peso | wARS | Ripio → Depositar → wARS (Celo, only if offered) → withdraw pesos | **Not officially confirmed** |
| Colombian peso | wCOP | Swap to USD₮ on Celo → MiniPay Withdraw (El Dorado) | Indirect: no exchange or issuer route |
| Dollars | USD₮ | MiniPay Withdraw through an in-app partner | Works in many countries |

## Naira (cNGN)

| | |
|---|---|
| Token | cNGN |
| Contract on Celo | `0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f` ([Celoscan](https://celoscan.io/token/0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f)) |
| Decimals | 6 |
| Listed by | The issuer's contract address list (docs.cngn.co) |

### Why there's no direct route

As of 21 November 2026, no Nigerian exchange confirms cNGN deposits **on the Celo network**:

- **Busha**: its supported-currencies reference lists cNGN deposit and withdraw as "No", and no Celo network.
- **Quidax**: lists cNGN on other networks, not Celo.
- **Roqqu**: supports cNGN on Base only.
- **Yellow Card**: closed its retail app on 1 January 2026.

Redeeming cNGN directly with the issuer needs a verified cNGN merchant account, so it isn't a route for individuals.

### Recommended route

1. **Swap cNGN to USD₮ on Celo.** For example, use the Uniswap cNGN/USDT pool on Celo. Liquidity is thin, so check the price impact before you confirm, and split a large amount into smaller swaps if the price moves too much.
2. **Send the USD₮ to MiniPay and withdraw.** Send it on the Celo network to your MiniPay address, then tap Withdraw. MiniPay lists Nigerian cash-out to a bank or mobile money through Fonbnk Instant Pay. The partner sets the fees and the ID checks.
3. **Test with a small amount first.** Run the whole route once with a small amount and check your bank before you move the rest.

### Fees, ID checks and timing

- **Swap:** the pool fee, price impact (can be large in a thin pool) and a little CELO for gas.
- **Withdraw:** set by MiniPay's partner and shown in the app before you confirm.
- **ID check (KYC):** set by the partner.
- **Timing:** not published; the app shows an estimate before you confirm.

### Watch out

- Don't send Celo cNGN to Busha, Quidax or Roqqu (see above).
- Mento's naira token **NGNm** (`0xE2702Bd9…6F71`) is a different coin from cNGN. If a swap or app offers "naira", check the contract address.
- Local tokens don't show in MiniPay. Send it USD₮, not cNGN.

## Rupiah (IDRX)

| | |
|---|---|
| Token | IDRX |
| Contract on Celo | `0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22` ([Celoscan](https://celoscan.io/token/0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22)) |
| Decimals | 2 |
| Listed by | The issuer's supported chains and contract addresses (docs.idrx.co) |

IDRX redeems its own token for rupiah, paid to an Indonesian bank account. This is the issuer's documented route.

### Recommended route (official)

1. **Sign up at [home.idrx.co](https://home.idrx.co)** and complete ID verification with your KTP and a selfie.
2. **Open the Redeem tab.** Connect your wallet, choose the **Celo** network, enter the amount and a bank account **in your own name**.
3. **Sign the burn** in your wallet. The rupiah is sent by BI-FAST, usually within 24 hours. Questions: support@idrx.co.

### Fees, ID checks and timing

- **Fee:** Rp5,000 for amounts below Rp250,000,000. Rp35,000 at or above Rp250,000,000; those go by RTGS, which runs weekdays 08:00–15:00 WIB.
- **Minimum:** Rp20,000.
- **ID check (KYC):** KTP and selfie.
- **Timing:** BI-FAST, usually within 24 hours.

### Watch out

- **Only burn IDRX on the IDRX site.** A burn made anywhere else (for example, by calling the contract yourself) loses the funds.
- **Burns are irreversible.** A burn that isn't confirmed within 2 hours is marked FAILED; contact support@idrx.co.
- **Indodax lists IDRX on Base only**, not Celo. Don't send Celo IDRX to Indodax. To use Indodax, bridge to Base through IDRX first; IDRX charges a flat 10,000 IDRX fee for the bridge.
- MiniPay cash-out in Indonesia isn't confirmed, so the IDRX route above is the one to use for rupiah.

## Argentine peso (wARS)

| | |
|---|---|
| Token | wARS (Ripio wFIAT) |
| Contract on Celo | `0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D` ([Celoscan](https://celoscan.io/token/0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D)) |
| Decimals | 18 |
| Issuer | Ripio |

**Status: not officially confirmed.** Ripio launched its wFIAT tokens on Celo on 31 July 2026, but Ripio's wARS page still lists only Ethereum, World Chain and Base. One third-party report ([YagLab0/nomai#68](https://github.com/YagLab0/nomai/issues/68)) saw Ripio → Depositar → wARS → Celo network work on 29 October 2026. Ripio hasn't confirmed it, so treat it as unconfirmed and test first.

### Recommended route

1. **In Ripio, tap Depositar, then wARS.** Choose the **Celo** network **only if Ripio offers it**. If it doesn't, stop and use the fallback below.
2. **Send a small test first** to the deposit address Ripio shows, and wait until it appears in your Ripio balance.
3. **Withdraw pesos** to your CBU, CVU, alias or Mercado Pago, then send the rest the same way.

### Fallback

Swap wARS to USD₮ on Celo, send the USD₮ to MiniPay and tap Withdraw. MiniPay lists El Dorado as its cash-out partner for Argentina. Liquidity for wARS on Celo may be thin: check the price before you confirm.

### Fees, ID checks and timing

- **Fee:** 0% to withdraw pesos, per Ripio.
- **ID check (KYC):** a verified Ripio account.
- **Timing:** 24–48 business hours, historically.
- **Help:** soporte@ripio.com.

### Watch out

- Never send wARS to Ripio on Celo unless the Celo network is shown for wARS in the deposit screen.
- Ripio's wFIAT tokens are not legal tender and have no deposit insurance.

## Colombian peso (wCOP)

| | |
|---|---|
| Token | wCOP (Ripio wFIAT) |
| Contract on Celo | `0x8a1D45e102e886510e891d2Ec656a708991e2D76` ([Celoscan](https://celoscan.io/token/0x8a1D45e102e886510e891d2Ec656a708991e2D76)) |
| Decimals | 18 |
| Issuer | Ripio |

**Status: no direct route.** There's no issuer redemption right: Pharos reports that the wCOP whitepaper denies one. No exchange confirms wCOP deposits on Celo. Of the four local tokens, wCOP is the least liquid.

### Recommended route

1. **Swap wCOP to USD₮ on Celo**, if a route exists. Liquidity is thin: if there's no route or the price is poor, stop.
2. **Send the USD₮ to MiniPay and tap Withdraw.** MiniPay lists El Dorado for cash-out to Colombian banks.
3. **Or ask Ripio support** (soporte@ripio.com) what they can offer for wCOP on Celo.

### Fees, ID checks and timing

- **Swap:** pool fee and price impact.
- **Withdraw:** set by El Dorado, shown in MiniPay before you confirm.
- **ID check (KYC):** set by the partner.
- **Timing:** not published.

### Watch out

- Don't send wCOP to an exchange: none confirms it on Celo.
- Swap a small amount first and check what you receive.
- Ripio's wFIAT tokens are not legal tender and have no deposit insurance.

## Dollars (USD₮ on Celo)

| | |
|---|---|
| Token | USD₮ (Tether) |
| Contract on Celo | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` ([Celoscan](https://celoscan.io/token/0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e)) |
| Decimals | 6 |

USD₮ is the universal fallback: more apps accept it on Celo than any of the local tokens.

### Recommended route

1. **Send the USD₮ to your MiniPay address** on the Celo network. It shows in MiniPay as USDT.
2. **Tap Withdraw** and choose an in-app partner for your country (bank or mobile money). The fee and the amount you'll receive are shown before you confirm.
3. **Test with a small amount first**, check your bank, then send the rest.

### Other places that accept USD₮, and their status

| Service | USDT on Celo | Notes |
|---|---|---|
| MiniPay | Yes | Withdraw through in-app partners in many countries. Indonesia cash-out is not confirmed. |
| Binance | Deposits supported since April 2024 | No naira since 2024. After an October 2026 incident, withdrawals were reopening in phases, so Celo withdrawals are unconfirmed. |
| Bybit | Unconfirmed | Check that the deposit page lists the Celo network before sending. |

### Watch out

- **Peer-to-peer (P2P) sales:** release your USD₮ only after the money is in your bank account. Check your bank app yourself; never trust a screenshot or a "payment sent" message.
- Check the network on every deposit page. "USDT" on another network is not the same deposit.

## About this guide

- This guide describes third-party services as we found them on the date above. LokalPay isn't affiliated with any of them, earns nothing from them, and can't promise how they'll handle your money.
- Routes marked "official" are documented by the token's issuer. Routes marked "not officially confirmed" rely on a third-party report and may stop working.
- LokalPay pays to your wallet. What happens after that is between you and the app you choose.

## Sources

All checked on 21 November 2026.

- cNGN contract addresses: https://docs.cngn.co/guides/contract-addresses
- Busha supported currencies: https://docs.busha.io/guides/reference/supported-currencies
- Celo adds cNGN liquidity on Uniswap (Mariblock): https://mariblock.com/stories/celo-adds-cngn-liquidity-on-uniswap-for-broader-access-to-onchain-fx
- Yellow Card app closure: https://help.yellowcard.io/article/973-yellow-card-app-closure
- IDRX redeem: https://docs.idrx.co/services/redeem-idr
- IDRX fees: https://docs.idrx.co/services/fees
- IDRX supported chains and contract addresses: https://docs.idrx.co/introduction/supported-chain-and-contract-address
- Indodax adds IDRX on Base: https://blog.indodax.com/idrx-base-network-addition/
- Ripio wFIAT: https://ripio.com/en/wfiat
- Third-party report of wARS deposits on Celo: https://github.com/YagLab0/nomai/issues/68
- wCOP on Pharos: https://pharos.watch/stablecoin/wcop-ripio/
- MiniPay FAQ: https://minipay.to/faq
- MiniPay and Fonbnk Instant Pay: https://minipay.to/blog/instant-pay-by-fonbnk-pay-any-merchant-with-usdt
- MiniPay in Latin America: https://minipay.to/blog/pay-like-a-local-with-minipay-latin-america
- MiniPay deeplinks (technical reference): https://docs.minipay.xyz/technical-references/deeplinks.html
- Binance, "USDT on CELO network" announcement, 17 April 2024
