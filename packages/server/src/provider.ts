/** The start-up check that a resource server's API key and its payTo belong together (design §4.6) */
import { isZcashNetwork } from "@z402/protocol";

/** The setting a failed check points at, named as the caller's own options are */
export type ProviderCheckField = "facilitatorToken" | "payTo" | "facilitatorUrl";

/** A failed check, which callers branch on by `field` and `retryable` and never by its message */
export class ProviderCheckError extends Error {
  readonly field: ProviderCheckField;
  /** True when the facilitator may only be starting or briefly down, so asking again later can succeed */
  readonly retryable: boolean;

  constructor(field: ProviderCheckField, retryable: boolean, reason: string) {
    super(`${field}: ${reason}`);
    this.name = "ProviderCheckError";
    this.field = field;
    this.retryable = retryable;
  }
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_CAUSES = 5;
/** An RFC 6750 b64token, the only token an Authorization header can carry and match */
const B64TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
/** The shape of a Node errno or undici code, such as ECONNREFUSED or UND_ERR_SOCKET */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** The code under a failed fetch, or else the kind of error, and never its message, which can quote a header */
function codeOf(e: unknown): string {
  let current: unknown = e;
  for (let depth = 0; current instanceof Error && depth < MAX_CAUSES; depth++) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === "string" && ERROR_CODE.test(code)) return code;
    current = current.cause;
  }
  return e instanceof Error ? e.name : "unknown error";
}

/** Refuses a URL no request could use, and returns its origin, the only part of it that a message names */
function originOf(facilitatorUrl: string): string {
  const url = typeof facilitatorUrl === "string" && URL.canParse(facilitatorUrl) ? new URL(facilitatorUrl) : undefined;
  if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new ProviderCheckError("facilitatorUrl", false, "expected an http:// or https:// URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ProviderCheckError("facilitatorUrl", false, "must not carry credentials (use facilitatorToken)");
  }
  return url.origin;
}

/** What a status other than 200 means for the start */
function refusedWith(status: number, at: string, hasToken: boolean): ProviderCheckError {
  if (status === 401 || status === 403) {
    const reason = hasToken
      ? `${at} refused the API key (${status})`
      : `${at} wants an API key (${status}) and none is set`;
    return new ProviderCheckError("facilitatorToken", false, reason);
  }
  if (status === 404) {
    const reason = `${at} has no /providers/me (404), so it is not a facilitator of the multi-provider rail`;
    return new ProviderCheckError("facilitatorUrl", false, reason);
  }
  // A busy or slow facilitator (408, 429) answers later, as the SDK's retry of /supported assumes
  const retryable = status >= 500 || status === 408 || status === 429;
  return new ProviderCheckError("facilitatorUrl", retryable, `${at} answered /providers/me with ${status}`);
}

/** The network and payTo of an answer that has the three strings, and nothing for any other body */
function readMe(body: string): { network: string; payTo: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const { providerId, network, payTo } = parsed;
  if (typeof providerId !== "string" || typeof network !== "string" || typeof payTo !== "string") return undefined;
  return { network, payTo };
}

/** Resolves when the key's provider is paid at `payTo` on `network`, and otherwise throws a ProviderCheckError */
export async function checkProvider(o: {
  facilitatorUrl: string;
  /** The API key, sent as a bearer token, and no Authorization header is sent when it is left out */
  token?: string;
  /** The address this server tells clients to pay, which must be the one the key's provider has */
  payTo: string;
  network: string;
  /** Default the global fetch */
  fetch?: typeof fetch;
  /** How long the request may take, default 5000 */
  timeoutMs?: number;
}): Promise<void> {
  const { token } = o;
  const at = `the facilitator at ${originOf(o.facilitatorUrl)}`;
  if (token !== undefined && !B64TOKEN.test(token)) {
    throw new ProviderCheckError("facilitatorToken", false, "must be one token of letters, digits and -._~+/");
  }
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Made first so that a timeoutMs no timer takes throws as the caller's bug and not as a retryable error
  const signal = AbortSignal.timeout(timeoutMs);
  const headers: Record<string, string> = { accept: "application/json" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;

  const unreachable = (e: unknown): ProviderCheckError => {
    const reason = signal.aborted
      ? `${at} did not answer /providers/me within ${timeoutMs} ms`
      : `cannot reach ${at} (${codeOf(e)})`;
    return new ProviderCheckError("facilitatorUrl", true, reason);
  };

  let res: Response;
  try {
    res = await (o.fetch ?? globalThis.fetch)(`${o.facilitatorUrl.replace(/\/+$/, "")}/providers/me`, {
      headers,
      signal,
    });
  } catch (e) {
    throw unreachable(e);
  }
  if (res.status !== 200) {
    // Dropping the body frees the connection
    await res.body?.cancel().catch(() => undefined);
    throw refusedWith(res.status, at, token !== undefined);
  }

  // A body that breaks off or stalls is the connection failing and not an unreadable answer
  let body: string;
  try {
    body = await res.text();
  } catch (e) {
    throw unreachable(e);
  }
  const me = readMe(body);
  if (me === undefined) {
    const reason = `${at} answered /providers/me with a body that is not {providerId, network, payTo}`;
    throw new ProviderCheckError("facilitatorUrl", false, reason);
  }
  if (me.network !== o.network) {
    const theirs = isZcashNetwork(me.network) ? me.network : "another network";
    throw new ProviderCheckError("payTo", false, `${at} serves ${theirs}, not ${o.network}`);
  }
  if (me.payTo !== o.payTo) {
    throw new ProviderCheckError("payTo", false, `${at} has this API key for another payTo than ${o.payTo}`);
  }
}
