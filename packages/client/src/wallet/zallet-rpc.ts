import { TXID_RE, type DepositRequest, type ZcashWallet } from "@z402/protocol";
import { systemClock, type Clock } from "../clock.js";

const ZAT_PER_ZEC = 100_000_000n;
const INSUFFICIENT_RE = /insufficient/i;
const CONNECT_FAILURES: ReadonlySet<unknown> = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH"]);

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
  /** How long to wait for the operation and the ledger before DepositStatusUnknownError, default 300000 */
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

/** Zallet answered with a refusal or never took the connection, so the request started nothing */
class ZalletRefusedError extends ZalletRpcError {}

/** The deposit may or may not exist and no txid is known, so the caller must not pay again */
export class DepositStatusUnknownError extends ZalletRpcError {
  readonly memo: string;

  constructor(memo: string, options?: { cause?: unknown }) {
    super(`deposit status unknown for memo ${memo}`, options);
    this.name = "DepositStatusUnknownError";
    this.memo = memo;
  }
}

type Attempt = { txid: string } | { insufficient: string };

type OperationState =
  | { kind: "pending" }
  | { kind: "success"; txid: string | undefined }
  | { kind: "failed"; message: string; code: number | undefined }
  | { kind: "cancelled" }
  | { kind: "error"; cause: unknown };

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

function isConnectFailure(e: unknown): boolean {
  const cause = e instanceof Error ? e.cause : undefined;
  if (!isRecord(cause)) return false;
  const codes = Array.isArray(cause.errors) && cause.errors.length > 0 ? cause.errors.map((x: unknown) => (isRecord(x) ? x.code : undefined)) : [cause.code];
  return codes.every((code) => CONNECT_FAILURES.has(code));
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
    let opid: string | undefined;
    let cause: unknown;
    try {
      const result = await this.#call("z_sendmany", params);
      if (typeof result === "string" && result !== "") opid = result;
      else cause = new ZalletRpcError("z_sendmany did not return an operation id");
    } catch (e) {
      if (!(e instanceof ZalletRefusedError)) cause = e;
      else if (INSUFFICIENT_RE.test(e.message)) return { insufficient: e.message };
      else throw e;
    }
    return this.#settle(opid, memo, cause);
  }

  /** Waits for the operation and, once its outcome is in doubt, also looks for the deposit in the ledger by memo */
  async #settle(opid: string | undefined, memo: string, firstCause: unknown): Promise<Attempt> {
    const deadline = this.#clock.now() + this.#opTimeoutMs;
    let reconciling = opid === undefined;
    let lastError = firstCause;
    const lookup = async (): Promise<string | undefined> => {
      try {
        return (await this.findSentByMemo(memo))?.txid;
      } catch (e) {
        lastError = e;
        return undefined;
      }
    };

    for (;;) {
      if (opid !== undefined) {
        const op = await this.#pollOperation(opid);
        switch (op.kind) {
          case "success":
            if (op.txid !== undefined) return { txid: op.txid };
            // Reading the result spends it, so only the ledger can still say what happened
            opid = undefined;
            reconciling = true;
            lastError = new ZalletRpcError("operation succeeded without a txid");
            break;
          case "failed":
            if (INSUFFICIENT_RE.test(op.message)) return { insufficient: op.message };
            throw new ZalletRpcError(`Zallet operation failed: ${op.message}`, { code: op.code });
          case "cancelled":
            throw new ZalletRpcError("Zallet operation was cancelled and nothing was sent");
          case "error":
            reconciling = true;
            lastError = op.cause;
            break;
          case "pending":
            break;
        }
      }
      if (reconciling) {
        const txid = await lookup();
        if (txid !== undefined) return { txid };
      }
      const left = deadline - this.#clock.now();
      if (left <= 0) break;
      await this.#clock.sleep(Math.min(this.#opPollMs, left));
    }

    if (!reconciling) {
      const txid = await lookup();
      if (txid !== undefined) return { txid };
    }
    throw new DepositStatusUnknownError(memo, { cause: lastError });
  }

  async #pollOperation(opid: string): Promise<OperationState> {
    let entries: unknown;
    try {
      entries = await this.#call("z_getoperationresult", [[opid]]);
    } catch (cause) {
      return { kind: "error", cause };
    }
    if (!Array.isArray(entries)) {
      return { kind: "error", cause: new ZalletRpcError("z_getoperationresult did not return an array") };
    }
    const entry = entries.find((e): e is Record<string, unknown> => isRecord(e) && e.id === opid);
    // Unknown statuses count as still running
    switch (entry?.status) {
      case "success":
        return { kind: "success", txid: txidOf(entry.result) };
      case "failed":
        return { kind: "failed", ...failureOf(entry) };
      case "cancelled":
        return { kind: "cancelled" };
      default:
        return { kind: "pending" };
    }
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
      const message = `Zallet ${method}: ${describeFetchError(cause)}`;
      throw isConnectFailure(cause) ? new ZalletRefusedError(message, { cause }) : new ZalletRpcError(message, { cause });
    }

    if (status === 401) throw new ZalletRefusedError(`Zallet ${method}: HTTP 401 unauthorized`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ZalletRpcError(`Zallet ${method}: HTTP ${status} with a non-JSON body`);
    }
    if (isRecord(body) && body.error !== undefined && body.error !== null) {
      const error = isRecord(body.error) ? body.error : {};
      const message = typeof error.message === "string" ? error.message : "unknown error";
      throw new ZalletRefusedError(`Zallet ${method}: ${message}`, { code: typeof error.code === "number" ? error.code : undefined });
    }
    if (status < 200 || status >= 300) throw new ZalletRpcError(`Zallet ${method}: HTTP ${status}`);
    if (!isRecord(body) || !("result" in body)) throw new ZalletRpcError(`Zallet ${method}: response has no result`);
    return body.result;
  }
}
