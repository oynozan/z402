# z402 demo video (2:00)

The narration is about 250 words over two minutes, roughly 125 words a minute, which reads at a relaxed pace. Every number on screen comes from the real regtest stack. Beats 2 to 4 follow [demo.md](demo.md), with two providers instead of one.

## Flow

| Time | Screen | What happens on screen | Narration |
|---|---|---|---|
| 0:00–0:15 | **Slide** | The z402 logo on Zcash gold. Title: "Private pay-per-call for AI agents, on shielded Zcash". Three small labels: *one shielded deposit · a signed voucher per call · any x402 provider*. | "z402 lets AI agents pay for APIs by the call with shielded Zcash, and nobody watching the chain can tell who paid whom, or how much." |
| 0:15–0:32 | **Browser**, website catalog | Two rows: **Demo API**, 500 zat per chunk, and **Partner API**, 800 zat per chunk, each with its own `uregtest1…` shielded address. Hover one row to show its address. | "This is the catalog our facilitator hosts. Each provider sets its own price in zatoshi and gets paid to its own shielded address. We're one provider here, and anyone with an x402 API can join with a single registration." |
| 0:32–0:54 | **Terminal 1**, agent | The agent starts with two `--url` targets. `* deposit D1 started, paid inline`, then a pause of about 5 s, then `broadcast … in 5,6xx ms`, then the same for the second provider. `#001 [1] 200  c=500  limit=100,000  conf=0  pend=100,000 … D1 … pending` and `#002 [2] 200  c=800 …`. | "Now an agent calls two of these providers. It opens a shielded deposit with each one. That short pause is its wallet building the zero-knowledge proof. And the first call is served right away, before the deposit has even confirmed." |
| 0:54–1:06 | **Terminal 1**, stream; **Terminal 2**, clock | One line per second, alternating `[1]` and `[2]`, with `c=` climbing. The clock prints a block. The next line shows `conf=100,000  credit=25,000  limit=125,000 … D1 … confirmed`. | "After that, every call is just a signed voucher. No transaction, nothing on chain. When the next block lands, the deposit confirms and a small credit line opens." |
| 1:06–1:36 | **Terminal 2**, `scripts/demo.sh show` | First the raw transaction: its size, the first bytes, and the line "Its shielded outputs hold no plaintext amount or address, only ciphertext". Then the decrypt JSON: point at `"pool": "ironwood"`, `"valueZat": 100000`, `"toPayTo": true` and `"memoText": "<sessionKey>:1"`. The last line: "Only the net value balance (here the fee) is public." | "So what does the chain actually see? This. Encrypted bytes and a fee. No amount, no sender, no recipient. Here's the same transaction through the provider's viewing key, which can read payments but never spend them: a hundred thousand zatoshi to the provider, and an encrypted memo with the agent's session key. That memo is how the facilitator credits the right session, without telling anyone else." |
| 1:36–1:50 | **Terminal 1**, cheat run (jump cut) | `scripts/demo.sh cheat`: about 200 calls fly by on one unconfirmed deposit. Cut to the end: `#251 402  REFUSED z402_deposit_required at limit 125,000` and `stopped: the merchant refused at its credit limit…`. | "And if an agent stops paying? It gets one deposit and a small credit line, and then it's refused. What a cheater can take is capped, every time." |
| 1:50–2:00 | **Browser**, catalog, then the end card | Both rows now show "N paid today". End card: the logo, "z402 · shielded pay-per-call on Zcash", and the repo URL. | "Private by default, one deposit instead of a transaction per call, and open to any provider. That's z402." |

If the take runs long, cut the cheat run (1:36–1:50) first. The story still holds without it.

## Narration only (read aloud)

> z402 lets AI agents pay for APIs by the call with shielded Zcash, and nobody watching the chain can tell who paid whom, or how much.
>
> This is the catalog our facilitator hosts. Each provider sets its own price in zatoshi and gets paid to its own shielded address. We're one provider here, and anyone with an x402 API can join with a single registration.
>
> Now an agent calls two of these providers. It opens a shielded deposit with each one. That short pause is its wallet building the zero-knowledge proof. And the first call is served right away, before the deposit has even confirmed.
>
> After that, every call is just a signed voucher. No transaction, nothing on chain. When the next block lands, the deposit confirms and a small credit line opens.
>
> So what does the chain actually see? This. Encrypted bytes and a fee. No amount, no sender, no recipient. Here's the same transaction through the provider's viewing key, which can read payments but never spend them: a hundred thousand zatoshi to the provider, and an encrypted memo with the agent's session key. That memo is how the facilitator credits the right session, without telling anyone else.
>
> And if an agent stops paying? It gets one deposit and a small credit line, and then it's refused. What a cheater can take is capped, every time.
>
> Private by default, one deposit instead of a transaction per call, and open to any provider. That's z402.

## Why each claim holds

- **The chain hides who paid whom, and how much.** The deposit has no transparent inputs or outputs. `show-deposit.sh` checks this and says that only the net value balance, the fee, is public.
- **"The pause is the proof."** The broadcast time in the agent log is the wallet's proving time (demo.md, beat 2).
- **Served before confirmation.** This is zero-conf credit for one window (100,000 zat), and only for a deposit whose expiry is at least 20 blocks out (protocol §5.3).
- **"Nothing per call on chain."** Calls carry Ed25519 cumulative vouchers. The only transactions are the deposits.
- **The credit line.** After a confirmation, credit = 25 % of confirmed deposits, capped at 200,000. One confirmed window gives a limit of 125,000.
- **The viewing key reads but can't spend.** The facilitator holds the provider's UIVK, the incoming viewing key, and never a spending key. Providers register with a view-only key file.
- **The memo.** A ZIP 302 text memo `<sessionKey>:<index>` binds the deposit to the agent's session (protocol §5.1).
- **The cheater's cap.** The cheater is refused at `limit=125,000`, which is one unconfirmed window plus the credit line (demo.md, beat 6).

## Setup before recording (off camera)

1. Run `scripts/demo.sh up`. It starts the facilitator on 4022 and the Demo API on 4021 at 500 zat. The Demo API needs `Z402_API_PUBLIC_URL=http://127.0.0.1:4021`, so it is listed by name (one line in demo.sh).
2. Start provider 2:
   - make view-only keys with `merchant-keygen`;
   - register them with `scripts/register-provider.mjs`;
   - start a second `apps/api` on 4023 at 800 zat, with its own `Z402_API_PUBLIC_URL` and the service name "Partner API".

   The commands are in [live-run.md §9](research/live-run.md).
3. Run `scripts/demo.sh clock`, which mines a block every 25 s.
4. Start the website dev server on `localhost:3000`. It reads the facilitator at `127.0.0.1:4022` by default.
5. Lay out the screen: the browser, terminal 1 for the agent, and terminal 2 for the clock tail and `show`.
6. Start the agent right after a block lands. Call 1 then visibly runs on an unconfirmed deposit, and the next block arrives about 20 s in.
7. Record the cheat run as its own take, and cut it in.
