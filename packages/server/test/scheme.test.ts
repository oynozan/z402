import {
  FacilitatorCapabilityError,
  x402ResourceServer,
  type FacilitatorClient,
  type ResourceConfig,
} from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  Price,
  ResourceInfo,
  SchemePaymentRequiredContext,
  SupportedKind,
  VerifyResponse,
} from "@x402/core/types";
import {
  ASSET,
  NETWORK_MAINNET,
  NETWORK_REGTEST,
  NETWORK_TESTNET,
  parseSessionSnapshot,
  REASON,
  SCHEME,
  type SessionSnapshot,
} from "@z402-net/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { PrepaidVoucherServerScheme, TERM_KEYS } from "../src/index.js";

const NETWORK = NETWORK_REGTEST;
const PAY_TO = `uregtest1${"q".repeat(60)}`;
const OTHER_PAY_TO = `uregtest1${"p".repeat(60)}`;
const TERMS_VERSION = "0123456789abcdef";

/** What the facilitator puts in its /supported kind since protocol v2.0, the five terms and no payTo */
const ADVERTISED = {
  windowZat: "100000",
  creditRatioBps: 2500,
  creditCapZat: "200000",
  zeroConfMinExpiryBlocks: 20,
  termsVersion: TERMS_VERSION,
};

/** What an older facilitator put there, which still carries its operator's payTo */
const WITH_PAY_TO = { ...ADVERTISED, payTo: OTHER_PAY_TO };

const REQ: PaymentRequirements = {
  scheme: SCHEME,
  network: NETWORK,
  asset: ASSET,
  amount: "500",
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: {},
};

const RESOURCE: ResourceInfo = { url: "http://127.0.0.1:4021/chunk" };

const SNAP: SessionSnapshot = {
  sessionKey: "ab".repeat(32),
  cumulativeZat: "125000",
  limitZat: "125000",
  headroomZat: "0",
  confirmedZat: "100000",
  pendingZat: "0",
  creditZat: "25000",
  tip: 4_547_331,
  deposits: [
    {
      txid: "cd".repeat(32),
      valueZat: "100000",
      status: "confirmed",
      confirmations: 2,
      expiryHeight: 4_547_450,
      zeroConf: true,
    },
  ],
};
if (parseSessionSnapshot(SNAP) === null) throw new Error("SNAP is not a valid session snapshot");

const OTHER_SNAP: SessionSnapshot = { ...SNAP, sessionKey: "ef".repeat(32), cumulativeZat: "500", limitZat: "0" };

function kindWith(extra: Record<string, unknown> | undefined): SupportedKind {
  return { x402Version: 2, scheme: SCHEME, network: NETWORK, extra };
}

/** A new object on every call because the corrective-402 stash is keyed by payload identity */
function payloadFor(accepted: PaymentRequirements = REQ): PaymentPayload {
  return {
    x402Version: 2,
    accepted: structuredClone(accepted),
    payload: { sessionKey: SNAP.sessionKey, cumulativeZat: "125500", sig: "00".repeat(64) },
  };
}

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    if (e instanceof Error) return e;
    throw e;
  }
  throw new Error("expected a throw, nothing was thrown");
}

function make(): PrepaidVoucherServerScheme {
  return new PrepaidVoucherServerScheme({ payTo: PAY_TO, network: NETWORK });
}

