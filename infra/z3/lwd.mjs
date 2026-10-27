// gRPC probe for Zaino's lightwalletd-compatible endpoint (plaintext h2c).
// Needs .tools/grpc-probe and .tools/lightwallet-protocol, both installed by up.sh.
// node infra/z3/lwd.mjs info | latest | block <height> | tx <txid-hex>
// Errors print as JSON {code, codeName, details} on stdout and exit 3.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ENDPOINTS } from "./rpc.mjs";

const tools = fileURLToPath(new URL("../../.tools/", import.meta.url));
const require = createRequire(tools + "grpc-probe/package.json");
const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");

const ENDPOINT = ENDPOINTS.zainoGrpc.replace(/^https?:\/\//, "");

const def = loader.loadSync("service.proto", {
  includeDirs: [tools + "lightwallet-protocol/walletrpc"],
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const { CompactTxStreamer } = grpc.loadPackageDefinition(def).cash.z.wallet.sdk.rpc;
const client = new CompactTxStreamer(ENDPOINT, grpc.credentials.createInsecure());

const call = (method, req) =>
  new Promise((resolve, reject) =>
    client[method](req, { deadline: Date.now() + 30_000 }, (err, res) => (err ? reject(err) : resolve(res))),
  );

const reverseHex = (hex) => Buffer.from(hex, "hex").reverse();

async function run(cmd, arg) {
  switch (cmd) {
    case "info":
      return call("GetLightdInfo", {});
    case "latest": {
      const b = await call("GetLatestBlock", {});
      return { height: b.height, hash: Buffer.from(b.hash).reverse().toString("hex") };
    }
    case "block": {
      const b = await call("GetBlock", { height: arg });
      return {
        height: b.height,
        hash: Buffer.from(b.hash).reverse().toString("hex"),
        txids: b.vtx.map((t) => Buffer.from(t.txid).reverse().toString("hex")),
      };
    }
    case "tx": {
      if (!/^[0-9a-f]{64}$/i.test(arg ?? "")) throw new Error("tx needs a 64-hex txid");
      const t = await call("GetTransaction", { hash: reverseHex(arg) });
      const data = Buffer.from(t.data);
      return {
        height: t.height,
        bytes: data.length,
        header: data.length >= 20 ? data.subarray(0, 4).toString("hex") : null,
        expiryHeight: data.length >= 20 ? data.readUInt32LE(16) : null,
      };
    }
    default:
      console.error("usage: node infra/z3/lwd.mjs info | latest | block <height> | tx <txid-hex>");
      process.exit(2);
  }
}

const [cmd, arg] = process.argv.slice(2);
try {
  console.log(JSON.stringify(await run(cmd, arg), null, 2));
  client.close();
} catch (err) {
  client.close();
  if (err.code === undefined) {
    console.error(err.message);
    process.exit(1);
  }
  console.log(JSON.stringify({ code: err.code, codeName: grpc.status[err.code], details: err.details }, null, 2));
  process.exit(3);
}
