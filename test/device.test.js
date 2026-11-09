/**
 * ShellDevice: mapping USB product ids / product names to a known model.
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { ShellDevice } = require("../lib/device.js");

describe("identifyUSBProductId", () => {
  test("recognises the Keycard Shell", () => {
    const model = ShellDevice.identifyUSBProductId(0x21f7);
    assert.equal(model.productName, "Keycard Shell");
    assert.equal(model.productId, 0x21f7);
  });

  test("recognises the Keycard Shell (Beta)", () => {
    const model = ShellDevice.identifyUSBProductId(0x0001);
    assert.equal(model.productName, "Keycard Shell (Beta)");
  });

  test("every known model has a unique id and product id", () => {
    const known = [0x0001, 0x21f7].map(id => ShellDevice.identifyUSBProductId(id));
    assert.deepEqual(
      known.map(m => m.id),
      [...new Set(known.map(m => m.id))],
    );
  });

  test("returns nothing for an unknown product id", () => {
    assert.ok(!ShellDevice.identifyUSBProductId(0x1234));
  });

  test("does not match the vendor id or zero", () => {
    assert.ok(!ShellDevice.identifyUSBProductId(0));
    assert.ok(!ShellDevice.identifyUSBProductId(0x1209));
  });

  test("is tolerant of non-numeric input", () => {
    assert.ok(!ShellDevice.identifyUSBProductId(undefined));
    assert.ok(!ShellDevice.identifyUSBProductId("8695"));
  });
});

describe("identifyProductName", () => {
  test("matches an exact product name", () => {
    assert.equal(ShellDevice.identifyProductName("Keycard Shell").productId, 0x21f7);
    assert.equal(ShellDevice.identifyProductName("Keycard Shell (Beta)").productId, 0x0001);
  });

  test("returns nothing for a name that is not ours", () => {
    assert.ok(!ShellDevice.identifyProductName("Some Other Device"));
    assert.ok(!ShellDevice.identifyProductName(""));
  });

  test("does not match a different spelling of a known device", () => {
    assert.ok(!ShellDevice.identifyProductName("keycard shell"));
    assert.ok(!ShellDevice.identifyProductName("Keycard  Shell"));
  });

  test("is tolerant of non-string input", () => {
    assert.ok(!ShellDevice.identifyProductName(undefined));
    assert.ok(!ShellDevice.identifyProductName(0x21f7));
  });
});
