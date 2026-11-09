/**
 * error-helpers: turning errors into plain data and back, e.g. to cross a
 * worker/iframe boundary. Input on the deserialize side is untrusted.
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { serializeError, deserializeError, createCustomErrorClass, addCustomErrorDeserializer } = require("../lib/error-helpers.js");
const { TransportError, TransportStatusError } = require("../lib/errors.js");

describe("serializeError", () => {
  test("passes primitives through", () => {
    assert.equal(serializeError(undefined), undefined);
    assert.equal(serializeError("text"), "text");
    assert.equal(serializeError(0), 0);
  });

  test("describes functions instead of dropping them silently", () => {
    assert.equal(serializeError(function named() {}), "[Function: named]");
    assert.equal(serializeError(() => {}), "[Function: anonymous]");
  });

  test("keeps the fields that identify an error", () => {
    const out = serializeError(new Error("kaboom"));
    assert.equal(out.message, "kaboom");
    assert.equal(out.name, "Error");
    assert.equal(typeof out.stack, "string");
  });

  test("drops function-valued properties", () => {
    const out = serializeError({ message: "m", handler: () => 1 });
    assert.deepEqual(Object.keys(out).sort(), ["message"]);
  });

  test("replaces cycles instead of throwing", () => {
    const a = { message: "cyclic", name: "Error" };
    a.self = a;
    const out = serializeError(a);
    assert.equal(out.self, "[Circular]");
    assert.equal(out.message, "cyclic");
  });

  test("walks nested objects", () => {
    const out = serializeError({ message: "outer", detail: { code: 7, inner: { flag: true } } });
    assert.deepEqual(out.detail, { code: 7, inner: { flag: true } });
  });
});

describe("deserializeError", () => {
  test("rebuilds a plain error from data", () => {
    const e = deserializeError({ name: "Error", message: "boom", stack: "trace" });
    assert.ok(e instanceof Error);
    assert.equal(e.message, "boom");
  });

  test("wraps non-objects as an Error", () => {
    assert.equal(deserializeError("plain").message, "plain");
    assert.ok(deserializeError(42) instanceof Error);
  });

  test("keeps unknown class names so callers can still branch on them", () => {
    const e = deserializeError({ name: "SomeTransportError", message: "x" });
    assert.equal(e.name, "SomeTransportError");
    assert.ok(e instanceof Error);
  });

  test("a message that merely looks like JSON is preserved verbatim", () => {
    const e = deserializeError({ name: "Error", message: '{"a":1}' });
    assert.equal(e.message, '{"a":1}');
  });

  test("restores registered library errors", () => {
    const e = deserializeError(serializeError(new TransportError("no device", "NoDevice")));
    assert.ok(e instanceof TransportError);
    assert.equal(e.id, "NoDevice");
    assert.equal(e.message, "no device");

    const s = deserializeError(serializeError(new TransportStatusError(0x6985)));
    assert.ok(s instanceof TransportStatusError);
    assert.equal(s.statusCode, 0x6985);
  });

  test("accepts a custom deserializer registered by an application", () => {
    addCustomErrorDeserializer("AppError", obj => new Error(`app:${obj.message}`));
    const e = deserializeError({ name: "AppError", message: "x" });
    assert.equal(e.message, "app:x");
  });

  test("an attacker-controlled __proto__ in the payload cannot change the prototype", () => {
    const payload = JSON.parse('{"name":"Error","message":"x","__proto__":{"privileged":true}}');
    const e = deserializeError(payload);

    assert.equal(Object.getPrototypeOf(e), Error.prototype);
    assert.equal(e.privileged, undefined);
    assert.equal({}.privileged, undefined);
  });

  test("constructor and prototype keys in the payload are ignored", () => {
    const e = deserializeError({ name: "Error", message: "x", constructor: "nope", prototype: "nope" });
    assert.equal(typeof e.constructor, "function");
    assert.equal(e.message, "x");
  });

  test("a hostile class name does not permanently grow the error registry", () => {
    for (let i = 0; i < 200; i++) deserializeError({ name: `Flood${i}`, message: "x" });
    const e = deserializeError({ name: "Error", message: "still fine" });
    assert.equal(e.message, "still fine");
  });

  test("round-trips a custom error class through serialize/deserialize", () => {
    const MyError = createCustomErrorClass("RoundTripError");
    const e = deserializeError(serializeError(new MyError("outer", { code: 9 })));
    assert.equal(e.name, "RoundTripError");
    assert.equal(e.message, "outer");
    assert.equal(e.code, 9);
  });
});
