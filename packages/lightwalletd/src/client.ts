import { fileURLToPath } from "node:url";
import {
  credentials,
  loadPackageDefinition,
  status,
  type CallOptions,
  type ChannelCredentials,
  type ChannelOptions,
  type Client,
  type ServiceError,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { ChainUnavailableError } from "@z402/protocol";
import { txidToFilterHash } from "./txid.js";

/** height is set only when location is mined */
export type RawTx =
  | { found: false }
  | { found: true; raw: Uint8Array; location: "mempool" | "mined" | "orphaned"; height: number | null };

export interface LightdInfo {
  chainName: string;
  consensusBranchId: string;
  blockHeight: number;
  version: string;
}

export interface LightwalletdClient {
  getTip(): Promise<number>;
  /** Rejects with TypeError unless txid is 64 lowercase hex in display order */
  getTransaction(txid: string): Promise<RawTx>;
  getLightdInfo(): Promise<LightdInfo>;
  close(): void;
}

interface RawTransactionMsg {
  data: Buffer;
  height: string;
}
interface BlockIdMsg {
  height: string;
}
interface LightdInfoMsg {
  chainName: string;
  consensusBranchId: string;
  blockHeight: string;
  version: string;
}

type UnaryCallback<T> = (err: ServiceError | null, res: T) => void;

interface Stub extends Client {
  GetTransaction(req: { hash: Buffer }, options: CallOptions, done: UnaryCallback<RawTransactionMsg>): void;
  GetLatestBlock(req: object, options: CallOptions, done: UnaryCallback<BlockIdMsg>): void;
  GetLightdInfo(req: object, options: CallOptions, done: UnaryCallback<LightdInfoMsg>): void;
}

type StubConstructor = new (address: string, creds: ChannelCredentials, options?: ChannelOptions) => Stub;

const PROTO = fileURLToPath(new URL("../proto/service.proto", import.meta.url));

const definition = loadSync(PROTO, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
const { CompactTxStreamer } = (
  loadPackageDefinition(definition) as unknown as {
    cash: { z: { wallet: { sdk: { rpc: { CompactTxStreamer: StubConstructor } } } } };
  }
).cash.z.wallet.sdk.rpc;

const DEFAULT_RPC_DEADLINE_MS = 5000;
const MAX_RPC_DEADLINE_MS = 2_147_483_647;
// grpc-js defaults to a reconnect backoff of up to 120 s, which keeps a restarted server out of reach for minutes
const MAX_RECONNECT_BACKOFF_MS = 5000;
const MEMPOOL_HEIGHT = "0";
// 2^64 - 1 marks a transaction mined on a fork that is not the main chain
const FORK_HEIGHT = "18446744073709551615";

const LIGHTWALLETD_NOT_FOUND = "-5: Transaction not found in mempool or best chain";
const ZAINO_NOT_FOUND = 'LegacyRpcError { code: -5, message: "No such mempool or main chain transaction" }';
// The loosest of the three, accepted because Zebra 6.4+ built-in gRPC sends this bare text with no RPC code to anchor on
const ZEBRA_NOT_FOUND = "transaction not found";

// lightwalletd answers NOT_FOUND for every getrawtransaction failure so only the message tells them apart
export function isDefinitiveNotFound(e: { code: number; details: string }): boolean {
  switch (e.code) {
    case status.NOT_FOUND:
      return e.details.includes(LIGHTWALLETD_NOT_FOUND) || e.details.includes(ZEBRA_NOT_FOUND);
    case status.INTERNAL:
      return e.details.includes(ZAINO_NOT_FOUND);
    default:
      return false;
  }
}

function isServiceError(e: unknown): e is ServiceError {
  return (
    e instanceof Error &&
    "code" in e &&
    typeof e.code === "number" &&
    "details" in e &&
    typeof e.details === "string"
  );
}

function unavailable(rpc: string, cause: unknown): ChainUnavailableError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new ChainUnavailableError(`lightwalletd ${rpc} failed: ${detail}`, { cause });
}

function connectionFor(url: string): { target: string; creds: ChannelCredentials } {
  const parsed = URL.canParse(url) ? new URL(url) : null;
  if (parsed?.protocol === "https:") {
    return { target: `${parsed.hostname}:${parsed.port || 443}`, creds: credentials.createSsl() };
  }
  if (parsed?.protocol === "http:") {
    return { target: `${parsed.hostname}:${parsed.port || 80}`, creds: credentials.createInsecure() };
  }
  throw new TypeError("url must be an http:// or https:// URL");
}

function located(raw: Uint8Array, height: string): RawTx {
  if (height === MEMPOOL_HEIGHT) return { found: true, raw, location: "mempool", height: null };
  if (height === FORK_HEIGHT) return { found: true, raw, location: "orphaned", height: null };
  return { found: true, raw, location: "mined", height: Number(height) };
}

export function createLightwalletdClient(o: { url: string; rpcDeadlineMs?: number }): LightwalletdClient {
  const { target, creds } = connectionFor(o.url);
  const deadlineMs = o.rpcDeadlineMs ?? DEFAULT_RPC_DEADLINE_MS;
  // Under 1 ms no call can finish in time, and past 2^31 - 1 ms grpc-js drops the deadline, so a call can hang
  if (!Number.isFinite(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_RPC_DEADLINE_MS) {
    throw new TypeError("rpcDeadlineMs must be a finite number of milliseconds, from 1 to 2147483647");
  }
  const stub = new CompactTxStreamer(target, creds, { "grpc.max_reconnect_backoff_ms": MAX_RECONNECT_BACKOFF_MS });

  const call = <T>(invoke: (options: CallOptions, done: UnaryCallback<T>) => void): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      invoke({ deadline: Date.now() + deadlineMs }, (err, res) => (err ? reject(err) : resolve(res)));
    });

  return {
    async getTip() {
      try {
        const block = await call<BlockIdMsg>((options, done) => stub.GetLatestBlock({}, options, done));
        return Number(block.height);
      } catch (e) {
        throw unavailable("GetLatestBlock", e);
      }
    },

    async getTransaction(txid) {
      const hash = txidToFilterHash(txid);
      let reply: RawTransactionMsg;
      try {
        reply = await call<RawTransactionMsg>((options, done) =>
          stub.GetTransaction({ hash }, options, done),
        );
      } catch (e) {
        if (isServiceError(e) && isDefinitiveNotFound(e)) return { found: false };
        throw unavailable("GetTransaction", e);
      }
      if (reply.data.length === 0) {
        throw new ChainUnavailableError("lightwalletd GetTransaction returned no transaction data");
      }
      return located(new Uint8Array(reply.data), reply.height);
    },

    async getLightdInfo() {
      try {
        const info = await call<LightdInfoMsg>((options, done) => stub.GetLightdInfo({}, options, done));
        return {
          chainName: info.chainName,
          consensusBranchId: info.consensusBranchId,
          blockHeight: Number(info.blockHeight),
          version: info.version,
        };
      } catch (e) {
        throw unavailable("GetLightdInfo", e);
      }
    },

    close() {
      stub.close();
    },
  };
}
