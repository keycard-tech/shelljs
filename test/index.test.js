// Public surface consumed by shelljs-node-hid / shelljs-web-hid as ShellJS.<Member>.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const pkg = require("../lib/index.js");
const ShellJS = pkg.default;

const EXPECTED_MEMBERS = [
  "Commands",
  "ShellDevice",
  "ShellError",
  "ShellErrorHelpers",
  "HIDFraming",
  "ShellLogs",
  "ShellPromise",
  "Transport",
];

describe("package entry point", () => {
  test("default export exposes the documented namespace", () => {
    assert.deepEqual(Object.keys(ShellJS).sort(), [...EXPECTED_MEMBERS].sort());
  });

  test("the named ShellJS export is the same object as the default export", () => {
    assert.equal(pkg.ShellJS, ShellJS);
  });

  test("Commands and Transport are constructible", () => {
    assert.equal(typeof ShellJS.Commands, "function");
    assert.equal(typeof ShellJS.Transport, "function");

    const transport = new ShellJS.Transport();
    const cmd = new ShellJS.Commands(transport);
    assert.equal(cmd.transport, transport);
  });

  test("the Transport API transports subclass is present", () => {
    // send / exchangeAtomicImpl are instance fields, so they cannot be found on the prototype.
    const instance = new ShellJS.Transport();
    for (const method of ["send", "exchange", "close", "on", "off", "emit", "exchangeBulk", "exchangeAtomicImpl"]) {
      assert.equal(typeof instance[method], "function", `Transport#${method}`);
    }
    assert.equal(typeof instance.exchangeBulk, "function");
    assert.equal(typeof ShellJS.Transport.create, "function", "Transport.create");
    assert.equal(typeof ShellJS.Transport.ErrorMessage_NoDeviceFound, "string");
  });

  test("a consumer can subclass Transport the way shelljs-*-hid does", () => {
    class MyTransport extends ShellJS.Transport {
      exchange() {
        return Promise.resolve(Buffer.from([0x90, 0x00]));
      }
    }
    const t = new MyTransport({ context: { a: 1 }, logType: "hid" });
    assert.ok(t instanceof ShellJS.Transport);
    assert.equal(t.exchangeTimeout, 30000);
  });

  test("HIDFraming exposes what the HID transports need", () => {
    assert.equal(typeof ShellJS.HIDFraming.hidFraming, "function");
    assert.equal(ShellJS.HIDFraming.shellUSBVendorId, 0x1209);
  });

  test("ShellDevice exposes the model lookups", () => {
    assert.equal(typeof ShellJS.ShellDevice.identifyUSBProductId, "function");
    assert.equal(typeof ShellJS.ShellDevice.identifyProductName, "function");
  });

  test("ShellLogs exposes the log bus", () => {
    assert.equal(typeof ShellJS.ShellLogs.log, "function");
    assert.equal(typeof ShellJS.ShellLogs.listen, "function");
    assert.equal(typeof ShellJS.ShellLogs.LocalTracer, "function");
  });

  test("ShellError classes can be constructed and matched as the transports do", () => {
    const err = new ShellJS.ShellError.DisconnectedDeviceDuringOperation("cable pulled");
    assert.ok(err instanceof Error);
    assert.equal(err.name, "DisconnectedDeviceDuringOperation");

    const te = new ShellJS.ShellError.TransportError("NoDevice", "NoDevice");
    assert.equal(te.id, "NoDevice");
  });

  test("ShellErrorHelpers exposes error (de)serialisation", () => {
    assert.equal(typeof ShellJS.ShellErrorHelpers.serializeError, "function");
    assert.equal(typeof ShellJS.ShellErrorHelpers.deserializeError, "function");
  });

  test("ShellPromise exposes the helper set", () => {
    for (const name of ["delay", "retry", "atomicQueue", "execAndWaitAtLeast", "promiseAllBatched"]) {
      assert.equal(typeof ShellJS.ShellPromise[name], "function", name);
    }
  });

  test("utils re-exported from the commands module are reachable", () => {
    const commands = require("../lib/commands.js");
    assert.equal(typeof commands.splitPath, "function");
    assert.equal(typeof commands.decodeTxInfo, "function");
  });
});
