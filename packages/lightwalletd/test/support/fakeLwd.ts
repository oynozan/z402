import { fileURLToPath } from "node:url";
import {
  loadPackageDefinition,
  Server,
  ServerCredentials,
  status,
  type handleUnaryCall,
  type ServiceClientConstructor,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";

const PROTO = fileURLToPath(new URL("../../proto/service.proto", import.meta.url));

const definition = loadSync(PROTO, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const { CompactTxStreamer } = (
  loadPackageDefinition(definition) as unknown as {
    cash: { z: { wallet: { sdk: { rpc: { CompactTxStreamer: ServiceClientConstructor } } } } };
  }
).cash.z.wallet.sdk.rpc;

interface TxFilter {
  hash: Buffer;
}
interface RawTransaction {
  data: Uint8Array;
  height: string;
}
interface BlockID {
  height: string;
}
type LightdInfo = Record<string, string | boolean>;

export interface FakeStatus {
  code: number;
  details: string;
}

export type TxScript =
  | { tx: RawTransaction; delayMs?: number }
  | { fail: FakeStatus };

export interface FakeLwdScript {
  /** Keyed by display txid, the way a block explorer prints it */
  txs?: Record<string, TxScript>;
  latestBlock?: BlockID | { fail: FakeStatus };
  lightdInfo?: LightdInfo | { fail: FakeStatus };
}

export interface FakeCall {
  rpc: "GetTransaction" | "GetLatestBlock" | "GetLightdInfo";
  remainingMs: number;
  hash: Buffer | null;
}

export interface FakeLwd {
  url: string;
  calls: FakeCall[];
  close(): void;
}

function isFail(entry: object): entry is { fail: FakeStatus } {
  return "fail" in entry;
}

export async function startFakeLwd(script: FakeLwdScript = {}): Promise<FakeLwd> {
  const calls: FakeCall[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const remainingMs = (deadline: Date | number): number => Number(deadline) - Date.now();

  const getTransaction: handleUnaryCall<TxFilter, RawTransaction> = (call, callback) => {
    const hash = Buffer.from(call.request.hash);
    calls.push({ rpc: "GetTransaction", remainingMs: remainingMs(call.getDeadline()), hash });
    // lightwalletd takes the hash in protocol order and reverses it to the display txid
    const txid = Buffer.from(hash).reverse().toString("hex");
    const entry = script.txs?.[txid];
    if (entry === undefined) {
      callback({ code: status.FAILED_PRECONDITION, details: `fakeLwd has nothing scripted for ${txid}` });
    } else if (isFail(entry)) {
      callback(entry.fail);
    } else if (entry.delayMs === undefined) {
      callback(null, entry.tx);
    } else {
      const timer = setTimeout(() => {
        timers.delete(timer);
        callback(null, entry.tx);
      }, entry.delayMs);
      timers.add(timer);
    }
  };

  const getLatestBlock: handleUnaryCall<object, BlockID> = (call, callback) => {
    calls.push({ rpc: "GetLatestBlock", remainingMs: remainingMs(call.getDeadline()), hash: null });
    const entry = script.latestBlock;
    if (entry === undefined) {
      callback({ code: status.FAILED_PRECONDITION, details: "fakeLwd has no latestBlock scripted" });
    } else if (isFail(entry)) {
      callback(entry.fail);
    } else {
      callback(null, entry);
    }
  };

  const getLightdInfo: handleUnaryCall<object, LightdInfo> = (call, callback) => {
    calls.push({ rpc: "GetLightdInfo", remainingMs: remainingMs(call.getDeadline()), hash: null });
    const entry = script.lightdInfo;
    if (entry === undefined) {
      callback({ code: status.FAILED_PRECONDITION, details: "fakeLwd has no lightdInfo scripted" });
    } else if (isFail(entry)) {
      callback(entry.fail);
    } else {
      callback(null, entry);
    }
  };

  const server = new Server();
  server.addService(CompactTxStreamer.service, {
    GetTransaction: getTransaction,
    GetLatestBlock: getLatestBlock,
    GetLightdInfo: getLightdInfo,
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (err, bound) =>
      err ? reject(err) : resolve(bound),
    );
  });

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.forceShutdown();
    },
  };
}
