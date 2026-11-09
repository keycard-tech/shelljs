/**
 * promise helpers used around flaky device operations.
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { delay, retry, atomicQueue, execAndWaitAtLeast, promiseAllBatched } = require("../lib/promise.js");

describe("delay", () => {
  test("resolves after roughly the requested time", async () => {
    const start = Date.now();
    await delay(30);
    assert.ok(Date.now() - start >= 25, `resolved after ${Date.now() - start}ms`);
  });

  test("delay(0) still yields to the event loop", async () => {
    const order = [];
    await delay(0).then(() => order.push("delayed"));
    assert.deepEqual(order, ["delayed"]);
  });
});

describe("retry", () => {
  test("returns the value when the first attempt succeeds", async () => {
    let calls = 0;
    const res = await retry(async () => {
      calls++;
      return "ok";
    });
    assert.equal(res, "ok");
    assert.equal(calls, 1);
  });

  test("retries a transient failure and resolves", async () => {
    let calls = 0;
    const res = await retry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("transient");
        return "ok";
      },
      { interval: 1 },
    );

    assert.equal(res, "ok");
    assert.equal(calls, 3);
  });

  test("gives up after maxRetry attempts and rejects with the last error", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        retry(
          async () => {
            calls++;
            throw new Error(`attempt ${calls}`);
          },
          { maxRetry: 3, interval: 1 },
        ),
      /attempt 4/,
    );
    assert.equal(calls, 4, "initial attempt plus 3 retries");
  });

  test("waits longer between attempts when an interval multiplicator is set", async () => {
    let calls = 0;
    const start = Date.now();

    await assert.rejects(
      () =>
        retry(
          async () => {
            calls++;
            throw new Error("nope");
          },
          { maxRetry: 2, interval: 20, intervalMultiplicator: 2 },
        ),
    );

    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 55, `expected >= 20 + 40ms of backoff, waited ${elapsed}ms`);
  });

  test("a function that throws synchronously produces a rejected promise", async () => {
    // Callers do retry(f).catch(...); a synchronous throw escapes that chain.
    let p;
    assert.doesNotThrow(() => {
      p = retry(() => {
        throw new Error("sync boom");
      }, { maxRetry: 1, interval: 1 });
    }, "retry() must always return a promise");

    await assert.rejects(() => p, /sync boom/);
  });

  test("retries a function that returns a rejected promise", async () => {
    let calls = 0;
    const res = await retry(
      () =>
        new Promise((resolve, reject) => {
          calls++;
          if (calls < 2) reject(new Error("busy"));
          else resolve("ok");
        }),
      { interval: 1 },
    );
    assert.equal(res, "ok");
  });
});

describe("atomicQueue", () => {
  test("serialises jobs that share a queue identifier", async () => {
    let running = 0;
    let maxRunning = 0;
    const job = atomicQueue(async id => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await delay(10);
      running--;
      return id;
    }, id => "shared");

    const results = await Promise.all([job(1), job(2), job(3)]);
    assert.deepEqual(results, [1, 2, 3]);
    assert.equal(maxRunning, 1, "jobs overlapped");
  });

  test("jobs on different identifiers are not blocked by each other", async () => {
    let maxRunning = 0;
    let running = 0;
    const job = atomicQueue(async id => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await delay(15);
      running--;
      return id;
    }, id => `q${id}`);

    await Promise.all([job(1), job(2), job(3)]);
    assert.equal(maxRunning, 3);
  });

  test("a failing job does not wedge the queue", async () => {
    const job = atomicQueue(async id => {
      if (id === "bad") throw new Error("bad job");
      return id;
    }, () => "one");

    await assert.rejects(() => job("bad"), /bad job/);
    assert.equal(await job("good"), "good");
  });

  test("an unhandled rejection in the queue does not crash the process", async () => {
    const job = atomicQueue(async () => {
      throw new Error("dropped");
    }, () => "q");

    job().catch(() => {});
    await delay(20);
  });
});

describe("execAndWaitAtLeast", () => {
  test("holds the result for at least the requested time", async () => {
    const start = Date.now();
    const res = await execAndWaitAtLeast(40, async () => "value");

    assert.equal(res, "value");
    assert.ok(Date.now() - start >= 35, `returned after ${Date.now() - start}ms`);
  });

  test("does not add waiting when the work already took long enough", async () => {
    const start = Date.now();
    await execAndWaitAtLeast(10, async () => {
      await delay(60);
      return "slow";
    });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 110, `added unexpected extra wait (${elapsed}ms)`);
  });

  test("propagates errors immediately", async () => {
    await assert.rejects(
      () =>
        execAndWaitAtLeast(50, async () => {
          throw new Error("nope");
        }),
      /nope/,
    );
  });
});

describe("promiseAllBatched", () => {
  test("resolves every item and preserves input order", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const res = await promiseAllBatched(3, items, async i => {
      await delay((i % 4) + 1);
      return i * 2;
    });
    assert.deepEqual(res, items.map(i => i * 2));
  });

  test("never runs more than `batch` jobs at once", async () => {
    let running = 0;
    let maxRunning = 0;
    await promiseAllBatched(4, Array.from({ length: 24 }, (_, i) => i), async i => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await delay(5);
      running--;
    });
    assert.ok(maxRunning <= 4, `ran ${maxRunning} jobs concurrently (limit 4)`);
    assert.ok(maxRunning > 1, "never ran anything in parallel");
  });

  test("an empty list resolves to an empty list", async () => {
    assert.deepEqual(await promiseAllBatched(4, [], async () => 1), []);
  });

  test("propagates a failure", async () => {
    await assert.rejects(
      () => promiseAllBatched(2, [1, 2, 3, 4], async i => (i === 3 ? Promise.reject(new Error("item 3 failed")) : i)),
      /item 3 failed/,
    );
  });

  test("passes the item index to the callback", async () => {
    const indexes = [];
    await promiseAllBatched(2, ["a", "b", "c"], async (item, index) => {
      indexes.push(index);
      return item;
    });
    assert.deepEqual(indexes.sort((a, b) => a - b), [0, 1, 2]);
  });
});
