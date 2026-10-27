import type { Clock } from "../src/clock.js";

interface Timer {
  at: number;
  seq: number;
  fn: () => void;
}

/** Drains pending microtasks so async code reaches its next clock wait, without being a timer */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A clock that only moves when the test calls `advance`, firing timers in deadline order */
export class ManualClock implements Clock {
  #now = 0;
  #seq = 0;
  #timers: Timer[] = [];

  now(): number {
    return this.#now;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.setTimer(ms, resolve);
    });
  }

  setTimer(ms: number, fn: () => void): () => void {
    const timer: Timer = { at: this.#now + Math.max(0, ms), seq: this.#seq++, fn };
    this.#timers.push(timer);
    return () => {
      this.#timers = this.#timers.filter((t) => t !== timer);
    };
  }

  get pendingTimers(): number {
    return this.#timers.length;
  }

  /** Moves time forward, firing each due timer at its deadline and letting the code it wakes run */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      await flush();
      const due = this.#timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (due === undefined) break;
      this.#timers = this.#timers.filter((t) => t !== due);
      this.#now = due.at;
      due.fn();
    }
    this.#now = target;
    await flush();
  }
}
