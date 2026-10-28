/**
 * Streams of model output, sold one chunk per paid call (design §4.1).
 *
 * Each stream has a producer that reads the provider's deltas in the background, counting each non-empty delta as one
 * token. A chunk is published once it holds `chunkTokens` tokens and the next delta has arrived (that delta starts the
 * next chunk), or when the provider's stream ends, which makes that chunk final. So `final` is exact and a final chunk
 * is never empty, except for a generation with no output at all, which publishes one empty final chunk.
 *
 * The cursor, the index of the next chunk to deliver, moves only through claim and then commit, which the service calls
 * once a paid call was delivered. A call that fails after its chunk was ready releases the claim instead, and the next
 * call gets the same chunk.
 */
import { randomBytes } from "node:crypto";
import type { ChatMessage, ChatEnd, LlmProvider } from "./provider.js";

/** Far above the longest token of any tokenizer, as an average over a whole generation */
const MAX_CHARS_PER_TOKEN = 256;

export interface Chunk {
  readonly text: string;
  /** The provider's stream ended with this chunk */
  readonly final: boolean;
}

export type ProducerState = "running" | "done" | "failed";

export interface Generation {
  messages: ChatMessage[];
  maxTokens: number;
}

export type StreamErrorKind = "failed" | "timeout" | "closed" | "finished" | "full";

/** Why a wait for a chunk ended without one */
export class StreamError extends Error {
  readonly kind: StreamErrorKind;

  constructor(kind: StreamErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StreamError";
    this.kind = kind;
  }
}

interface StartOptions {
  id: string;
  now: () => number;
  provider: LlmProvider;
  generation: Generation;
  chunkTokens: number;
  onFailure: ((e: unknown) => void) | undefined;
}

export class LlmStream {
  readonly id: string;
  readonly #now: () => number;
  readonly #onFailure: ((e: unknown) => void) | undefined;
  readonly #chunks: Chunk[] = [];
  readonly #abort = new AbortController();
  /** Each one settles its wait and returns true once the stream can answer it */
  readonly #waiters = new Set<() => boolean>();
  #cursor = 0;
  #inFlight = false;
  #lastAccess: number;
  /** When the provider last sent a delta, or when the stream was created */
  #lastOutput: number;
  #state: ProducerState = "running";
  #finishReason: string | undefined;
  #error: unknown;
  #closed = false;

  private constructor(o: StartOptions) {
    this.id = o.id;
    this.#now = o.now;
    this.#onFailure = o.onFailure;
    this.#lastAccess = o.now();
    this.#lastOutput = this.#lastAccess;
  }

  /** Creates the stream and starts its producer */
  static start(o: StartOptions): LlmStream {
    const stream = new LlmStream(o);
    void stream.#produce(o);
    return stream;
  }

  get cursor(): number {
    return this.#cursor;
  }

  get inFlight(): boolean {
    return this.#inFlight;
  }

  get lastAccess(): number {
    return this.#lastAccess;
  }

  get state(): ProducerState {
    return this.#state;
  }

  get finishReason(): string | undefined {
    return this.#finishReason;
  }

