import { TXID_RE, type DepositRequest, type ZcashWallet } from "@z402/protocol";
import { systemClock, type Clock } from "../clock.js";

const ZAT_PER_ZEC = 100_000_000n;
const INSUFFICIENT_RE = /insufficient/i;

export interface ZalletRpcWalletOptions {
  /** Zallet JSON-RPC endpoint, the regtest default is on port 50232 */
  url: string;
  user: string;
  password: string;
  /** Account uuid, defaults to the first entry of z_listaccounts */
  account?: string;
  /** Sending unified address, defaults to the account's Orchard-only address at diversifier index 1 */
  fromAddress?: string;
  clock?: Pick<Clock, "now" | "sleep">;
  /** Gap between z_getoperationresult polls, default 250 */
  opPollMs?: number;
  /** How long to wait for an operation before reconciling by memo, default 300000 */
  opTimeoutMs?: number;
  /** Retries after an insufficient-funds failure, default 3 */
  preBroadcastRetries?: number;
  /** Wait before each insufficient-funds retry, default 25000 */
  retryWaitMs?: number;
  /** Per-request network timeout, default 30000 */
  requestTimeoutMs?: number;
}

export class InsufficientFundsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InsufficientFundsError";
  }
}

export class ZalletRpcError extends Error {
  readonly code: number | undefined;

  constructor(message: string, options?: { code?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "ZalletRpcError";
    this.code = options?.code;
  }
}

/** The request never produced a readable HTTP answer, so the server may or may not have acted on it */
class ZalletTransportError extends ZalletRpcError {}

type Attempt = { txid: string } | { insufficient: string };

export interface SentTransaction {
  txid: string;
  minedHeight: number | null;
  expired: boolean;
}

/** Exact BigInt decimal conversion of zatoshi to a ZEC string, trimmed of trailing zeros */
export function zatToZecString(zat: bigint): string {
  if (zat < 0n) throw new RangeError("amount must not be negative");
  const whole = zat / ZAT_PER_ZEC;
  const fraction = (zat % ZAT_PER_ZEC).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function describeFetchError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const code = isRecord(e.cause) ? e.cause.code : undefined;
  return typeof code === "string" ? `${e.message} (${code})` : e.message;
}

function zatOf(v: unknown, what: string): bigint {
  if (v === undefined) return 0n;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^[0-9]+$/.test(v)) return BigInt(v);
  throw new ZalletRpcError(`${what} is not a zatoshi amount`);
}

function txidOf(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  const first = Array.isArray(result.txids) ? result.txids[0] : undefined;
  const id = result.txid ?? first;
  return typeof id === "string" && TXID_RE.test(id) ? id : undefined;
}

function failureOf(entry: Record<string, unknown>): { message: string; code: number | undefined } {
  const error = entry.error;
  if (typeof error === "string") return { message: error, code: undefined };
  if (isRecord(error)) {
    const message = typeof error.message === "string" ? error.message : "operation failed";
    return { message, code: typeof error.code === "number" ? error.code : undefined };
  }
  return { message: "operation failed", code: undefined };
}

function memoMatches(output: unknown, memo: string, memoHex: string): boolean {
  if (!isRecord(output) || typeof output.memo !== "string") return false;
  return output.memo === memo || output.memo.toLowerCase() === memoHex;
}

/** Regtest agent wallet that pays deposits through Zallet's JSON-RPC */
export class ZalletRpcWallet implements ZcashWallet {
  readonly #url: string;
  readonly #auth: string;
  readonly #clock: Pick<Clock, "now" | "sleep">;
  readonly #opPollMs: number;
  readonly #opTimeoutMs: number;
  readonly #retries: number;
  readonly #retryWaitMs: number;
  readonly #requestTimeoutMs: number;
  #account: Promise<string> | undefined;
  #from: Promise<string> | undefined;
  #nextId = 1;

