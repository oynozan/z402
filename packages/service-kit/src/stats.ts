/** Paid calls delivered since 00:00 UTC. An aggregate only: nothing per session or per client is kept. */
export class CallStats {
  #day = "";
  #count = 0;
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  record(): void {
    this.#roll();
    this.#count += 1;
  }

  today(): number {
    this.#roll();
    return this.#count;
  }

  #roll(): void {
    const day = this.#now().toISOString().slice(0, 10);
    if (day !== this.#day) {
      this.#day = day;
      this.#count = 0;
    }
  }
}
