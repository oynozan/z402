# Demo runbook

For the person recording the 3-minute demo. Everything runs locally on the Z3 regtest stack (Zebra, Zallet and Zaino in Docker) and is driven by one script, `scripts/demo.sh`. Run `scripts/demo.sh --help` for the command list.

The story in one breath: an AI agent pays for a stream of API calls in shielded Zcash. It makes one deposit per window instead of one transaction per call, signs a voucher per call, and the merchant widens its trust as deposits confirm.

Terms are demo option A (`docs/spec/protocol.md` section 12).

| Term | Value | What you will see |
|---|---|---|
| Price `p` | 500 zat per call | `c=` grows by 500 per call |
| Window `W` | 100,000 zat (one deposit) | 200 calls per deposit |
| Credit | 2500 bps of confirmed deposits, cap 200,000 | `credit=25,000` after D1 confirms |
| Limit | confirmed + pending + credit | 100,000 after D1 pending, 125,000 after D1 confirms |
| Blocks | one every 25 s, from the clock | `conf=` moves when a block lands |

## Preflight

Do all of this before you start recording.

1. **Docker is running.** `docker info > /dev/null && echo ok`
2. **The stack is up.** `scripts/demo.sh up` brings up Z3 (idempotent), then the facilitator and the API, and ends with both ready lines:

   ```
   facilitator ready after 3s: facilitator listening on http://127.0.0.1:4022 network=regtest payTo=uregtest1etwr...
   api ready after 2s: api listening on http://127.0.0.1:4021 network=regtest
   ```

   Each waits up to 60 s. If one does not appear, the script prints the log tail and exits 1 (see Troubleshooting).
3. **The agent wallet is funded.** `scripts/demo.sh status` must show at least 250,000 zat spendable (two deposits of 100,000 plus fees), and Zebra answering:

   ```
   ==> Agent wallet
       spendable    6,249,460,000 zat, enough (the demo needs 250,000)
   ```
4. **The decryptor is built.** `ls -l crates/zdecrypt/target/release/zdecrypt`. If it is missing, run `pnpm --filter @z402/facilitator build:native`.
5. **Optional rehearsal of beat 7.** `scripts/demo.sh show <txid>` works on any earlier mined deposit, so you can check the decrypt before the take.

Two terminals make the footage easier. Terminal 1 is the agent, with a large font. Terminal 2 runs `tail -f .data/demo/clock.log` so each new block is visible.

## The 3-minute story

The agent prints one line per paid call:

```
#012 200  c=6,000  limit=100,000  conf=0  pend=100,000  credit=0  D1 3f2a…c1 pending
```

- `c=` is the running total the agent has signed for (cumulative zat).
- `limit=` is the most the merchant will accept right now.
- `conf=`, `pend=` and `credit=` are the three parts of that limit: confirmed deposits, the one unconfirmed deposit, and free credit.
- `D1 3f2a…c1 pending` lists each deposit with its short txid and status.
- Lines starting with `  * ` are scheme events, such as `  * deposit D1 started, paid inline`.

| # | Beat | You run | Point at |
|---|---|---|---|
| 1 | The code | open `apps/agent/src/agent.ts` | The stock `@x402/fetch` imports and one line, `client.register(flags.network, zcashClientScheme)`. Nothing else in the loop knows about Zcash. |
| 2 | Call 1 on an unconfirmed deposit | `scripts/demo.sh clock`, then `scripts/demo.sh honest` | `wallet: … zat spendable`, then 5 to 10 s of silence while D1 is proved and sent inline (`  * deposit D1 started, paid inline`). Call 1 is served on the unconfirmed deposit: `#001 200  c=500  limit=100,000  conf=0  pend=100,000  credit=0  D1 3f2a…c1 pending`. |
| 3 | The stream | (running) | One line per second. `c=` climbs by 500 a call against `limit=100,000`. One voucher per call, no transaction per call. |
| 4 | A block lands | (running) | The clock fires within 25 s, the facilitator notices within 5 s more. `conf` goes 0 to 100,000, `pend` to 0, `credit=25,000` appears, `limit` goes 100,000 to 125,000, and D1 flips to `confirmed`. |
| 5 | Deposit 2, no stall | (running) | Around call 51, headroom drops under 100,000 and D2 goes out in the background (`  * deposit D2 started, in the background`). Line timing does not change. Then `limit=225,000` with `D2 9b7e…04 pending`, and after the next block `limit=250,000` with both confirmed. |
| 6 | Cheat run | Ctrl-C the honest run, then `scripts/demo.sh cheat` | See below. |
| 7 | Privacy | `scripts/demo.sh show <D1 txid>` | See below. |

The honest run takes about 160 s to finish. For a 3-minute video, let it run through beat 5 (about call 90, when D2 confirms), then press Ctrl-C once and wait for the agent to print `interrupted`.

Beat 4 as it looks in the log:

```
  * deposit 3f2a…c1 confirmed at height 121
#030 200  c=15,000  limit=125,000  conf=100,000  pend=0  credit=25,000  D1 3f2a…c1 confirmed
```

Beat 5 as it looks:

```
#055 200  c=27,500  limit=225,000  conf=100,000  pend=100,000  credit=25,000  D1 3f2a…c1 confirmed, D2 9b7e…04 pending
#080 200  c=40,000  limit=250,000  conf=200,000  pend=0  credit=50,000  D1 3f2a…c1 confirmed, D2 9b7e…04 confirmed
```

### Beat 6: the cheat run

The cheating agent makes one deposit and then refuses to make another. It runs with no pause between calls. It is a new session, so it makes its own D1.

