import type { DepositRequest, ZcashWallet } from "@z402/protocol";
import type { FakeChain } from "./fake-chain.js";

/**
 * Pays by broadcasting straight onto a `FakeChain`. A failure armed by the constructor's `failNext` or by
 * `failNextWith` is consumed by the next call; `latencyMs` delays every call.
 */
export class MockWallet implements ZcashWallet {
  readonly sent: DepositRequest[] = [];
  readonly #chain: FakeChain;
  readonly #latencyMs: number;
  #failNext: Error | undefined;

  constructor(chain: FakeChain, o: { failNext?: Error; latencyMs?: number } = {}) {
    this.#chain = chain;
    this.#failNext = o.failNext;
    this.#latencyMs = o.latencyMs ?? 0;
  }

  /** Arms a one-shot failure for the next `sendDeposit`. Call it again later, e.g. after a successful send, to fail the Nth deposit. */
  failNextWith(err: Error): void {
    this.#failNext = err;
  }

  async sendDeposit(req: DepositRequest): Promise<{ txid: string }> {
    const failure = this.#failNext;
    this.#failNext = undefined;
    if (this.#latencyMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.#latencyMs));
    }
    if (failure !== undefined) throw failure;
    const txid = this.#chain.broadcast({
      outputs: [{ to: req.to, valueZat: req.amountZat, memo: req.memo }],
    });
    this.sent.push({ to: req.to, amountZat: req.amountZat, memo: req.memo });
    return { txid };
  }
}
