/**
 * Conversions run on worker threads. jsdom and turndown can take seconds and hundreds of MB on one large page, which on
 * the main thread would stall every other request (paid retries included) and could take the process down, all before
 * anyone has paid. Each worker converts one page at a time under a heap limit and a deadline; a worker that runs out of
 * either is terminated and the page is refused as too large. If no worker can start at all (a runtime that cannot load
 * the TypeScript module), conversions fall back to the main thread with a warning.
 */
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { ConvertAnswer, ConvertJob, ConvertLimits, Converted, PageInput } from "./convert.js";
import { PageError } from "./errors.js";

export interface ConvertPoolOptions {
  /** Workers at most, each converting one page at a time */
  size: number;
  /** Deadline of one conversion */
  timeoutMs: number;
  /** Heap limit of each worker. Default 192; the tag budget of a page should be maxTagsFor of it */
  memoryMb?: number;
}

/** Equal to CONVERT_WORKER in convert.ts, which is not imported here so that jsdom never loads on the main thread */
const CONVERT_WORKER = "z402-markdown-convert";
const DEFAULT_MEMORY_MB = 192;
const START_TIMEOUT_MS = 30_000;
/** convert.ts under tsx or vitest, convert.js if the package is ever compiled */
const WORKER_URL = new URL(`./convert${extname(fileURLToPath(import.meta.url))}`, import.meta.url);

type ConvertModule = typeof import("./convert.js");
type Waiter = (worker: Worker | Error) => void;

function text(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isReady(message: unknown): boolean {
  return typeof message === "object" && message !== null && (message as { ready?: unknown }).ready === true;
}

export class ConvertPool {
  readonly #size: number;
  readonly #timeoutMs: number;
  readonly #memoryMb: number;
  readonly #all = new Set<Worker>();
  #idle: Worker[] = [];
  readonly #waiting: Waiter[] = [];
  /** Whether any worker has ever started, which tells a broken runtime from a passing failure */
  #started = false;
  #mainThread: Promise<ConvertModule> | undefined;
  #nextId = 1;
  #closed = false;

  constructor(o: ConvertPoolOptions) {
    this.#size = o.size;
    this.#timeoutMs = o.timeoutMs;
    this.#memoryMb = o.memoryMb ?? DEFAULT_MEMORY_MB;
  }

  /** Workers alive, idle or busy */
  get workers(): number {
    return this.#all.size;
  }

  /** Whether conversions fell back to the main thread because no worker could start */
  get onMainThread(): boolean {
    return this.#mainThread !== undefined;
  }

  /** Starts one worker ahead of the first page, so that the first caller does not wait for jsdom to load */
  async warm(): Promise<void> {
    const worker = await this.#acquire();
    if (worker !== undefined) this.#release(worker);
  }

  async convert(page: PageInput, limits: ConvertLimits): Promise<Converted> {
    const worker = await this.#acquire();
    return worker === undefined ? this.#convertHere(page, limits) : this.#run(worker, page, limits);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const waiter of this.#waiting.splice(0)) waiter(new Error("the conversion pool is closed"));
    const workers = [...this.#all];
    this.#all.clear();
    this.#idle = [];
    await Promise.all(workers.map((w) => w.terminate()));
  }

  /** A worker for one job, or undefined when conversions run on the main thread */
  async #acquire(): Promise<Worker | undefined> {
    if (this.#mainThread !== undefined) return undefined;
    if (this.#closed) throw new PageError("convert_failed", "the conversion pool is closed");
    const idle = this.#idle.pop();
    if (idle !== undefined) return idle;
    try {
      if (this.#all.size < this.#size) return await this.#spawn();
      return await new Promise<Worker>((resolve, reject) => {
        this.#waiting.push((w) => (w instanceof Error ? reject(w) : resolve(w)));
      });
    } catch (e) {
      if (this.#started || this.#closed) {
        throw new PageError("convert_failed", `no conversion worker (${text(e)})`, { cause: e });
      }
      console.error(`markdown: conversion workers cannot start (${text(e)}), converting on the main thread`);
      this.#mainThread ??= import("./convert.js");
      return undefined;
    }
  }

  #release(worker: Worker): void {
    if (this.#closed || !this.#all.has(worker)) {
      void worker.terminate();
      return;
    }
    const waiter = this.#waiting.shift();
    if (waiter !== undefined) waiter(worker);
    else this.#idle.push(worker);
  }

  #forget(worker: Worker): void {
    this.#all.delete(worker);
    this.#idle = this.#idle.filter((w) => w !== worker);
  }

  /** Ends a worker that failed or ran out of time, and starts a replacement for anyone waiting */
  #discard(worker: Worker): void {
    this.#forget(worker);
    void worker.terminate();
    const waiter = this.#waiting.shift();
    if (waiter !== undefined) this.#spawn().then(waiter, waiter);
  }

  #spawn(): Promise<Worker> {
    const worker = new Worker(WORKER_URL, {
      workerData: CONVERT_WORKER,
      resourceLimits: { maxOldGenerationSizeMb: this.#memoryMb },
    });
    this.#all.add(worker);
    // An idle worker never keeps the process alive, and an error outside a job only takes the worker out of the pool
    worker.unref();
    worker.on("error", () => this.#forget(worker));
    worker.on("exit", () => this.#forget(worker));
    return new Promise((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", fail);
        worker.off("exit", onExit);
      };
      const fail = (e: Error): void => {
        done();
        this.#forget(worker);
        void worker.terminate();
        reject(e);
      };
      const onMessage = (message: unknown): void => {
        if (!isReady(message)) return;
        done();
        this.#started = true;
        resolve(worker);
      };
      const onExit = (code: number): void => fail(new Error(`the worker exited with code ${code}`));
      const timer = setTimeout(
        () => fail(new Error(`no worker ready within ${START_TIMEOUT_MS} ms`)),
        START_TIMEOUT_MS,
      );
      worker.on("message", onMessage);
      worker.on("error", fail);
      worker.on("exit", onExit);
    });
  }

  #run(worker: Worker, page: PageInput, limits: ConvertLimits): Promise<Converted> {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
      };
      const abandon = (error: PageError): void => {
        done();
        this.#discard(worker);
        reject(error);
      };
      const onMessage = (answer: ConvertAnswer): void => {
        if (answer.id !== id) return;
        done();
        this.#release(worker);
        if (answer.ok) resolve(answer.result);
        else reject(new PageError(answer.tooComplex ? "too_large" : "convert_failed", answer.message));
      };
      const onError = (e: Error): void => {
        const outOfMemory = (e as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY";
        abandon(new PageError(outOfMemory ? "too_large" : "convert_failed", e.message, { cause: e }));
      };
      const onExit = (): void => abandon(new PageError("convert_failed", "the conversion worker stopped"));
      const timer = setTimeout(
        () => abandon(new PageError("too_large", `the conversion took more than ${this.#timeoutMs} ms`)),
        this.#timeoutMs,
      );
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      const job: ConvertJob = { id, page, limits };
      worker.postMessage(job);
    });
  }

  async #convertHere(page: PageInput, limits: ConvertLimits): Promise<Converted> {
    const { convertPage, TooComplexError } = await (this.#mainThread ?? import("./convert.js"));
    try {
      return convertPage(page, limits);
    } catch (e) {
      if (e instanceof TooComplexError) throw new PageError("too_large", e.message);
      throw new PageError("convert_failed", text(e), { cause: e });
    }
  }
}
