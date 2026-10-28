/** A problem the smoke test reports as the reason a step failed, as opposed to a bug in the test itself */
export class Failure extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "Failure";
  }
}

export class BodyTooLarge extends Failure {}

/** Control characters (a terminal escape is one), line and paragraph separators, and the marks that reorder text */
const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}\s]+/gu;

/** One line of plain text, with each run of unsafe characters and white space turned into one space. Everything a
 * service sends goes through here before it reaches the terminal. The edges are kept, as a chunk of text starts with a
 * space where a word begins. */
export function clean(text: string): string {
  return text.replace(UNSAFE, " ");
}

/** `clean`, cut to `max` characters with an ellipsis. Walks the text rather than copying it, as it may be huge. */
export function excerpt(text: string, max: number): string {
  let out = "";
  let count = 0;
  for (const char of clean(text)) {
    if (count === max) return `${out}…`;
    out += char;
    count += 1;
  }
  return out;
}

/** The message plus its cause, since fetch hides ECONNREFUSED in the cause of "fetch failed" */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = error.cause;
  if (cause instanceof Error && cause.message !== "") return `${error.message}: ${cause.message}`;
  const code = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" ? `${error.message}: ${code}` : error.message;
}

/** The body, or a BodyTooLarge once it passes `limit` bytes, with the rest of it left unread and cancelled */
export async function readBody(res: Response, limit: number): Promise<Buffer> {
  if (res.body === null) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge(`the body is over ${limit} bytes`);
    }
    chunks.push(value);
  }
}

/** Lets go of a response nobody will read, so its connection is not held open */
export async function drain(res: Response): Promise<void> {
  if (!res.bodyUsed) await res.body?.cancel().catch(() => undefined);
}

/**
 * The work, or a rejection with the reason of the signal as soon as it fires. fetch is not relied on to stop by itself:
 * the request the payment wrapper sends is a clone, and a clone stops following the signal of the original once the
 * garbage collector has run. The work is left to finish or fail on its own, quietly.
 */
export function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    const giveUp = (): void => reject(signal.reason);
    if (signal.aborted) {
      work.catch(() => undefined);
      giveUp();
      return;
    }
    signal.addEventListener("abort", giveUp, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", giveUp));
  });
}
