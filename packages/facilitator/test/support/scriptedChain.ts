import type { ChainView, TxInspection } from "@z402-net/protocol";

const NOT_FOUND: TxInspection = { found: false };

/** A chain that answers every txid from a script, counts the calls and can answer slowly */
export class ScriptedChain implements ChainView {
  tipHeight = 1000;
  inFlight = 0;
  maxInFlight = 0;
  calls = new Map<string, number>();
  delayMs = 0;
  readonly #scripts = new Map<string, { answers: Array<TxInspection | Error>; next: number }>();

  /** The last answer repeats, and a txid with no script is never found */
  script(txid: string, answers: Array<TxInspection | Error>): void {
    this.#scripts.set(txid, { answers: [...answers], next: 0 });
  }

  async tip(): Promise<number> {
    await this.#pause();
    return this.tipHeight;
  }

  async inspect(txid: string): Promise<TxInspection> {
    this.calls.set(txid, (this.calls.get(txid) ?? 0) + 1);
    this.maxInFlight = Math.max(this.maxInFlight, ++this.inFlight);
    try {
      await this.#pause();
      const answer = this.#answer(txid);
      if (answer instanceof Error) throw answer;
      return answer;
    } finally {
      this.inFlight--;
    }
  }

  async #pause(): Promise<void> {
    if (this.delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
  }

  #answer(txid: string): TxInspection | Error {
    const script = this.#scripts.get(txid);
    if (script === undefined) return NOT_FOUND;
    const at = Math.min(script.next, script.answers.length - 1);
    script.next += 1;
    return script.answers[at] ?? NOT_FOUND;
  }
}