  get error(): unknown {
    return this.#error;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** How many chunks are published */
  get published(): number {
    return this.#chunks.length;
  }

  /** The producer stopped and every chunk it published was delivered, so the stream has nothing left to sell */
  get spent(): boolean {
    return this.#state !== "running" && this.#cursor >= this.#chunks.length;
  }

  chunk(index: number): Chunk | undefined {
    return this.#chunks[index];
  }

  touch(): void {
    this.#lastAccess = this.#now();
  }

  /** Marks a call in flight and returns the index it delivers, or undefined while another call holds the stream */
  claim(): number | undefined {
    if (this.#inFlight || this.#closed) return undefined;
    this.#inFlight = true;
    this.touch();
    return this.#cursor;
  }

  /** The call that claimed `index` was delivered, so the cursor moves past it */
  commit(index: number): void {
    if (index === this.#cursor && index < this.#chunks.length) this.#cursor = index + 1;
    this.#inFlight = false;
    this.touch();
  }

  /** The call that claimed the stream was not delivered, so its chunk stays the next one */
  release(): void {
    this.#inFlight = false;
    this.touch();
  }

  /** Resolves once chunk `index` is published; rejects when the producer fails, the stream closes or time runs out */
  waitFor(index: number, timeoutMs: number): Promise<Chunk> {
    return new Promise<Chunk>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const settle = (): boolean => {
        const outcome = this.#outcome(index);
        if (outcome === undefined) return false;
        clearTimeout(timer);
        this.#waiters.delete(settle);
        if (outcome instanceof StreamError) reject(outcome);
        else resolve(outcome);
        return true;
      };
      if (settle()) return;
      this.#waiters.add(settle);
      timer = setTimeout(() => {
        this.#waiters.delete(settle);
        reject(new StreamError("timeout", `chunk ${index} was not ready within ${timeoutMs} ms`));
      }, timeoutMs);
    });
  }

  /**
   * Fails a generation that has sent nothing for `ms`, so that later calls on it are refused before payment instead of
   * each paying for another timeout. Returns whether it did.
   */
  failIfStalled(ms: number): boolean {
    if (this.#state !== "running" || this.#now() - this.#lastOutput < ms) return false;
    const stalled = new StreamError("failed", `the provider sent nothing for ${ms} ms`);
    this.#state = "failed";
    this.#error = stalled;
    this.#onFailure?.(stalled);
    this.#notify();
    this.#abort.abort(stalled);
    return true;
  }

  /** Stops the producer and ends every wait */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
    this.#notify();
  }

  #outcome(index: number): Chunk | StreamError | undefined {
    const chunk = this.#chunks[index];
    if (chunk !== undefined) return chunk;
    if (this.#closed) return new StreamError("closed", "the stream was closed");
    if (this.#state === "failed") return new StreamError("failed", "the provider failed", { cause: this.#error });
    if (this.#state === "done") return new StreamError("finished", `the stream ended before chunk ${index}`);
    return undefined;
  }

  #notify(): void {
    for (const settle of [...this.#waiters]) settle();
  }

  #publish(chunk: Chunk): void {
    this.#chunks.push(chunk);
    this.#notify();
  }

  async #produce(o: StartOptions): Promise<void> {
    const signal = this.#abort.signal;
    let deltas: AsyncGenerator<string, ChatEnd, void> | undefined;
    let ended = false;
    let text = "";
    let tokens = 0;
    let total = 0;
    let chars = 0;
    const maxChars = o.generation.maxTokens * MAX_CHARS_PER_TOKEN;
    try {
      deltas = o.provider.streamChat({ ...o.generation, signal });
      for (;;) {
        const step = await deltas.next();
        signal.throwIfAborted();
        if (step.done === true) {
          ended = true;
          this.#finishReason = step.value.finishReason;
          break;
        }
        if (step.value === "") continue;
        this.#lastOutput = this.#now();
        // Each delta holds at least one token, so output past either cap means the provider ignored max_tokens
        if (total >= o.generation.maxTokens || chars + step.value.length > maxChars) {
          this.#finishReason = "length";
          break;
        }
        if (tokens >= o.chunkTokens) {
          this.#publish({ text, final: false });
          text = "";
          tokens = 0;
        }
        text += step.value;
        tokens += 1;
        total += 1;
        chars += step.value.length;
      }
      this.#state = "done";
      this.#publish({ text, final: true });
    } catch (e) {
      // failIfStalled has already failed the stream and reported it
      if (this.#state === "failed") return;
      this.#state = "failed";
      this.#error = e;
      // A stream the registry closed was stopped on purpose
      if (!this.#closed) this.#onFailure?.(e);
      this.#notify();
    } finally {
      // A generator left at a yield holds its connection until it is returned
      if (!ended) await deltas?.return({ finishReason: undefined }).catch(() => undefined);
    }
  }
}

export interface StreamRegistryOptions {
  provider: LlmProvider;
  chunkTokens: number;
  /** Live streams at most; a spent stream does not count */
  capacity: number;
  idleMs: number;
  /** Called once for each generation that fails, a stall included; a stream closed on purpose has not failed */
  onFailure?: (e: unknown) => void;
  now?: () => number;
}

const SWEEP_EVERY_MS = 30_000;
const ID_BYTES = 16;

export class StreamRegistry {
  readonly #streams = new Map<string, LlmStream>();
  readonly #o: StreamRegistryOptions;
  readonly #now: () => number;
  readonly #sweeper: NodeJS.Timeout;
  #closed = false;

  constructor(o: StreamRegistryOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.#sweeper = setInterval(() => this.sweep(), SWEEP_EVERY_MS);
    this.#sweeper.unref();
  }

  /** Every stream held, spent ones included */
  get size(): number {
    return this.#streams.size;
  }

  /** Streams that hold capacity: their producer runs, or they have chunks left to deliver */
  get live(): number {
    let n = 0;
    for (const s of this.#streams.values()) if (!s.spent) n += 1;
    return n;
  }

  hasRoom(): boolean {
    return !this.#closed && this.live < this.#o.capacity;
  }

  /** Starts a generation. The new stream is claimed for chunk 0 by the call that started it. */
  create(generation: Generation): LlmStream {
    if (this.#closed) throw new StreamError("closed", "the service is shutting down");
    // Paid starts that all found room before payment can arrive here together
    if (!this.hasRoom()) throw new StreamError("full", `${this.#o.capacity} streams are live`);
    const stream = LlmStream.start({
      id: randomBytes(ID_BYTES).toString("base64url"),
      now: this.#now,
      provider: this.#o.provider,
      generation,
      chunkTokens: this.#o.chunkTokens,
      onFailure: this.#o.onFailure,
    });
    stream.claim();
    this.#streams.set(stream.id, stream);
    return stream;
  }

  get(id: string): LlmStream | undefined {
    const stream = this.#streams.get(id);
    stream?.touch();
    return stream;
  }

  /** Drops the stream and stops its producer */
  remove(id: string): void {
    const stream = this.#streams.get(id);
    if (stream === undefined) return;
    this.#streams.delete(id);
    stream.close();
  }

  /** Drops every stream idle for longer than idleMs, except one with a call in flight, and returns how many */
  sweep(): number {
    const now = this.#now();
    let removed = 0;
    for (const stream of [...this.#streams.values()]) {
      if (!stream.inFlight && now - stream.lastAccess > this.#o.idleMs) {
        this.remove(stream.id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Stops every producer and refuses new streams */
  close(): void {
    this.#closed = true;
    clearInterval(this.#sweeper);
    for (const id of [...this.#streams.keys()]) this.remove(id);
  }
}
