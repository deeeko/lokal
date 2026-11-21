# Security policy

Lokal moves real money on Celo mainnet, so security reports are welcome and taken seriously.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub:
**[Security → Report a vulnerability](https://github.com/deeeko/lokal/security/advisories/new)**.

Include what you found, how to reproduce it, and what an attacker could do with it. You should get a first reply
within 72 hours. Please give us a reasonable time to fix the problem before you talk about it publicly.

## What is in scope

| Area | Where |
| --- | --- |
| The payout agent (autopilot, payouts, limits, refunds) | `src/` |
| The website and its API routes | `site/`, `api/`, `lib/` |
| The `lokal` command and its encrypted wallet | `src/ntag.mjs`, `site/install.ps1` |
| The smart contracts on Celo mainnet | `contracts/`: LokalTags [`0xFF2f8ADC0c97B6E40b201848d378C11325bC7187`](https://celoscan.io/address/0xFF2f8ADC0c97B6E40b201848d378C11325bC7187), LokalPots [`0x60F76b5d1dc6a9B1e208fB93f6C0B05De51a7DAF`](https://celoscan.io/address/0x60F76b5d1dc6a9B1e208fB93f6C0B05De51a7DAF) |

Examples of what we most want to hear about:

- any way to make the agent pay twice, pay the wrong person, or pay more than its limits;
- any way to get a payment past the contracts' limits, or to claim a reserved tag;
- anything that leaks a key, a password or the status server's secret;
- cross-site scripting or a way around the site's Content-Security-Policy.

Out of scope: problems in Celo, Textile FX, Blockscout, wallets or token issuers themselves (report those to them),
and denial-of-service by sending lots of transactions.

## What is already in place

- The contracts never hold money, use OpenZeppelin's two-step ownership, and can be paused by an admin wallet that is
  separate from the agent's key. A new payout wallet waits 24 hours in public before it takes effect.
- The agent is a dry run unless started with `--execute`, records each deposit before paying it, and checks every
  payment against hard limits. See [docs/WHO-ENFORCES-WHAT.md](docs/WHO-ENFORCES-WHAT.md).
- Secrets are never committed; every push is checked.

## Supported versions

Only the current `main` branch and the contracts at the addresses above are supported.