1. About 200 calls fly by in seconds on D1 while it is still unconfirmed, ending at `c=100,000  limit=100,000`. Point at `conf=0  pend=100,000`: that is the merchant's zero-conf exposure, capped at one window.
2. The agent stops and prints `  * waiting for deposit 3f2a…c1 to confirm`. It waits for a block.
3. The block lands and the credit line opens (`limit=125,000`, `credit=25,000`). About 50 more calls run on credit, up to `c=125,000`.
4. The merchant refuses, and the run ends:

   ```
   #251 402  REFUSED z402_deposit_required at limit 125,000  c=125,000  conf=100,000  pend=0  credit=25,000  D1 3f2a…c1 confirmed
   stopped: the merchant refused at its credit limit, and the cheating agent has no deposit left to pay
   ```

Point at `REFUSED … at limit 125,000`. The most a cheater ever gets is one unconfirmed window plus the credit line.

### Beat 7: what the chain shows

`scripts/demo.sh show <txid>` needs the full 64-character txid, and the agent log only shows `3f2a…c1`. Get the full one before you start the take, from either place:

```bash
# the facilitator ledger holds each deposit's txid in full (empty output means use the next command)
grep -oh '3f2a[0-9a-f]\{58\}c1' .data/facilitator-ledger.regtest.jsonl | head -1

# or list the transactions of the block D1 was mined in (see "confirmed at height N")
node infra/z3/rpc.mjs zebra getblock '"N"' 1 | jq -r '.tx[]'
```

The command then does two things:

1. It fetches the raw transaction from Zebra and prints its size and the first bytes. This is all a block explorer has: ciphertext, with no plaintext amount and no address.
2. It decrypts the same bytes with the merchant's viewing key (the key is never printed) and prints the JSON. Point at `"pool": "ironwood"`, `"valueZat": 100000`, `"toPayTo": true` with the merchant `"recipient"`, and `"memoText"` of the form `<sessionKey>:1`, which ties the deposit to the agent's session.

The script uses `scripts/show-deposit.sh` when that file exists. Otherwise it runs the two raw commands itself (Zebra `getrawtransaction`, then `zdecrypt decrypt`).

## Expected timings

At p = 500 zat and one call per second (`docs/spec/protocol.md` section 12). These are estimates from the Z3 measurements in `docs/research/client/z3-live.md`, to be confirmed in the dry runs.

| Step | Time |
|---|---|
| D1 proved, sent and acknowledged (call 1) | 5 to 10 s after `honest` starts |
| D1 confirms | at most 25 s (clock) plus 5 s (facilitator poll) after the broadcast |
| Honest run, 150 calls | about 150 s of calls plus D1, so about 160 s |
| D2 goes out | around call 51, about 60 s in |
| Cheat run | about 10 s for D1, a few seconds for 200 calls, up to 30 s waiting for a block, a few seconds for the credit calls, so about 40 to 60 s |
| `show` | under 2 s |

## Troubleshooting

- **A ready line never appears.** `up` prints the last 20 lines of the log and exits 1. Read the whole log: `.data/demo/facilitator.log` or `.data/demo/api.log`. A startup error names the offending field or variable. Common causes:
  - Zaino not answering (`node infra/z3/lwd.mjs info`);
  - `zdecrypt` not built;
  - a port in use. `up` stops with the `lsof` command that finds the process.

  A process that is up but slow keeps running. Run `up` again to keep waiting, or `scripts/demo.sh down` to stop it.
- **`REFUSED z402_awaiting_confirmation` lingers.** The deposit is waiting for a block. Is the clock running? `scripts/demo.sh status` shows it, and `scripts/demo.sh clock` starts it.
- **The agent exits at preflight** with `the wallet has N zat spendable, the demo needs at least 250,000 zat`. Run `bash infra/z3/fund-agent.sh`, then `scripts/demo.sh status`.
- **`honest` or `cheat` says nothing listens on 4021 or 4022.** Run `scripts/demo.sh up`.
- **After `bash infra/z3/down.sh --wipe`.** The chain restarts from height 0, so the old ledger no longer matches. Run `scripts/demo.sh down --wipe-ledger`, then `scripts/demo.sh up`, then `bash infra/z3/fund-agent.sh`. The script never touches Docker, so it does not wipe the volumes itself.
- **`down` warns that a process ignored SIGINT.** It escalates to SIGTERM by itself. If it still cannot stop the process, it prints the `kill -9` command for the process group.

## Reset between takes

Nothing needs resetting. Each agent run is a new session with a new session key, no credit and its own D1, and the ledger keeps the old sessions, which is harmless. Leave the clock, facilitator and API running between takes.

- Check `scripts/demo.sh status` before each take. An honest take spends up to two deposits of 100,000 plus fees, a cheat take one. The change returns after a confirmation, so keep the clock running.
- Stop everything at the end of the day with `scripts/demo.sh down`. The chain and the wallet stay as they are.

## Files

| Path | What |
|---|---|
| `.data/demo/facilitator.log`, `api.log`, `clock.log` | Process output. Each log is truncated when its process starts. |
| `.data/demo/*.pid` | Pidfiles. Each pid is also the process group id. |
| `.data/demo/token` | The facilitator token, mode 600, generated once. |
| `.data/facilitator-ledger.regtest.jsonl` | The facilitator ledger. |
| `.secrets/merchant-regtest.json` | The merchant keys. The script never prints the viewing key. |

Ports: facilitator 4022, API 4021, Zebra 29232, Zallet 50232, Zaino 28137.
