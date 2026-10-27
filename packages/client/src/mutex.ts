/** FIFO async lock whose release function only works once */
export class Mutex {
  #locked = false;
  readonly #waiters: Array<(release: () => void) => void> = [];

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      if (this.#locked) {
        this.#waiters.push(resolve);
        return;
      }
      this.#locked = true;
      resolve(this.#releaser());
    });
  }

  #releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next === undefined) this.#locked = false;
      else next(this.#releaser());
    };
  }
}
