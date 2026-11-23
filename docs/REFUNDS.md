# Refunds

A refund sends a deposit back to the wallet it came from: the `from` of the deposit's ERC-20 Transfer log, in the same
token, for exactly the same amount. The agent wallet pays the gas. Refunds exist for money that reached the agent but
that autopilot will never pay out, so it does not sit in the agent wallet for ever.

Code: `src/refund.mjs` (the rules and the flow), `src/agent.mjs` (`refund`, `refunds`), `src/watch.mjs`
(`--auto-refund`). Tests: `test/refund.test.mjs`, `test/invariants.test.mjs`.

## What can be refunded

| Deposit | Where autopilot recorded it | Refundable |
|---|---|---|
| Refused LokalPay tag payment (any reason: unknown tag, bad memo, under the minimum, over a cap, self-payment, ...) | `ntag-payments.json`, `status: "refused"` | yes |
| Refused "Get paid" deposit (any reason) | `registrations-state.json`, the registration's `refused` map | yes |
| Deposit to an expired or already used link | `receipts.jsonl`, `type: "unmatched_deposit"` | yes |
| Unmatched deposit (no link has that token and exact amount) | `receipts.jsonl`, `type: "unmatched_deposit"` | yes |
| Ambiguous deposit (matches a request **and** a registration) | `receipts.jsonl`, `type: "ambiguous_deposit"` | yes |

Never refunded:

- **Paid deposits**, and deposits with a payout recorded (received, being paid, or a failed payout). A failed payout is
  settled with `retry`, never with a refund.
- **Top-ups**: transfers from one of the operator's `own_wallets` (`contacts.json`).
- **The agent's own swap outputs**: any transfer in a transaction the agent itself sent.
- **Transfers from the Textile reactor** (or any token or registry contract, the agent, or the zero address).
- Deposits autopilot has **no record of yet** (it may still match a link). Let `watch` see it first.
- Deposits worth **under `MIN_REFUND_USD`** (default $1): recorded as `too_small_to_refund` and left alone, because the
  gas would cost more than the refund is worth.
- Anything that would take the refunds of the last 24 hours over **`MAX_DAILY_REFUND_USD`** (default $100). Refunds
  have their own cap; they never count towards the payout caps (`MAX_USD`, `MAX_WALLET_DAILY_USD`, `MAX_DAILY_USD`).

## Commands

```powershell
node src/agent.mjs refunds                                   # what can be refunded, and every refund so far
node src/agent.mjs refund --deposit 0x<tx>:<logIndex>        # DRY RUN: checks everything, shows a gas estimate
node src/agent.mjs refund --deposit 0x<tx>:<logIndex> --execute          # asks you to type yes
node src/agent.mjs refund --deposit 0x<tx>:<logIndex> --execute --yes    # no question (scripts)
node src/agent.mjs refund --deposit 0x<tx>:<logIndex> --retry --execute  # after a failed refund (see below)
node src/agent.mjs watch --execute --auto-refund             # autopilot also refunds refused tag and Get paid deposits
```

`refunds` lists, for every refundable or refunded deposit: the key (`<tx>:<logIndex>`), payer, token, amount, why it
was not paid, its age and its status: `refundable`, `sending`, `refunded`, `failed` or `too_small_to_refund`.

## How one refund runs

1. **Dry run first.** Re-reads the deposit over RPC, runs every check below and prints the plan with a gas estimate.
   Nothing is written or sent.
2. With `--execute`: you type `yes` (or pass `--yes`).
3. **Lock.** Takes the agent lock (`agent.lock`, the same one autopilot and `pay --execute` take), so a refund can never
   race a payout.
4. **Re-read the deposit over RPC.** The transaction succeeded, the log is an ERC-20 Transfer of a token LokalPay knows
   (USD₮, cNGN, IDRX, wARS or wCOP, each in its own decimals), sent to the agent, and its amount and `from` are what the
   refund will use. The transaction was not sent by the agent. The minimum and the cap are in USD: USD₮ counts 1:1, a
   local token is valued with a live Textile price (no price, no refund).
5. **Check it is not paid, refunded or in progress** across `requests.json`, `registrations-state.json`,
   `ntag-payments.json` and `refunds.json`, and that autopilot recorded it as refundable (the table above). Then the
   depositor rules, the minimum, the refund cap, the token balance and the CELO for gas.
6. **Record first.** Writes `status: "sending"` to `refunds.json` (keyed by `<tx>:<logIndex>`) **before** anything is
   sent.
7. **Send** an ERC-20 `transfer(from, amount)` from the agent wallet. The wallet client is built in `src/chain.mjs`, so
   the transaction carries the attribution tag like every other transaction the agent sends. The refund tx hash is
   saved as soon as the transfer is broadcast.
8. **Verify.** Waits for the receipt and checks it holds a Transfer of that token, from the agent, to the depositor,
   for exactly that amount.
9. **Mark refunded** with `refundTx` and a refund number `RF-XXXX-XXXX` (the first 8 hex characters of the refund tx;
   payout receipts keep their `NP-` numbers unchanged).
10. **Log** to `receipts.jsonl` as `kind: "refund"`. The payout caps skip these lines.
11. **Report** a `refunded` status event to the site's status server, so the payer's status page can say "Refunded"
    with the transaction link.

## When something goes wrong

- **A refund that fails after it was recorded is marked `failed` and never retried automatically.** An urgent alert is
  sent (when alerts are set up).
- **`--retry`** (with `--execute`) first searches the chain for a transfer from the agent to that payer, of that token
  and amount, after the refund was recorded. If it finds one, it marks the refund `refunded` with that transaction
  instead of sending again. Only when there is none does it send a new refund.
- **A crash while sending** leaves the record at `sending`. Every command (autopilot, `retry`, `refund`) then treats the
  deposit as in progress and refuses to touch it. `refund --retry` handles it like a failed refund (search first,
  then send), once the record is more than 10 minutes old.
- **A refunded deposit can never be paid.** Autopilot skips any deposit with a refund record, and
  `retry --force-refused` refuses one. **A paid deposit can never be refunded.**

## Auto-refund (opt-in)

`watch --execute --auto-refund` refunds a deposit right after autopilot refuses it, with every check above. Only
**refused LokalPay tag and "Get paid" deposits**, at most **3 refunds per payer in 24 hours** (more wait for the
operator). Unmatched and ambiguous deposits are always refunded by hand. A failed auto-refund never stops autopilot: it
is recorded as `failed`, alerted, and left for `refund --retry`.