  constructor(o: ZalletRpcWalletOptions) {
    this.#url = o.url;
    this.#auth = "Basic " + Buffer.from(`${o.user}:${o.password}`).toString("base64");
    this.#clock = o.clock ?? systemClock;
    this.#opPollMs = o.opPollMs ?? 250;
    this.#opTimeoutMs = o.opTimeoutMs ?? 300_000;
    this.#retries = o.preBroadcastRetries ?? 3;
    this.#retryWaitMs = o.retryWaitMs ?? 25_000;
    this.#requestTimeoutMs = o.requestTimeoutMs ?? 30_000;
    if (o.account !== undefined) this.#account = Promise.resolve(o.account);
    if (o.fromAddress !== undefined) this.#from = Promise.resolve(o.fromAddress);
  }

  async sendDeposit(req: DepositRequest): Promise<{ txid: string }> {
    const from = await this.#fromAddress();
    const memoHex = Buffer.from(req.memo, "utf8").toString("hex");
    const params = [from, [{ address: req.to, amount: zatToZecString(req.amountZat), memo: memoHex }], 1, null, "FullPrivacy"];

    for (let retry = 0; ; retry++) {
      const attempt = await this.#attempt(params, req.memo);
      if ("txid" in attempt) return attempt;
      if (retry >= this.#retries) throw new InsufficientFundsError(attempt.insufficient);
      await this.#clock.sleep(this.#retryWaitMs);
    }
  }

  async findSentByMemo(memo: string): Promise<SentTransaction | undefined> {
    const account = await this.#accountUuid();
    const rows = await this.#call("z_listtransactions", [account]);
    if (!Array.isArray(rows)) throw new ZalletRpcError("z_listtransactions did not return an array");

    const memoHex = Buffer.from(memo, "utf8").toString("hex");
    let best: SentTransaction | undefined;
    let bestRank = -Infinity;
    for (const row of rows) {
      if (!isRecord(row) || typeof row.txid !== "string" || !TXID_RE.test(row.txid)) continue;
      if (!Array.isArray(row.outputs) || !row.outputs.some((o) => memoMatches(o, memo, memoHex))) continue;
      const minedHeight = typeof row.mined_height === "number" ? row.mined_height : null;
      const expired = row.expired_unmined === true;
      // A dead transaction ranks below every live one and a pending one above every mined one
      const rank = expired ? -1 : (minedHeight ?? Infinity);
      if (rank >= bestRank) {
        best = { txid: row.txid, minedHeight, expired };
        bestRank = rank;
      }
    }
    return best;
  }

  async spendableBalance(): Promise<bigint> {
    const account = await this.#accountUuid();
    const balance = await this.#call("z_getbalanceforaccount", [account, 1]);
    const pools = isRecord(balance) && isRecord(balance.pools) ? balance.pools : {};
    // Immature coinbase is reported under transparent, so only the shielded pools count
    const pool = (name: string): bigint => zatOf(isRecord(pools[name]) ? pools[name].valueZat : undefined, `${name} valueZat`);
    return pool("ironwood") + pool("orchard");
  }

  async #attempt(params: unknown[], memo: string): Promise<Attempt> {
    let opid: unknown;
    try {
      opid = await this.#call("z_sendmany", params);
    } catch (e) {
      if (e instanceof ZalletRpcError && !(e instanceof ZalletTransportError) && INSUFFICIENT_RE.test(e.message)) {
        return { insufficient: e.message };
      }
      throw e;
    }
    if (typeof opid !== "string" || opid === "") throw new ZalletRpcError("z_sendmany did not return an operation id");
    return this.#awaitOperation(opid, memo);
  }

