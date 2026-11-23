# Runbook: the first real payouts

Copy-paste steps, in PowerShell, for the operator. Every command runs from the repo folder (the folder you cloned
https://github.com/deeeko/lokal into):

```powershell
cd lokal
```

Nothing here moves money until a command has `--execute` **and** you type `yes`.

## Before you start

**Recipient:** someone outside the team, with a Celo wallet that can **show cNGN**.

- **MetaMask works.** Add the Celo network, then *Import tokens* and paste cNGN's address:
  `0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f`.
- **MiniPay does not.** MiniPay only shows USDT, USDC and USDm, so naira sent there is on-chain but invisible in the
  app.
- Ask whether they agree to be named in the README (first name, city, what it was for), or prefer to stay anonymous.

**Payer:** holds a few USD₮ on the **Celo network**, for example withdrawn from an exchange that lists "USDT, Celo
network", or held in MiniPay.

- Best for the hackathon: the payer is also outside the team (a relative or a client of the recipient), paying from
  their own wallet.
- Use $2 to $5. Textile's minimum is about $1.

**Agent:** needs at least 3 CELO for gas.

## 1. Preflight (read-only)

```powershell
node src/agent.mjs status                 # CELO >= 3, daily cap room, open requests
node src/agent.mjs quote --amount 2       # live Textile price: 2 USD₮ -> about ₦2,880
```

If the quote fails, stop: Textile has no price right now. Try again later.

## 2. Path A: a payment link (simplest; the recipient only gives an address)

1. Add the recipient to `contacts.json`, under `"contacts"`, as `"tunde": "0x…their address…"`.
2. Make the link:

   ```powershell
   node src/agent.mjs request --to tunde --amount 2 --note "First LokalPay payout"
   ```

   It prints a link with a **unique amount** (for example 2.37 USD₮). The payer must send exactly that.
3. Start autopilot in a **second** PowerShell window and leave it running:

   ```powershell
   node src/agent.mjs watch --execute
   ```

4. The payer opens the link, connects their wallet and pays.
5. Within a minute or two, autopilot prints `paid` with a receipt number (`NP-XXXX-XXXX`). Open the receipt link it
   prints. The recipient should see the cNGN in MetaMask.

## 3. Path B: a LokalPay tag (best for traction)

1. The recipient opens https://lokalpay.vercel.app/account.html, connects MetaMask, signs in and claims a tag (e.g.
   `tunde`). Claiming is one small transaction, so they need a little CELO for gas (0.01 CELO is plenty).
2. Keep autopilot running (`node src/agent.mjs watch --execute`).
3. The payer opens `https://lokalpay.vercel.app/@tunde`, enters $2 to $5 and pays from their own wallet. Or, from the
   `lokal` command: `lokal send tunde 2`.
4. Autopilot pays the tag's owner in naira and prints the receipt.

## 4. After each payout

- Open the receipt and the **Verify** page. Every agent transaction must show the attribution tag
  `celo_7360953d1b53`.
- Ask the payer to leave a rating on the receipt page (ERC-8004 reputation).
- Send the receipt link to the developer. It goes into the README's "What's real" table and the "Still to do" list in [ROADMAP.md](ROADMAP.md), with its
  transaction links, and naira moves from **Built, not yet used on mainnet** to **Live**.

## If something goes wrong

- **Autopilot stops with a message.** Read it. It always says whether money moved. Nothing is paid twice: restart
  with the same command, or use the `retry` command it prints (dry run first, then `--execute`).
- **Payment refused** (wrong amount, over a limit, expired link). The money stays in the agent wallet. Note the
  transaction hash; it can be sent back to the payer.
- **Never** share or paste the agent key file, the status secret, or any seed phrase, with anyone.