describe("PrepaidVoucherServerScheme", () => {
  let s: PrepaidVoucherServerScheme;
  beforeEach(() => {
    s = make();
  });

  describe("constructor", () => {
    it.each([
      [NETWORK_REGTEST, `uregtest1${"q".repeat(60)}`],
      [NETWORK_TESTNET, `utest1${"q".repeat(60)}`],
      [NETWORK_MAINNET, `u1${"q".repeat(60)}`],
    ])("takes a shielded-only payTo on %s", (network, payTo) => {
      expect(() => new PrepaidVoucherServerScheme({ payTo, network })).not.toThrow();
    });

    it("constructor rejects tutest1 payTo", () => {
      const payTo = `tutest1${"q".repeat(60)}`;
      const e = thrown(() => new PrepaidVoucherServerScheme({ payTo, network: NETWORK_TESTNET }));
      expect(e.message).toMatch(/payTo/);
    });

    it("rejects a payTo that belongs to another network", () => {
      const e = thrown(() => new PrepaidVoucherServerScheme({ payTo: PAY_TO, network: NETWORK_TESTNET }));
      expect(e.message).toMatch(/payTo/);
    });

    it.each(["eip155:1", "regtest", "ZCASH:REGTEST", "toString", ""])(
      "rejects the unknown network %j by name",
      (network) => {
        const e = thrown(() => new PrepaidVoucherServerScheme({ payTo: PAY_TO, network }));
        expect(e.message).toMatch(/network/);
      },
    );

    it("does not echo a rejected payTo, which may be a key pasted into the wrong setting", () => {
      const pasted = "uviewregtest1-pretend-this-is-a-viewing-key";
      const e = thrown(() => new PrepaidVoucherServerScheme({ payTo: pasted, network: NETWORK }));
      expect(e.message).toMatch(/payTo/);
      expect(e.message).not.toContain(pasted);
    });
  });

  describe("parsePrice", () => {
    it("parsePrice takes zatoshi ZEC only", async () => {
      const ok = await s.parsePrice({ amount: "500", asset: "ZEC" }, NETWORK);
      expect(ok).toMatchObject({ amount: "500", asset: "ZEC" });
      const bads = [
        "$0.01",
        { amount: "0", asset: "ZEC" },
        { amount: "500", asset: "USDC" },
        { amount: "05", asset: "ZEC" },
      ];
      for (const bad of bads) {
        await expect(s.parsePrice(bad as Price, NETWORK)).rejects.toThrow();
      }
    });

    it("accepts a one-zat price and one at the MAX_MONEY scale", async () => {
      expect(await s.parsePrice({ amount: "1", asset: "ZEC" }, NETWORK)).toMatchObject({ amount: "1" });
      const big = { amount: "2100000000000000", asset: "ZEC" };
      expect(await s.parsePrice(big, NETWORK)).toMatchObject({ amount: "2100000000000000" });
    });

    it.each<[string, unknown]>([
      ["a dollar string", "$0.01"],
      ["a bare number", 500],
      ["a decimal string", "500"],
      ["a money string with the symbol", "500 ZEC"],
      ["null", null],
      ["zero", { amount: "0", asset: "ZEC" }],
      ["a leading zero", { amount: "05", asset: "ZEC" }],
      ["a negative amount", { amount: "-5", asset: "ZEC" }],
      ["a fractional amount", { amount: "0.5", asset: "ZEC" }],
      ["an empty amount", { amount: "", asset: "ZEC" }],
      ["a numeric amount", { amount: 500, asset: "ZEC" }],
      ["another asset", { amount: "500", asset: "USDC" }],
      ["a lowercase asset", { amount: "500", asset: "zec" }],
      ["a missing asset", { amount: "500" }],
    ])("rejects %s", async (_name, price) => {
      await expect(s.parsePrice(price as Price, NETWORK)).rejects.toThrow();
    });

    it("ignores any extra on the price, because the terms come only from the facilitator", async () => {
      const parsed = await s.parsePrice({ amount: "500", asset: "ZEC", extra: { paymentFlow: "upfront" } }, NETWORK);
      expect(parsed.extra?.paymentFlow).toBeUndefined();
    });
  });

  describe("getAssetDecimals", () => {
    it("knows ZEC has 8 decimals and nothing else", () => {
      expect(s.getAssetDecimals("ZEC", NETWORK)).toBe(8);
      expect(s.getAssetDecimals("USDC", NETWORK)).toBeUndefined();
      expect(s.getAssetDecimals("zec", NETWORK)).toBeUndefined();
    });
  });

  describe("enhancePaymentRequirements", () => {
    it("TERM_KEYS are the five term fields of protocol.md section 2", () => {
      expect(TERM_KEYS).toEqual([
        "windowZat",
        "creditRatioBps",
        "creditCapZat",
        "zeroConfMinExpiryBlocks",
        "termsVersion",
      ]);
    });

    it("enhance copies the five term keys and not payTo", async () => {
      const out = await s.enhancePaymentRequirements(REQ, kindWith(WITH_PAY_TO), []);
      expect(out.extra).toEqual({
        windowZat: "100000",
        creditRatioBps: 2500,
        creditCapZat: "200000",
        zeroConfMinExpiryBlocks: 20,
        termsVersion: TERMS_VERSION,
      });
      expect(Object.keys(out.extra).sort()).toEqual([...TERM_KEYS].sort());
      expect(out.extra).not.toHaveProperty("payTo");
      expect(out.payTo).toBe(PAY_TO);
    });

    it("copies no other facilitator key, least of all the ones that steer the payment flow", async () => {
      const steering = { paymentFlow: "upfront", assetTransferMethod: "permit2", session: SNAP, future: 1 };
      const out = await s.enhancePaymentRequirements(REQ, kindWith({ ...ADVERTISED, ...steering }), []);
      expect(Object.keys(out.extra).sort()).toEqual([...TERM_KEYS].sort());
    });

    it("keeps the route's own extra, but the facilitator's terms win a clash", async () => {
      const route: PaymentRequirements = { ...REQ, extra: { windowZat: "1", note: "kept" } };
      const out = await s.enhancePaymentRequirements(route, kindWith(ADVERTISED), []);
      expect(out.extra.windowZat).toBe("100000");
      expect(out.extra.note).toBe("kept");
    });
  });

  describe("validateFacilitatorSupport", () => {
    it("validateFacilitatorSupport catches bad terms and accepts the terms the facilitator advertises", () => {
      const badTerms = kindWith({ ...ADVERTISED, windowZat: 100000 });
      expect(s.validateFacilitatorSupport(NETWORK, badTerms, [])).toMatch(/terms/);
      expect(s.validateFacilitatorSupport(NETWORK, kindWith(ADVERTISED), [])).toBeUndefined();
    });

    it("accepts keys it does not know, so a newer facilitator still starts an older API", () => {
      const newer = kindWith({ ...ADVERTISED, signers: ["x"], future: 1 });
      expect(s.validateFacilitatorSupport(NETWORK, newer, [])).toBeUndefined();
    });

    it("does not read extra.payTo: the facilitator advertises none, and the API's key names its payTo instead", () => {
      expect(Object.keys(ADVERTISED)).not.toContain("payTo");
      expect(s.validateFacilitatorSupport(NETWORK, kindWith(ADVERTISED), [])).toBeUndefined();
      // Nothing compares it, so an older facilitator's payTo, or any other value in its place, changes nothing
      expect(s.validateFacilitatorSupport(NETWORK, kindWith(WITH_PAY_TO), [])).toBeUndefined();
      expect(s.validateFacilitatorSupport(NETWORK, kindWith({ ...ADVERTISED, payTo: PAY_TO }), [])).toBeUndefined();
      expect(s.validateFacilitatorSupport(NETWORK, kindWith({ ...ADVERTISED, payTo: 7 }), [])).toBeUndefined();
    });

    it("names the terms when the facilitator advertises no extra at all", () => {
      expect(s.validateFacilitatorSupport(NETWORK, kindWith(undefined), [])).toMatch(/terms/);
    });

    const { creditRatioBps: _bps, ...WITHOUT_BPS } = ADVERTISED;
    it.each<[string, Record<string, unknown>]>([
      ["windowZat as a number", { ...ADVERTISED, windowZat: 100000 }],
      ["a leading-zero creditCapZat", { ...ADVERTISED, creditCapZat: "0200000" }],
      ["a fractional creditRatioBps", { ...ADVERTISED, creditRatioBps: 2500.5 }],
      ["a missing creditRatioBps", WITHOUT_BPS],
      ["a string zeroConfMinExpiryBlocks", { ...ADVERTISED, zeroConfMinExpiryBlocks: "20" }],
    ])("names the terms for %s", (_name, extra) => {
      expect(s.validateFacilitatorSupport(NETWORK, kindWith(extra), [])).toMatch(/terms/);
    });

    const { termsVersion: _version, ...WITHOUT_VERSION } = ADVERTISED;
    it.each<[string, Record<string, unknown>]>([
      ["missing", WITHOUT_VERSION],
      ["uppercase", { ...ADVERTISED, termsVersion: "0123456789ABCDEF" }],
      ["15 hex characters", { ...ADVERTISED, termsVersion: "0123456789abcde" }],
      ["17 hex characters", { ...ADVERTISED, termsVersion: "0123456789abcdef0" }],
      ["not hex", { ...ADVERTISED, termsVersion: "0123456789abcdeg" }],
      ["a 16-digit number", { ...ADVERTISED, termsVersion: 1234567890123456 }],
    ])("names termsVersion when it is %s", (_name, extra) => {
      expect(s.validateFacilitatorSupport(NETWORK, kindWith(extra), [])).toMatch(/termsVersion/);
    });
  });

  describe("corrective 402", () => {
    const afterVerify = (payload: PaymentPayload, result: VerifyResponse) =>
      s.schemeHooks.onAfterVerify!({
        paymentPayload: payload,
        requirements: payload.accepted,
        declaredExtensions: {},
        result,
      });

    const refusal = (session: SessionSnapshot): VerifyResponse => ({
      isValid: false,
      invalidReason: REASON.depositRequired,
      payer: session.sessionKey,
      extra: { session },
    });

    function paymentRequired(requirements: PaymentRequirements[], payload?: PaymentPayload) {
      const ctx: SchemePaymentRequiredContext = {
        requirements,
        paymentPayload: payload,
        resourceInfo: RESOURCE,
        error: payload === undefined ? "Payment required" : REASON.depositRequired,
        paymentRequiredResponse: { x402Version: 2, resource: RESOURCE, accepts: requirements },
      };
      return ctx;
    }

    it("corrective 402 adds extra.session only after a refused verify", async () => {
      const P = payloadFor();
      const P2 = payloadFor();
      await afterVerify(P, refusal(SNAP));
      const ctx = paymentRequired([structuredClone(REQ)], P);
      await s.enrichPaymentRequiredResponse(ctx);
      expect(ctx.requirements[0]?.extra.session).toEqual(SNAP);

      // a valid verify carries a snapshot too, but nothing is stashed for it
      await afterVerify(P2, { isValid: true, payer: SNAP.sessionKey, extra: { session: SNAP } });
      const ctx2 = paymentRequired([structuredClone(REQ)], P2);
      await s.enrichPaymentRequiredResponse(ctx2);
      expect(ctx2.requirements[0]?.extra).not.toHaveProperty("session");
    });

    it("adds nothing for a refusal that carries no snapshot, such as a bad signature", async () => {
      const P = payloadFor();
      await afterVerify(P, { isValid: false, invalidReason: REASON.invalidSignature });
      const ctx = paymentRequired([structuredClone(REQ)], P);
      await s.enrichPaymentRequiredResponse(ctx);
      expect(ctx.requirements[0]?.extra).not.toHaveProperty("session");
    });

    it("gives each refused payload its own snapshot, however the requests interleave", async () => {
      const P = payloadFor();
      const P2 = payloadFor();
      await afterVerify(P, refusal(SNAP));
      await afterVerify(P2, refusal(OTHER_SNAP));
      const ctx2 = paymentRequired([structuredClone(REQ)], P2);
      const ctx = paymentRequired([structuredClone(REQ)], P);
      await s.enrichPaymentRequiredResponse(ctx2);
      await s.enrichPaymentRequiredResponse(ctx);
      expect(ctx.requirements[0]?.extra.session).toEqual(SNAP);
      expect(ctx2.requirements[0]?.extra.session).toEqual(OTHER_SNAP);
    });

    it("adds nothing on the pass that has no payload, the plain unpaid 402", async () => {
      const ctx = paymentRequired([structuredClone(REQ)]);
      await s.enrichPaymentRequiredResponse(ctx);
      expect(ctx.requirements[0]?.extra).toEqual({});
    });

    it("touches only the accepts of its own scheme and network", async () => {
      const P = payloadFor();
      await afterVerify(P, refusal(SNAP));
      const otherSchemeElsewhere: PaymentRequirements = {
        ...REQ,
        scheme: "exact",
        network: "eip155:8453",
        extra: { name: "USDC" },
      };
      const otherSchemeHere: PaymentRequirements = { ...REQ, scheme: "exact", extra: { name: "ZEC" } };
      const thisSchemeElsewhere: PaymentRequirements = { ...REQ, network: NETWORK_TESTNET };
      const accepts = [otherSchemeElsewhere, otherSchemeHere, REQ, thisSchemeElsewhere];
      const ctx = paymentRequired(
        accepts.map((r) => structuredClone(r)),
        P,
      );
      await s.enrichPaymentRequiredResponse(ctx);
      expect(ctx.requirements.map((r) => r.extra)).toEqual([{ name: "USDC" }, { name: "ZEC" }, { session: SNAP }, {}]);
    });
  });
});

