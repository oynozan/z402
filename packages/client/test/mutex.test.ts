import { describe, expect, it } from "vitest";
import { Mutex } from "../src/mutex.js";
import { flush } from "./manual-clock.js";

describe("Mutex", () => {
  it("grants the lock at once when it is free", async () => {
    const release = await new Mutex().acquire();
    expect(typeof release).toBe("function");
  });

  it("hands the lock to waiters in FIFO order", async () => {
    const mutex = new Mutex();
    const order: string[] = [];
    const first = await mutex.acquire();
    const waiters = ["a", "b", "c"].map((name) =>
      mutex.acquire().then((release) => {
        order.push(name);
        return release;
      }),
    );
    await flush();
    expect(order).toEqual([]);

    first();
    const a = await waiters[0];
    await flush();
    expect(order).toEqual(["a"]);

    a?.();
    const b = await waiters[1];
    await flush();
    expect(order).toEqual(["a", "b"]);

    b?.();
    const c = await waiters[2];
    expect(order).toEqual(["a", "b", "c"]);
    c?.();
  });

  it("the release function is idempotent: a second call does not release the next holder", async () => {
    const mutex = new Mutex();
    const first = await mutex.acquire();
    let secondHeld = false;
    let thirdHeld = false;
    const second = mutex.acquire().then((release) => {
      secondHeld = true;
      return release;
    });
    void mutex.acquire().then(() => {
      thirdHeld = true;
    });

    first();
    first();
    await second;
    await flush();
    expect(secondHeld).toBe(true);
    expect(thirdHeld).toBe(false);

    (await second)();
    await flush();
    expect(thirdHeld).toBe(true);
  });

  it("is free again once every holder released", async () => {
    const mutex = new Mutex();
    (await mutex.acquire())();
    let held = false;
    void mutex.acquire().then(() => {
      held = true;
    });
    await flush();
    expect(held).toBe(true);
  });
});
