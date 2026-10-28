/**
 * How a provider registers, or rotates its API key (design §4.1). The viewing key must own the payTo first. A new
 * provider then has its runtime opened and polled before anything is written, so a crash leaves at worst a ledger
 * that no entry names, and only then is the entry stored and the key put in force. A rotation stores the new key hash
 * before the old key stops working. Registrations run one at a time, since each reads the registry and then changes it.
 */
import { isValidPayTo, type ZcashNetwork } from "@z402-net/protocol";
import { isValidUivk } from "../config.js";
import { MAX_PAY_TO_LENGTH } from "../payTo.js";
import type { Log, ProviderRuntime } from "../runtime.js";
import { keyDigest, newApiKey } from "./apiKey.js";
import { providerId } from "./id.js";
import type { ProviderEntry, ProviderRegistry } from "./registry.js";

/** A registration that is refused, with the status and code the design gives it and a message that names the field */
export class RegistrationRefused extends Error {
  readonly status: 400 | 403 | 409 | 500;
  readonly code: string;

  constructor(status: 400 | 403 | 409 | 500, code: string, message: string) {
    super(message);
    this.name = "RegistrationRefused";
    this.status = status;
    this.code = code;
  }
}

export interface Registered {
  /** 201 for a new provider and 200 for a rotated key */
  status: 200 | 201;
  body: { providerId: string; network: string; payTo: string; apiKey: string };
}

/** Registers the provider a request body asks for, or throws RegistrationRefused */
export type Registrar = (body: unknown) => Promise<Registered>;

interface Proof {
  payTo: string;
  uivk: string;
}

export interface RegistrarDeps {
  network: ZcashNetwork;
  /** The payTo of the operator, which no provider can register */
  operatorPayTo: string;
  registry: ProviderRegistry;
  /** The most providers that can be registered, and a rotation is not a new one */
  max: number;
  /** Whether the viewing key is the one of the payTo and the payTo takes no transparent deposit */
  owns(p: Proof): Promise<boolean>;
  /** Opens the runtime of a provider that is about to be stored, which serves no request yet */
  open(p: Proof & { ledgerPath: string }): Promise<ProviderRuntime>;
  /** The runtime in service for a registered payTo */
  runtimeOf(payTo: string): ProviderRuntime | undefined;
  /** Puts the runtime of a provider that was just stored into service under the hash of its key */
  admit(runtime: ProviderRuntime, keyHash: string): void;
  /** Makes `keyHash` the key of a runtime in service, and `replacing` stops working */
  rekey(runtime: ProviderRuntime, keyHash: string, replacing: string): void;
  log: Log;
  now?: () => Date;
}

const FAILED = "facilitator: provider registration failed";

const refuse = (status: 400 | 403 | 409 | 500, code: string, message: string): RegistrationRefused =>
  new RegistrationRefused(status, code, message);

const failed = (): RegistrationRefused =>
  refuse(500, "internal_error", "the registration failed and nothing was changed");

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** What a body asks for, checked before anything is read or opened, and no message quotes a value from it */
function asked(body: unknown, network: ZcashNetwork): Proof {
  const invalid = (message: string) => refuse(400, "invalid_request", message);
  if (!isRecord(body)) throw invalid("the request body must be a JSON object");
  const { payTo, uivk, network: named } = body;
  if (typeof payTo === "string" && payTo.length > MAX_PAY_TO_LENGTH) {
    throw invalid(`payTo: expected at most ${MAX_PAY_TO_LENGTH} characters`);
  }
  if (typeof payTo !== "string" || !isValidPayTo(payTo, network)) {
    throw invalid(`payTo: expected a shielded-only unified address for ${network}`);
  }
  if (typeof uivk !== "string" || !isValidUivk(uivk, network)) {
    throw invalid(`uivk: expected a unified incoming viewing key for ${network}`);
  }
  if (named !== undefined && named !== network) throw invalid(`network: expected ${network}, or leave it out`);
  return { payTo, uivk };
}

export function createRegistrar(d: RegistrarDeps): Registrar {
  const now = d.now ?? (() => new Date());
  let tail: Promise<unknown> = Promise.resolve();

  const alone = <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job);
    tail = run.catch(() => undefined);
    return run;
  };

  const answer = (id: string, payTo: string, apiKey: string) => ({
    providerId: id,
    network: d.network,
    payTo,
    apiKey,
  });

  async function owned(p: Proof): Promise<boolean> {
    try {
      return await d.owns(p);
    } catch (e) {
      d.log(FAILED, e);
      throw failed();
    }
  }

  async function create(p: Proof, apiKey: string): Promise<Registered> {
    const id = providerId(d.network, p.payTo);
    const keyHash = keyDigest(apiKey);
    const at = now().toISOString();
    let runtime: ProviderRuntime;
    try {
      runtime = await d.open({ ...p, ledgerPath: d.registry.ledgerPath(id) });
    } catch (e) {
      d.log(FAILED, e);
      throw failed();
    }
    try {
      await runtime.pollNow();
      runtime.start();
      d.registry.put({ id, payTo: p.payTo, uivk: p.uivk, keyHash, createdAt: at, keyIssuedAt: at });
    } catch (e) {
      runtime.stop();
      runtime.release();
      d.log(FAILED, e);
      throw failed();
    }
    d.admit(runtime, keyHash);
    d.log(`facilitator: registered provider ${id} payTo=${p.payTo}`);
    return { status: 201, body: answer(id, p.payTo, apiKey) };
  }

  function rotate(known: ProviderEntry, apiKey: string): Registered {
    const runtime = d.runtimeOf(known.payTo);
    if (runtime === undefined) {
      d.log(FAILED, new Error(`provider ${known.id} is registered and has no runtime`));
      throw failed();
    }
    const keyHash = keyDigest(apiKey);
    try {
      d.registry.put({ ...known, keyHash, keyIssuedAt: now().toISOString() });
    } catch (e) {
      d.log(FAILED, e);
      throw failed();
    }
    // Nothing awaits between the write and the swap, so no request sees the new hash stored and the old key in force
    d.rekey(runtime, keyHash, known.keyHash);
    d.log(`facilitator: rotated the key of provider ${known.id}`);
    return { status: 200, body: answer(known.id, known.payTo, apiKey) };
  }

  async function register(p: Proof): Promise<Registered> {
    const known = d.registry.get(p.payTo);
    if (known === undefined && d.registry.entries().length >= d.max) {
      throw refuse(403, "provider_limit", `the limit of ${d.max} providers is reached`);
    }
    if (!(await owned(p))) {
      throw refuse(403, "not_owner", "uivk: not the viewing key of payTo, or payTo has a transparent receiver");
    }
    const apiKey = newApiKey();
    return known === undefined ? create(p, apiKey) : rotate(known, apiKey);
  }

  return async (body) => {
    const request = asked(body, d.network);
    if (request.payTo === d.operatorPayTo) {
      throw refuse(409, "operator", "payTo: this is the operator's own provider, which is not registered");
    }
    return alone(() => register(request));
  };
}
