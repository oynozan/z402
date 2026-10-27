# x402 Streamed Payments on Zcash — MVP Build Doc

Oct 27, 2026 · @Ozan Andaç

> Copy of the project's source spec, saved for both build agents. Project name: **z402**.
> The original's embedded request-flow diagram (4 parties, 7 steps) is not reproduced here.

## Goal and scope

The MVP proves one claim: an AI agent on a stock x402 v2 client pays a stream of API calls in shielded testnet ZEC without waiting about 75 s per payment. It does this with one on-chain deposit per window, an off-chain signed voucher per call, and a server-side trust ramp.

Done means:

- The agent's code is the standard x402 client plus one `register("zcash:testnet", …)` line, the same way EVM or Solana schemes are added.
- 150 paid calls run back to back; only deposits wait on the chain.
- Credit grows as deposits confirm, and a client that stops depositing is refused at its limit.

Closest prior work: [Kage](https://github.com/nickthelegend/zec-shielded-x402) already runs shielded x402 on testnet with a facilitator that holds only the merchant's incoming viewing key. It uses the x402 v1 wire format and its own client, and waits for one confirmation per payment; its prepaid token feature also needs that client. This MVP differs in two ways: an unmodified x402 v2 client, and a trust ramp instead of a confirmation wait.

Cut from the MVP: mainnet, browser wallets, Python and Go clients, MCP transport, refunds of unused balance, spend caps, a dashboard, durable storage, USD pricing.

## How it works

The client scheme decides on each call. If headroom is below half a window and no deposit is pending, it pays a new window on-chain first; otherwise the call carries only a signed voucher.

[Embedded diagram in the original: request flow · 4 parties, 7 steps]

The facilitator touches the chain only to decrypt a new deposit, so most calls finish at HTTP speed.

## Components

Three pieces of TypeScript plus a public lightwalletd. The agent developer installs only the client scheme.

| Component | Runs in | Built on | Job |
| --- | --- | --- | --- |
| Client scheme | Agent process | `SchemeNetworkClient` from `@x402/core`; a wallet adapter that calls zingo-cli | Keeps a session key, sends a deposit when headroom runs low, signs a voucher per call |
| Server scheme and middleware | API server | x402 v2 `x402ResourceServer` and its Express middleware | Builds the 402 with price, window and credit rule; forwards payloads to the facilitator |
| Facilitator | Same machine as the API | `x402Facilitator` with `/verify`, `/settle`, `/supported`; [Hanko](https://github.com/nickthelegend/zec-payment-verify-sdk)'s `verify()` for deposits | Checks deposits with the merchant's incoming viewing key, tracks sessions, enforces the trust ramp |
| lightwalletd | Public testnet.zec.rocks | Existing service | Serves transactions, including unconfirmed ones |

Agent code, unchanged except one line:

```ts
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";

const client = new x402Client();
client.register("zcash:testnet", zcashClientScheme); // the only new line
const paidFetch = wrapFetchWithPayment(fetch, client);
await paidFetch("https://api.example/chunk");
```

The facilitator runs on the merchant's side because it needs the merchant's incoming viewing key; a hosted one would see every payment the merchant receives.

## Payment payload and verification

Every call is one standard x402 round trip. The payload always carries a voucher, and a deposit txid only on the call that paid a new window.

**402 requirements** (one entry in `accepts`):

```json
{
  "scheme": "<scheme id: to pick>",
  "network": "zcash:testnet",
  "amount": "1000",
  "asset": "ZEC",
  "payTo": "<merchant shielded-only unified address>",
  "maxTimeoutSeconds": 60,
  "extra": { "windowZat": 100000, "creditRatio": 0.25, "creditCapZat": 200000 }
}
```

**Payload** (inside `PAYMENT-SIGNATURE`):

```json
{
  "sessionKey": "<ed25519 public key, hex>",
  "cumulativeZat": "53000",
  "sig": "<ed25519 signature over payTo + cumulativeZat>",
  "depositTxid": "<txid, only on the call that paid a new window>"
}
```

Each deposit's memo is `<sessionKey>:<depositIndex>`. A deposit therefore credits only the session holding that key, and a leaked txid is useless to anyone else.

Facilitator `/verify` (read-only):

1. If `depositTxid` is set, fetch it, retrying for up to 15 s while it reaches lightwalletd's mempool. Trial-decrypt it with the incoming viewing key. Require at least `windowZat` to `payTo`, the memo above, and no transparent part.
2. Check the signature, that `cumulativeZat` grew by at least `amount`, and that it stays within the trust ramp limit.

`/settle` records the deposit and the new `cumulativeZat`. Nothing goes on-chain at settle, because the agent's wallet already broadcast the deposit. A background loop re-checks unconfirmed deposits every 30 s.

Open questions:

- Scheme id: pick a name.
- Network id: `zcash:testnet` follows x402 v2's `namespace:reference` shape, but I haven't confirmed a registered CAIP-2 namespace for Zcash. Treat it as provisional.

## Trust ramp rules

A call is accepted while the session's running total stays under its deposits plus a credit line that grows only from confirmed deposits.

```latex
c_{\text{new}} - c_{\text{last}} \ge p \quad\text{and}\quad c_{\text{new}} \le D_{\text{conf}} + D_{\text{pend}} + \min\left(C_{\max},\ r \cdot D_{\text{conf}}\right)
```

- c is the cumulative voucher total and p the price per call.
- D_conf is the sum of deposits with at least 1 confirmation. D_pend is the newest unconfirmed deposit only; at most one counts.
- r is the credit ratio and C_max the credit cap.

| Parameter | Demo value | Effect |
| --- | --- | --- |
| Window W (one deposit) | 100,000 zat | The 10,000 zat network fee is 10% overhead per window |
| Price p | 1,000 zat per call | 100 calls per window |
| Credit ratio r | 0.25 | Free credit is at most a quarter of confirmed deposits |
| Credit cap C_max | 200,000 zat (2W) | Caps credit on long sessions |
| Deposit trigger | Headroom below W/2 and no unconfirmed deposit | The next deposit can confirm before the window runs out |

Worst-case loss per session is one unconfirmed window plus the credit line: W + min(C_max, r × D_conf).

The client scheme computes the same rule from the 402's `extra`, so it never sends a voucher the server would refuse. That matters because the stock fetch wrapper retries a 402 only once, so a refused voucher fails that call.

Wallet note: ZIP 315 recommends waiting 3 confirmations before spending your own change, so split the agent wallet into about 5 notes before the demo.

## Build plan and demo

About 20 working hours, in this order; each step ends in something that runs.

1. **Wallets and tooling (2 h).** Create agent and merchant testnet wallets with zingo-cli, fund the agent from a faucet, and split it into 5 notes. Export the merchant's address and incoming viewing key. Confirm Hanko's `verify()` sees an unconfirmed transaction.
2. **Facilitator (5 h).** `/verify`, `/settle` and `/supported`; the deposit check; an in-memory session map; the voucher and limit check; the confirmation poller.
3. **Client scheme (5 h).** Session key, headroom from the rule, deposit through zingo-cli with the session memo, voucher signing.
4. **API server (2 h).** One paid route that returns one chunk per call, wired to the facilitator.
5. **Agent and demo script (3 h).** A stock `wrapFetchWithPayment` loop of 150 calls, one log line per call, and a cheat flag that stops depositing.
6. **Buffer and recording (3 h).** Testnet blocks can run minutes apart, so record the demo early.

Demo, 3 minutes:

1. Show the agent code: the stock x402 client plus one `register` line.
2. Start the loop. Call 1 sends deposit 1 and is served at once on the unconfirmed deposit.
3. Calls stream at local speed; the log shows the running total against the limit.
4. A block lands, deposit 1 confirms, and the credit line appears.
5. Deposit 2 goes out at half a window, so the stream never stalls.
6. Cheat mode: deposits stop, calls run on credit, then get refused at the limit.
7. Open a deposit on the explorer: no amount or address is visible. Decrypt it with the viewing key.

## Known limits

- **Zero-conf risk.** An unconfirmed deposit can be double-spent; the loss is capped at one window plus the credit line.
- **Trust is per session key.** A new key starts with no credit, so walking away and restarting gains at most one window plus credit each time.
- **Tooling.** NU7 is live on testnet, and only pre-release librustzcash crates parse its transactions. Use the versions Kage and Hanko pin.
- **Wallet shortcut.** zingo-cli as the client wallet is a demo choice; a real client scheme needs an embedded wallet.
- **No refunds.** Unused deposit balance stays with the merchant.
- **State.** Sessions live in memory, so a restart forgets them.
- **Reuse.** Hanko and Kage are MIT-licensed; credit any code you take from them in the submission.

## Sources

- [x402 v2 client registration and headers (Coinbase docs)](https://docs.cdp.coinbase.com/x402/buyer/mcp-payments.md)
- [Kage: shielded x402 on Zcash testnet](https://github.com/nickthelegend/zec-shielded-x402)
- [Hanko: verify shielded Zcash payments with a viewing key](https://github.com/nickthelegend/zec-payment-verify-sdk)
- [ZIP 315: wallet confirmation policy](https://zips.z.cash/zip-0315)
