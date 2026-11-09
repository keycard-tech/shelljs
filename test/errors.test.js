// Status codes and error types shared by transports and commands.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const Errors = require("../lib/errors.js");
const {
  StatusCodes,
  getAltStatusMessage,
  TransportError,
  TransportStatusError,
  LockedDeviceError,
  createCustomErrorClass,
  HwTransportError,
  HwTransportErrorType,
} = require("../lib/errors.js");

describe("StatusCodes", () => {
  test("OK is 0x9000", () => {
    assert.equal(StatusCodes.OK, 0x9000);
  });

  test("every code is a 16-bit number", () => {
    for (const [name, code] of Object.entries(StatusCodes)) {
      assert.equal(typeof code, "number", name);
      assert.ok(code >= 0 && code <= 0xffff, `${name} = ${code} is outside 16 bits`);
    }
  });

  test("codes are unique, so a status maps back to a single name", () => {
    const values = Object.values(StatusCodes);
    assert.equal(new Set(values).size, values.length, JSON.stringify(values.filter((v, i) => values.indexOf(v) !== i)));
  });

  test("documented codes keep their protocol values", () => {
    assert.equal(StatusCodes.INCORRECT_DATA, 0x6a80);
    assert.equal(StatusCodes.CONDITIONS_OF_USE_NOT_SATISFIED, 0x6985);
    assert.equal(StatusCodes.INCORRECT_LENGTH, 0x6700);
    assert.equal(StatusCodes.INS_NOT_SUPPORTED, 0x6d00);
    assert.equal(StatusCodes.LOCKED_DEVICE, 0x5515);
    assert.equal(StatusCodes.USER_REFUSED_ON_DEVICE, 0x5501);
  });
});

describe("getAltStatusMessage", () => {
  test("explains the common statuses", () => {
    assert.equal(getAltStatusMessage(0x6700), "Incorrect length");
    assert.equal(getAltStatusMessage(0x6800), "Missing critical parameter");
    assert.equal(getAltStatusMessage(0x6982), "Security not satisfied (dongle locked or have invalid access rights)");
    assert.equal(getAltStatusMessage(0x6985), "Condition of use not satisfied (denied by the user?)");
    assert.equal(getAltStatusMessage(0x6a80), "Invalid data received");
    assert.equal(getAltStatusMessage(0x6b00), "Invalid parameter received");
    assert.equal(getAltStatusMessage(0x5515), "Locked device");
  });

  test("any 0x6fxx status is reported as an internal error", () => {
    for (const code of [0x6f00, 0x6f42, 0x6faa, 0x6fff]) {
      assert.equal(getAltStatusMessage(code), "Internal error, please report", `0x${code.toString(16)}`);
    }
  });

  test("unknown statuses have no message", () => {
    assert.equal(getAltStatusMessage(0x1234) ?? null, null);
  });
});

describe("TransportError", () => {
  test("carries a message and an machine-readable id", () => {
    const e = new TransportError("no device", "NoDevice");
    assert.equal(e.message, "no device");
    assert.equal(e.id, "NoDevice");
    assert.equal(e.name, "TransportError");
    assert.ok(e instanceof Error);
    assert.ok(typeof e.stack === "string" && e.stack.length > 0);
  });

  test("falls back to a default message", () => {
    const e = new TransportError(undefined, "X");
    assert.equal(e.message, "TransportError");
  });
});

describe("TransportStatusError", () => {
  test("formats the device status into the message", () => {
    const e = new TransportStatusError(0x6985);
    assert.equal(e.statusCode, 0x6985);
    assert.equal(e.statusText, "CONDITIONS_OF_USE_NOT_SATISFIED");
    assert.match(e.message, /0x6985/);
    assert.match(e.message, /denied by the user/i);
  });

  test("an unknown status still produces a usable error", () => {
    const e = new TransportStatusError(0x1234);
    assert.equal(e.statusCode, 0x1234);
    assert.equal(e.statusText, "UNKNOWN_ERROR");
    assert.match(e.message, /0x1234/);
  });

  test("a locked device surfaces as LockedDeviceError", () => {
    assert.throws(() => new TransportStatusError(StatusCodes.LOCKED_DEVICE), e => e instanceof LockedDeviceError);
  });
});

describe("createCustomErrorClass", () => {
  test("produces a named Error subclass", () => {
    const MyError = createCustomErrorClass("MyError");
    const e = new MyError("boom");
    assert.equal(e.name, "MyError");
    assert.equal(e.message, "boom");
    assert.ok(e instanceof Error);
    assert.ok(e instanceof MyError);
    assert.ok(e.stack.includes("MyError") || e.stack.length > 0);
  });

  test("copies extra fields onto the instance", () => {
    const E = createCustomErrorClass("WithFields");
    const e = new E("m", { statusCode: 42, detail: "x" });
    assert.equal(e.statusCode, 42);
    assert.equal(e.detail, "x");
  });

  test("attaches a cause when one is supplied", () => {
    const E = createCustomErrorClass("WithCause");
    const inner = new Error("inner failure");
    const e = new E("outer", undefined, { cause: inner });

    assert.equal(e.cause, inner);
  });

  test("records the cause chain in the stack trace", () => {
    const E = createCustomErrorClass("WithCauseStack");
    const e = new E("outer", undefined, { cause: new Error("inner failure") });

    assert.match(String(e.stack), /CAUSE:/, "the cause is not reachable from the stack trace");
  });

  test("can be thrown and caught by class and by Error", () => {
    const E = createCustomErrorClass("Catchable");
    assert.throws(
      () => {
        throw new E("x");
      },
      E,
    );
    assert.throws(
      () => {
        throw new E("x");
      },
      Error,
    );
  });
});

describe("HwTransportError", () => {
  test("keeps a type and message and stays an Error", () => {
    const e = new HwTransportError(HwTransportErrorType.BluetoothScanStartFailed, "scan failed");
    assert.equal(e.name, "HwTransportError");
    assert.equal(e.type, "BluetoothScanStartFailed");
    assert.equal(e.message, "scan failed");
    assert.ok(e instanceof Error);
  });
});

describe("error module surface", () => {
  test("the error classes transports construct are all exported", () => {
    for (const name of [
      "CantOpenDevice",
      "DisconnectedDevice",
      "DisconnectedDeviceDuringOperation",
      "TransportOpenUserCancelled",
      "TransportInterfaceNotAvailable",
      "TransportRaceCondition",
      "LockedDeviceError",
      "InvalidTxData",
    ]) {
      assert.equal(typeof Errors[name], "function", `${name} is missing`);
      const e = new Errors[name]("x");
      assert.equal(e.name, name);
      assert.ok(e instanceof Error);
    }
  });
});