  async #awaitOperation(opid: string, memo: string): Promise<Attempt> {
    const deadline = this.#clock.now() + this.#opTimeoutMs;
    for (;;) {
      let entry: Record<string, unknown> | undefined;
      try {
        entry = await this.#operationResult(opid);
      } catch (cause) {
        return this.#reconcile(memo, cause);
      }

      if (entry?.status === "success") {
        const txid = txidOf(entry.result);
        return txid === undefined ? this.#reconcile(memo, new ZalletRpcError("operation succeeded without a txid")) : { txid };
      }
      if (entry?.status === "failed") {
        const { message, code } = failureOf(entry);
        if (INSUFFICIENT_RE.test(message)) return { insufficient: message };
        throw new ZalletRpcError(`Zallet operation failed: ${message}`, { code });
      }

      const left = deadline - this.#clock.now();
      if (left <= 0) return this.#reconcile(memo);
      await this.#clock.sleep(Math.min(this.#opPollMs, left));
    }
  }

  /** The operation entry, or undefined while Zallet has no final answer for it */
  async #operationResult(opid: string): Promise<Record<string, unknown> | undefined> {
    const entries = await this.#call("z_getoperationresult", [[opid]]);
    if (!Array.isArray(entries)) throw new ZalletRpcError("z_getoperationresult did not return an array");
    return entries.find((e): e is Record<string, unknown> => isRecord(e) && e.id === opid);
  }

  /** Zallet drops a finished operation once it is read, so a lost reply is only recoverable from the ledger */
  async #reconcile(memo: string, cause?: unknown): Promise<Attempt> {
    let found: SentTransaction | undefined;
    try {
      found = await this.findSentByMemo(memo);
    } catch (e) {
      throw new ZalletRpcError("deposit status unknown", { cause: e });
    }
    if (found === undefined) throw new ZalletRpcError("deposit status unknown", { cause });
    return { txid: found.txid };
  }

  #accountUuid(): Promise<string> {
    this.#account ??= this.#lookupAccount().catch((e: unknown) => {
      this.#account = undefined;
      throw e;
    });
    return this.#account;
  }

  #fromAddress(): Promise<string> {
    this.#from ??= this.#lookupFromAddress().catch((e: unknown) => {
      this.#from = undefined;
      throw e;
    });
    return this.#from;
  }

  async #lookupAccount(): Promise<string> {
    const accounts = await this.#call("z_listaccounts", []);
    const first = Array.isArray(accounts) ? accounts[0] : undefined;
    const uuid = isRecord(first) ? (first.account_uuid ?? first.uuid) : undefined;
    if (typeof uuid !== "string" || uuid === "") throw new ZalletRpcError("Zallet has no account");
    return uuid;
  }

  async #lookupFromAddress(): Promise<string> {
    const account = await this.#accountUuid();
    // Index 0 is a mixed-receiver address on Z3 and refuses an Orchard-only request
    const result = await this.#call("z_getaddressforaccount", [account, ["orchard"], 1]);
    const address = isRecord(result) ? result.address : undefined;
    if (typeof address !== "string" || address === "") throw new ZalletRpcError("z_getaddressforaccount returned no address");
    return address;
  }

  async #call(method: string, params: unknown[]): Promise<unknown> {
    let status: number;
    let text: string;
    try {
      const res = await fetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: this.#auth },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.#nextId++, method, params }),
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
      status = res.status;
      text = await res.text();
    } catch (cause) {
      throw new ZalletTransportError(`Zallet ${method}: ${describeFetchError(cause)}`, { cause });
    }

    if (status === 401) throw new ZalletRpcError(`Zallet ${method}: HTTP 401 unauthorized`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ZalletRpcError(`Zallet ${method}: HTTP ${status} with a non-JSON body`);
    }
    if (isRecord(body) && body.error !== undefined && body.error !== null) {
      const error = isRecord(body.error) ? body.error : {};
      const message = typeof error.message === "string" ? error.message : "unknown error";
      throw new ZalletRpcError(`Zallet ${method}: ${message}`, { code: typeof error.code === "number" ? error.code : undefined });
    }
    if (status < 200 || status >= 300) throw new ZalletRpcError(`Zallet ${method}: HTTP ${status}`);
    if (!isRecord(body) || !("result" in body)) throw new ZalletRpcError(`Zallet ${method}: response has no result`);
    return body.result;
  }
}
