// JSON-RPC client for the Z3 regtest Zebra and Zallet endpoints. No dependencies, no import side effects.
// Import zebraRpc, zalletRpc, mineNow and ENDPOINTS, or run it as a CLI.
//   node infra/z3/rpc.mjs <zebra|zallet|url> <method> [param ...]
//   Each param is parsed as JSON when it parses, otherwise passed as a string.
//   A string result prints raw, anything else prints as JSON.
// URLs and credentials come from Z3_ZEBRA_RPC, Z3_ZALLET_RPC, Z3_ZAINO_GRPC, Z3_RPC_USER and Z3_RPC_PASSWORD.

export const ENDPOINTS = {
  zebraRpc: process.env.Z3_ZEBRA_RPC ?? "http://127.0.0.1:29232",
  zalletRpc: process.env.Z3_ZALLET_RPC ?? "http://127.0.0.1:50232",
  zainoGrpc: process.env.Z3_ZAINO_GRPC ?? "http://127.0.0.1:28137",
};

const USER = process.env.Z3_RPC_USER ?? "zebra";
const PASSWORD = process.env.Z3_RPC_PASSWORD ?? "zebra";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASSWORD}`).toString("base64");

const TARGETS = { zebra: ENDPOINTS.zebraRpc, zallet: ENDPOINTS.zalletRpc };

export class RpcError extends Error {
  constructor(label, method, error) {
    super(`${label} ${method}: ${error.code} ${error.message}`);
    this.code = error.code;
    this.data = error.data;
  }
}

export async function rpc(target, method, params = [], { timeoutMs = 300_000 } = {}) {
  const url = TARGETS[target] ?? target;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: AUTH },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${target} ${method}: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  if (body.error) throw new RpcError(target, method, body.error);
  return body.result;
}

export async function zebraRpc(method, params = []) {
  return rpc("zebra", method, params);
}

export async function zalletRpc(method, params = []) {
  return rpc("zallet", method, params);
}

export async function mineNow(n = 1) {
  await zebraRpc("generate", [n]);
  return Number(await zebraRpc("getblockcount", []));
}

if (import.meta.main) {
  const [target, method, ...raw] = process.argv.slice(2);
  if (!target || !method) {
    console.error("usage: node infra/z3/rpc.mjs <zebra|zallet|url> <method> [param ...]");
    process.exit(2);
  }
  const params = raw.map((p) => {
    try {
      return JSON.parse(p);
    } catch {
      return p;
    }
  });
  try {
    const result = await rpc(target, method, params);
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
