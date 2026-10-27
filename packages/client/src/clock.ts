/** Time source for the scheme, tests pass a manual clock */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Calls `fn` once after `ms` and returns its cancel function */
  setTimer(ms: number, fn: () => void): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setTimer: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    // A lone safety timer must not keep the process alive after the last call
    timer.unref();
    return () => clearTimeout(timer);
  },
};
