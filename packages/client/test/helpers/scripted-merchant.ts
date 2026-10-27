import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { DEMO_TERMS, encodeTerms, NETWORK_REGTEST, SCHEME, type SessionSnapshot } from "@z402/protocol";
import { PAY_TO } from "../fixtures.js";

export type MerchantReply =
  | { kind: "settled"; session: SessionSnapshot; transaction?: string }
  | { kind: "refused"; code: string; session: SessionSnapshot }
  /** A 502 with neither x402 header, as when the facilitator times out after it settled */
  | { kind: "lost" };

export interface ScriptedMerchant {
  /** The one paid resource, e.g. `http://127.0.0.1:41234/chunk` */
  readonly url: string;
  /** Every request received so far, paid or not */
  readonly hops: number;
  close(): Promise<void>;
}

const PRICE = "500";

function entry(session?: SessionSnapshot): PaymentRequirements {
  return {
    scheme: SCHEME,
    network: NETWORK_REGTEST,
    amount: PRICE,
    asset: "ZEC",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: {
      ...encodeTerms(DEMO_TERMS),
      termsVersion: "0123456789abcdef",
      ...(session === undefined ? {} : { session }),
    },
  };
}

function envelope(url: string, error: string, session?: SessionSnapshot): PaymentRequired {
  return {
    x402Version: 2,
    error,
    resource: { url, description: "chunk", mimeType: "application/json" },
    accepts: [entry(session)],
  };
}

function send(res: ServerResponse, status: number, headers: Record<string, string>): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end("{}");
}

/**
 * A one-route x402 merchant driven by a script. An unpaid request gets a 402 carrying the protocol.md §2 entry.
 * Each paid request calls `respond(payload, n)`, where `n` counts paid requests from 1, and gets either a
 * 200 with `PAYMENT-RESPONSE`, a 402 whose `PAYMENT-REQUIRED` carries the refusal code and `extra.session`, or a
 * bare 502. The body is always `{}`.
 */
export async function startScriptedMerchant(
  respond: (payload: PaymentPayload, n: number) => MerchantReply,
): Promise<ScriptedMerchant> {
  let hops = 0;
  let paid = 0;
  let base = "";

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    hops += 1;
    const url = `${base}${req.url ?? "/"}`;
    const header = req.headers["payment-signature"];
    if (typeof header !== "string") {
      send(res, 402, { "payment-required": encodePaymentRequiredHeader(envelope(url, "Payment required")) });
      return;
    }
    const payload = decodePaymentSignatureHeader(header);
    paid += 1;
    const reply = respond(payload, paid);
    if (reply.kind === "lost") {
      send(res, 502, {});
      return;
    }
    if (reply.kind === "refused") {
      send(res, 402, {
        "payment-required": encodePaymentRequiredHeader(envelope(url, reply.code, reply.session)),
      });
      return;
    }
    send(res, 200, {
      "payment-response": encodePaymentResponseHeader({
        success: true,
        transaction: reply.transaction ?? "",
        network: NETWORK_REGTEST,
        payer: reply.session.sessionKey,
        amount: PRICE,
        extra: { session: reply.session },
      }),
    });
  };

  const server: Server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: `${base}/chunk`,
    get hops() {
      return hops;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err === undefined ? resolve() : reject(err)));
        // fetch keeps its sockets alive, and close() alone would wait for them
        server.closeAllConnections();
      }),
  };
}