describe("PrepaidVoucherServerScheme registered in an x402ResourceServer", () => {
  const ROUTE: ResourceConfig = {
    scheme: SCHEME,
    network: NETWORK,
    payTo: PAY_TO,
    price: { amount: "500", asset: ASSET },
    maxTimeoutSeconds: 60,
  };

  const VALID: VerifyResponse = { isValid: true, payer: SNAP.sessionKey, extra: { session: SNAP } };
  const REFUSED: VerifyResponse = {
    isValid: false,
    invalidReason: REASON.depositRequired,
    invalidMessage: "nothing is pending",
    payer: SNAP.sessionKey,
    extra: { session: SNAP },
  };

  function facilitator(o: { extra?: Record<string, unknown>; verify?: VerifyResponse } = {}): FacilitatorClient {
    return {
      getSupported: async () => ({ kinds: [kindWith(o.extra ?? ADVERTISED)], extensions: [], signers: {} }),
      verify: async () => o.verify ?? VALID,
      settle: async () => {
        throw new Error("settle is not part of these tests");
      },
    };
  }

  function serverOver(f: FacilitatorClient): x402ResourceServer {
    return new x402ResourceServer(f).register(NETWORK, make());
  }

  async function started(f: FacilitatorClient): Promise<x402ResourceServer> {
    const server = serverOver(f);
    await server.initialize();
    return server;
  }

  async function failureOf(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => undefined,
      (e: unknown) => e,
    );
  }

  /** The route's requirements as core builds them, and a payload that accepted the first one */
  async function paying(server: x402ResourceServer, route: ResourceConfig = ROUTE) {
    const requirements = await server.buildPaymentRequirements(route);
    const accepted = requirements[0];
    if (accepted === undefined) throw new Error("no requirement built");
    return { requirements, accepted, payload: payloadFor(accepted) };
  }

  it("initializes against the advertised terms and builds the 402 requirement from them", async () => {
    const server = await started(facilitator());
    expect(await server.buildPaymentRequirements(ROUTE)).toEqual([
      {
        scheme: SCHEME,
        network: NETWORK,
        amount: "500",
        asset: "ZEC",
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: {
          windowZat: "100000",
          creditRatioBps: 2500,
          creditCapZat: "200000",
          zeroConfMinExpiryBlocks: 20,
          termsVersion: TERMS_VERSION,
        },
      },
    ]);
  });

  it("initializes against a facilitator that advertises no payTo, which is what a v2.0 one does", async () => {
    const server = serverOver(facilitator({ extra: ADVERTISED }));
    await expect(server.initialize()).resolves.toBeUndefined();
  });

  it("initializes against a facilitator that still advertises another payTo, since nothing compares it", async () => {
    const server = await started(facilitator({ extra: WITH_PAY_TO }));
    // The route's payTo is the API's own, whatever the facilitator says its operator's is
    const [built] = await server.buildPaymentRequirements(ROUTE);
    expect(built?.payTo).toBe(PAY_TO);
    expect(built?.extra).not.toHaveProperty("payTo");
  });

  it("refuses to initialize against a facilitator whose terms are bad", async () => {
    const server = serverOver(facilitator({ extra: { ...ADVERTISED, windowZat: 100000 } }));
    const error = await failureOf(server.initialize());
    expect(error).toBeInstanceOf(FacilitatorCapabilityError);
    expect((error as Error).message).toMatch(/terms/);
  });

  it("carries the facilitator's snapshot from a refused verify into the corrective 402, and only there", async () => {
    const server = await started(facilitator({ verify: REFUSED }));
    const { requirements, accepted, payload } = await paying(server);

    const verified = await server.verifyPayment(payload, accepted);
    expect(verified.isValid).toBe(false);

    const args = [requirements, RESOURCE, verified.invalidReason, undefined, undefined, payload] as const;
    const corrective = await server.createPaymentRequiredResponse(...args);
    expect(corrective.accepts[0]?.extra.session).toEqual(SNAP);

    const unpaid = await server.createPaymentRequiredResponse(requirements, RESOURCE, "Payment required");
    expect(unpaid.accepts[0]?.extra).not.toHaveProperty("session");
    expect(accepted.extra).not.toHaveProperty("session");
  });

  it("adds no snapshot after a verify that passed", async () => {
    const server = await started(facilitator({ verify: VALID }));
    const { requirements, accepted, payload } = await paying(server);

    expect((await server.verifyPayment(payload, accepted)).isValid).toBe(true);

    const args = [requirements, RESOURCE, "later", undefined, undefined, payload] as const;
    const later = await server.createPaymentRequiredResponse(...args);
    expect(later.accepts[0]?.extra).not.toHaveProperty("session");
  });

  it("serves a route with two accepts of this scheme, which core enriches one accept at a time", async () => {
    const server = await started(facilitator({ verify: REFUSED }));
    const { requirements: first, accepted, payload } = await paying(server);
    const second = await server.buildPaymentRequirements({ ...ROUTE, price: { amount: "1000", asset: ASSET } });
    const requirements = [...first, ...second];

    await server.verifyPayment(payload, accepted);
    const args = [requirements, RESOURCE, REASON.depositRequired, undefined, undefined, payload] as const;
    const corrective = await server.createPaymentRequiredResponse(...args);
    expect(corrective.accepts.map((a) => a.extra.session)).toEqual([SNAP, SNAP]);
  });
});
