/**
 * Log bus: a single fan-out point used by transports to report APDU traffic.
 * Because the traffic can contain documents and signatures being produced, the
 * way listeners attach matters.
 */
const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { log, listen, trace, LocalTracer } = require("../lib/logs.js");

const collect = () => {
  const seen = [];
  const off = listen(l => seen.push(l));
  return { seen, off };
};

describe("log", () => {
  test("delivers type, id and date to subscribers", () => {
    const { seen, off } = collect();
    log("apdu", "hello");

    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, "apdu");
    assert.equal(seen[0].message, "hello");
    assert.ok(seen[0].id);
    assert.ok(seen[0].date instanceof Date);
    off();
  });

  test("message and data are absent when not supplied", () => {
    const { seen, off } = collect();
    log("bare");
    assert.equal("message" in seen[0], false);
    assert.equal("data" in seen[0], false);
    off();
  });

  test("carries a data payload", () => {
    const { seen, off } = collect();
    log("x", "m", { bytes: 12 });
    assert.deepEqual(seen[0].data, { bytes: 12 });
    off();
  });

  test("ids are unique and increase", () => {
    const { seen, off } = collect();
    log("a");
    log("b");
    log("c");
    const ids = seen.map(l => Number(l.id));
    assert.equal(new Set(ids).size, 3);
    assert.deepEqual(ids, [...ids].sort((x, y) => x - y));
    off();
  });

  test("every subscriber receives every entry", () => {
    const a = collect();
    const b = collect();
    log("broadcast", "hi");

    assert.equal(a.seen.length, 1);
    assert.equal(b.seen.length, 1);
    a.off();
    b.off();
  });

  test("unsubscribe stops delivery to that listener only", () => {
    const a = collect();
    const b = collect();

    a.off();
    log("after", "x");

    assert.equal(a.seen.length, 0);
    assert.equal(b.seen.length, 1);
    b.off();
  });

  test("a throwing subscriber cannot starve the others", () => {
    const offBad = listen(() => {
      throw new Error("subscriber exploded");
    });
    const good = collect();

    assert.doesNotThrow(() => log("survives", "x"));
    assert.equal(good.seen.length, 1);

    offBad();
    good.off();
  });

  test("subscribing the same function twice registers it twice", () => {
    let calls = 0;
    const cb = () => calls++;
    const off1 = listen(cb);
    const off2 = listen(cb);

    log("twice");
    assert.equal(calls, 2);

    off1();
    off2();
  });
});

describe("trace", () => {
  test("forwards type, message, data and context", () => {
    const { seen, off } = collect();
    trace({ type: "transport", message: "m", data: { d: 1 }, context: { descriptor: "usb:1" } });

    assert.equal(seen[0].type, "transport");
    assert.equal(seen[0].message, "m");
    assert.deepEqual(seen[0].data, { d: 1 });
    assert.deepEqual(seen[0].context, { descriptor: "usb:1" });
    off();
  });
});

describe("LocalTracer", () => {
  test("stamps its own type and context onto every entry", () => {
    const { seen, off } = collect();
    new LocalTracer("transport", { id: 7 }).trace("hello");

    assert.equal(seen[0].type, "transport");
    assert.deepEqual(seen[0].context, { id: 7 });
    off();
  });

  test("context can be replaced or merged", () => {
    const tracer = new LocalTracer("t", { a: 1 });
    tracer.updateContext({ b: 2 });
    assert.deepEqual(tracer.getContext(), { a: 1, b: 2 });

    tracer.setContext({ c: 3 });
    assert.deepEqual(tracer.getContext(), { c: 3 });

    tracer.setContext(undefined);
    assert.equal(tracer.getContext(), undefined);
  });

  test("withType / withContext / withUpdatedContext return new tracers and leave the original alone", () => {
    const original = new LocalTracer("transport", { a: 1 });

    const typed = original.withType("apdu");
    assert.equal(typed.getType(), "apdu");
    assert.equal(original.getType(), "transport");

    const contextual = original.withContext({ z: 9 });
    assert.deepEqual(contextual.getContext(), { z: 9 });
    assert.deepEqual(original.getContext(), { a: 1 });

    const merged = original.withUpdatedContext({ b: 2 });
    assert.deepEqual(merged.getContext(), { a: 1, b: 2 });
    assert.deepEqual(original.getContext(), { a: 1 });
  });

  test("setType mutates in place", () => {
    const tracer = new LocalTracer("a");
    tracer.setType("b");
    assert.equal(tracer.getType(), "b");
  });
});

describe("environment hygiene", () => {
  afterEach(() => {
    delete globalThis.window;
  });

  test("loading the module does not add globals in a non-browser environment", () => {
    assert.equal(typeof globalThis.window, "undefined");
    assert.equal(globalThis.__shellLogsListen, undefined, "the log hook must not leak into globalThis");
  });

  test("the browser log hook is not installed implicitly", () => {
    // Simulate a page: a fresh copy of the module is loaded with window defined.
    // Anything reachable from window is reachable from every other script on the
    // page, so subscribing to device traffic has to stay an explicit opt-in.
    const logsPath = require.resolve("../lib/logs.js");
    delete require.cache[logsPath];
    globalThis.window = {};
    require(logsPath);

    const exposed = Object.keys(globalThis.window).filter(k => /logs/i.test(k));
    delete require.cache[logsPath];
    require(logsPath);

    assert.deepEqual(exposed, [], `window was extended with ${JSON.stringify(exposed)}`);
  });
});
