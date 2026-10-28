import { TXID_RE, type DepositRequest, type ZcashWallet } from "@z402-net/protocol";
import { systemClock, type Clock } from "../clock.js";
import { DepositStatusUnknownError, ZalletRpcError } from "../errors.js";
import { Mutex } from "../mutex.js";

const ZAT_PER_ZEC = 100_000_000n;
const INSUFFICIENT_RE = /insufficient/i;
const CONNECT_FAILURES: ReadonlySet<unknown> = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH"]);
const DIVERSIFIER_REUSE_CODE = -4;
const DIVERSIFIER_REUSE_RE = /already generated with different receiver types/;
const FIRST_AGENT_DIVERSIFIER = 1;
const LAST_AGENT_DIVERSIFIER = 16;

export interface ZalletRpcWalletOptions {
  /** Zallet JSON-RPC endpoint, the regtest default is on port 50232 */
  url: string;
  user: string;
  password: string;
  /** Account uuid, defaults to the first entry of z_listaccounts */
  account?: string;
  /** Sending unified address, defaults to the account's Orchard-only address at the lowest diversifier index >= 1 that accepts one */
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

/** Zallet answered with a refusal or never took the connection, so the request started nothing */
class ZalletRefusedError extends ZalletRpcError {}

type Attempt = { txid: string } | { insufficient: string };

type OperationState =
  | { kind: "running" }
  | { kind: "lost" }
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

/** Zallet's DiversifierIndexReuse, JSON-RPC code -4 with a message that #call carries over into the error message */
function isDiversifierReuse(e: unknown): boolean {
  return e instanceof ZalletRpcError && e.code === DIVERSIFIER_REUSE_CODE && DIVERSIFIER_REUSE_RE.test(e.message);
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
  /** One z_sendmany at a time, held until its operation settles, so deposits to two payees never pick the same notes */
  readonly #sending = new Mutex();
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
      const release = await this.#sending.acquire();
      let attempt: Attempt;
      try {
        attempt = await this.#attempt(params, req.memo);
      } finally {
        release();
      }
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
    /** What a ledger answer without our row concludes once the operation cannot report any more */
    let noRow: Error | undefined;
    const lookup = async (): Promise<{ txid: string } | "none" | "error"> => {
      try {
        const found = await this.findSentByMemo(memo);
        return found === undefined ? "none" : { txid: found.txid };
      } catch (e) {
        lastError = e;
        return "error";
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
            // A failure while broadcasting can leave a stored transaction that still mines
            opid = undefined;
            reconciling = true;
            noRow = new ZalletRpcError(`Zallet operation failed: ${op.message}`, { code: op.code });
            lastError = noRow;
            break;
          case "cancelled":
            throw new ZalletRpcError("Zallet operation was cancelled and nothing was sent");
          case "lost":
            // Nothing is left to report, so only the ledger can say whether it was sent
            lastError = new ZalletRpcError(`Zallet no longer knows operation ${opid}`);
            noRow = new DepositStatusUnknownError(memo, { cause: lastError });
            opid = undefined;
            reconciling = true;
            break;
          case "error":
            reconciling = true;
            lastError = op.cause;
            break;
          case "running":
            // A poll error earlier is behind us once the op is seen again, and the deadline lookup still covers it
            reconciling = false;
            break;
        }
      }
      if (reconciling) {
        const found = await lookup();
        if (typeof found === "object") return found;
        if (found === "none" && noRow !== undefined) throw noRow;
      }
      const left = deadline - this.#clock.now();
      if (left <= 0) break;
      await this.#clock.sleep(Math.min(this.#opPollMs, left));
    }

    if (!reconciling) {
      const found = await lookup();
      if (typeof found === "object") return found;
    }
    throw new DepositStatusUnknownError(memo, { cause: lastError });
  }

  /** z_getoperationresult lists an operation only once it has finished, and forgets it once listed */
  async #pollOperation(opid: string): Promise<OperationState> {
    const entry = await this.#operationEntry("z_getoperationresult", opid);
    if (entry instanceof ZalletRpcError) return { kind: "error", cause: entry };
    if (entry === undefined) {
      // An empty result is normal while the operation runs, and only z_getoperationstatus tells it from a lost opid
      const status = await this.#operationEntry("z_getoperationstatus", opid);
      if (status instanceof ZalletRpcError) return { kind: "error", cause: status };
      return status === undefined ? { kind: "lost" } : { kind: "running" };
    }
    // Unknown statuses count as still running
    switch (entry.status) {
      case "success":
        return { kind: "success", txid: txidOf(entry.result) };
      case "failed":
        return { kind: "failed", ...failureOf(entry) };
      case "cancelled":
        return { kind: "cancelled" };
      default:
        return { kind: "running" };
    }
  }

  /** The entry for `opid`, undefined when the method does not list it, or the error that kept it from answering */
  async #operationEntry(method: string, opid: string): Promise<Record<string, unknown> | undefined | ZalletRpcError> {
    let entries: unknown;
    try {
      entries = await this.#call(method, [[opid]]);
    } catch (e) {
      return e instanceof ZalletRpcError ? e : new ZalletRpcError(`Zallet ${method}: ${String(e)}`, { cause: e });
    }
    if (!Array.isArray(entries)) return new ZalletRpcError(`${method} did not return an array`);
    return entries.find((e): e is Record<string, unknown> => isRecord(e) && e.id === opid);
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
    // The default address takes the first Sapling-valid index, which varies by seed and refuses an Orchard-only request
    for (let index = FIRST_AGENT_DIVERSIFIER; index <= LAST_AGENT_DIVERSIFIER; index++) {
      let result: unknown;
      try {
        result = await this.#call("z_getaddressforaccount", [account, ["orchard"], index]);
      } catch (e) {
        if (isDiversifierReuse(e)) continue;
        throw e;
      }
      const address = isRecord(result) ? result.address : undefined;
      if (typeof address !== "string" || address === "") throw new ZalletRpcError("z_getaddressforaccount returned no address");
      return address;
    }
    throw new ZalletRpcError(
      `Zallet has no Orchard-only address at diversifier indices ${FIRST_AGENT_DIVERSIFIER} to ${LAST_AGENT_DIVERSIFIER}, pass fromAddress`,
    );
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
      const error = body.error;
      // Only Zallet's own JSON-RPC error object is a refusal, a proxy in between may answer any other shape
      if (isRecord(error) && typeof error.code === "number") {
        const message = typeof error.message === "string" ? error.message : "unknown error";
        throw new ZalletRefusedError(`Zallet ${method}: ${message}`, { code: error.code });
      }
      throw new ZalletRpcError(`Zallet ${method}: HTTP ${status} with a non-JSON-RPC error ${JSON.stringify(error).slice(0, 200)}`);
    }
    if (status < 200 || status >= 300) throw new ZalletRpcError(`Zallet ${method}: HTTP ${status}`);
    if (!isRecord(body) || !("result" in body)) throw new ZalletRpcError(`Zallet ${method}: response has no result`);
    return body.result;
  }
}
