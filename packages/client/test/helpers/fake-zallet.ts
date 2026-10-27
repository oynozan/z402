import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const ACCOUNT = "d44e7d71-5369-4d30-9de2-e283410a3bc5";
export const AGENT_UA = "uregtest1p23sr3mcska98d06rvw5lwmn3scys95duv73xm3zywpqemwf7xa6t7zzlj32f7gpl2xegjl0rkazpjz3qjw2zrn3ere2myta35c7esty";
export const OPID = "opid-711ebc8f-41a5-466f-9e3e-e4a3cabe4267";
export const USER = "zebra";
export const PASSWORD = "zebra";

export interface RecordedRequest {
  method: string;
  params: unknown;
  authorization: string | undefined;
}

export type Reply =
  | { result: unknown }
  | { error: { code: number; message: string } }
  | { status: number; body: string }
  | { hang: true }
  | { drop: true };

type Script = Reply | ((params: unknown) => Reply);

/** Per-method scripts hand out their replies in order and repeat the last one */
export interface FakeZallet {
  readonly url: string;
  readonly requests: RecordedRequest[];
  on(method: string, ...replies: Script[]): void;
  /** Scripts z_getoperationresult and z_getoperationstatus for one operation that runs, finishes and is then read once */
  runOperation(o: { finish: unknown; runningPolls?: number; opid?: string }): void;
  calls(method: string): RecordedRequest[];
  close(): Promise<void>;
}

const CREATED = 1_700_000_000;

/** Zallet's `OperationStatus` (zallet-core asyncop.rs `to_status`), as z_getoperationstatus and z_getoperationresult return it */
export function opSuccess(txid: string, opid = OPID): unknown {
  return { id: opid, method: "z_sendmany", status: "success", creation_time: CREATED, result: { txid, txids: [txid] }, execution_secs: 9 };
}

/** Only z_getoperationstatus ever shows a running operation, z_getoperationresult lists finished ones alone */
export function opRunning(status: "queued" | "executing" = "executing", opid = OPID): unknown {
  return { id: opid, method: "z_sendmany", status, creation_time: CREATED };
}

export function opFailed(code: number, message: string, opid = OPID): unknown {
  return { id: opid, method: "z_sendmany", status: "failed", creation_time: CREATED, error: { code, message } };
}

export interface TxRowInit {
  txid: string;
  minedHeight?: number | null;
  expiredUnmined?: boolean;
  outputs?: { memo: string | null; isChange?: boolean }[];
}

export function txRow(init: TxRowInit): unknown {
  const minedHeight = init.minedHeight === undefined ? 114 : init.minedHeight;
  return {
    account_uuid: ACCOUNT,
    mined_height: minedHeight,
    txid: init.txid,
    expiry_height: 154,
    account_balance_delta: -125_000,
    fee_paid: 25_000,
    expired_unmined: init.expiredUnmined ?? false,
    outputs: [
      {
        pool: "ironwood",
        output_index: 0,
        from_account: ACCOUNT,
        to_account: ACCOUNT,
        to_address: null,
        value: 1_562_453_750,
        is_change: true,
        memo: null,
      },
      ...(init.outputs ?? []).map((o, i) => ({
        pool: "ironwood",
        output_index: i + 1,
        from_account: ACCOUNT,
        to_account: null,
        to_address: "uregtest1etwrjmjldyyet5pge876dfxerpgmsmarxg920s50y3dgc3wa36xmemqexfyw87jm3h0cttupk92qkrv8uafvjrl2j73d8nck7g35axkz",
        value: 100_000,
        is_change: o.isChange ?? false,
        memo: o.memo,
      })),
    ],
  };
}

function defaults(): Map<string, Script[]> {
  return new Map<string, Script[]>([
    [
      "z_listaccounts",
      [
        {
          result: [
            {
              account_uuid: ACCOUNT,
              name: "Default account",
              zip32_account_index: 0,
              account: 0,
              addresses: [{ diversifier_index: 1, ua: AGENT_UA }],
            },
          ],
        },
      ],
    ],
    [
      "z_getaddressforaccount",
      [
        {
          result: {
            account_uuid: ACCOUNT,
            diversifier_index: 1,
            receiver_types: ["orchard"],
            address: AGENT_UA,
          },
        },
      ],
    ],
    ["z_getbalanceforaccount", [{ result: { pools: { transparent: { valueZat: 62_500_000_000 }, ironwood: { valueZat: 6_249_805_000 } }, minimum_confirmations: 1 } }]],
    ["z_listtransactions", [{ result: [] }]],
    ["z_sendmany", [{ result: OPID }]],
  ]);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** An in-process JSON-RPC server that records every request and answers from per-method scripts */
export async function startFakeZallet(): Promise<FakeZallet> {
  const scripts = defaults();
  const cursors = new Map<string, number>();
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as { id: unknown; method: string; params: unknown };
      requests.push({ method: body.method, params: body.params, authorization: req.headers.authorization });

      const queue = scripts.get(body.method);
      let reply: Reply = { error: { code: -32601, message: "Method not found" } };
      if (queue !== undefined && queue.length > 0) {
        const at = cursors.get(body.method) ?? 0;
        cursors.set(body.method, at + 1);
        const script = queue[Math.min(at, queue.length - 1)]!;
        reply = typeof script === "function" ? script(body.params) : script;
      }

      if ("hang" in reply) return;
      if ("drop" in reply) {
        req.socket.destroy();
        return;
      }
      if ("status" in reply) {
        res.writeHead(reply.status, { "content-type": "text/plain" }).end(reply.body);
        return;
      }
      const payload = "error" in reply ? { jsonrpc: "2.0", id: body.id, error: reply.error } : { jsonrpc: "2.0", id: body.id, result: reply.result };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const on = (method: string, ...replies: Script[]): void => {
    scripts.set(method, replies);
    cursors.set(method, 0);
  };
  const asks = (params: unknown, opid: string): boolean =>
    Array.isArray(params) && Array.isArray(params[0]) && (params[0] as unknown[]).includes(opid);

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    on,
    runOperation({ finish, runningPolls = 0, opid = OPID }) {
      let running = runningPolls;
      let read = false;
      // z_getoperationresult only returns a finished operation, and forgets it once returned (get_operation.rs)
      on("z_getoperationresult", (params) => {
        if (!asks(params, opid)) return { result: [] };
        if (running > 0) {
          running -= 1;
          return { result: [] };
        }
        if (read) return { result: [] };
        read = true;
        return { result: [finish] };
      });
      on("z_getoperationstatus", (params) => {
        if (!asks(params, opid) || read) return { result: [] };
        return { result: [running > 0 ? opRunning("executing", opid) : finish] };
      });
    },
    calls: (method) => requests.filter((r) => r.method === method),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
