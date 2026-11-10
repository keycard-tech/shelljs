// Transport doubles that model a real secure element; device output is untrusted and mocks cannot hang.

const Transport = require("../../lib/transport.js").default;
const { TransportStatusError } = require("../../lib/errors.js");

const SW = {
  OK: 0x9000,
  GET_RESPONSE: 0x6100, // 0x61xx: "more data available, send GET RESPONSE"
  INCORRECT_DATA: 0x6a80,
  INCORRECT_LENGTH: 0x6700,
  USER_REFUSED: 0x6985,
  SECURITY_STATUS_NOT_SATISFIED: 0x6982,
  MEMORY_PROBLEM: 0x9240,
  LOCKED_DEVICE: 0x5515,
  INS_NOT_SUPPORTED: 0x6d00,
  CLA_NOT_SUPPORTED: 0x6e00,
};

const toBuf = value => {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "hex");
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  return Buffer.from(value);
};

/** A device reply: payload followed by the 2-byte status word. */
const reply = (payload = Buffer.alloc(0), sw = SW.OK) =>
  Buffer.concat([toBuf(payload), Uint8Array.from([(sw >> 8) & 0xff, sw & 0xff])]);

const parseApdu = apdu => ({
  cla: apdu[0],
  ins: apdu[1],
  p1: apdu[2],
  p2: apdu[3],
  lc: apdu[4],
  data: apdu.subarray(5),
});

/** Read back a [count][4-byte BE elements] BIP-32 path from an APDU payload. */
const readPath = (data, offset = 0) => {
  const count = data[offset];
  const path = [];
  for (let i = 0; i < count; i++) path.push(data.readUInt32BE(offset + 1 + i * 4));
  return { count, path };
};

const statusError = sw => new TransportStatusError(sw);

class MockTransportBase extends Transport {
  constructor({ maxExchanges = 100, delayMs = 0, ...tracerOpts } = {}) {
    super(tracerOpts);
    this.apdus = [];
    this.exchangeCount = 0;
    this.maxExchanges = maxExchanges;
    this.delayMs = delayMs;
  }

  exchange(apdu) {
    this.exchangeCount++;
    this.apdus.push(Buffer.from(apdu));
    if (this.exchangeCount > this.maxExchanges) {
      return Promise.reject(
        new Error(`MOCK_EXCHANGE_BUDGET_EXCEEDED (${this.maxExchanges}): code under test kept talking to the device`),
      );
    }
    const run = () => this.onExchange(Buffer.from(apdu));
    if (this.delayMs <= 0) return Promise.resolve().then(run);
    return new Promise((resolve, reject) => setTimeout(() => Promise.resolve().then(run).then(resolve, reject), this.delayMs));
  }

  hexApdus() {
    return this.apdus.map(a => a.toString("hex"));
  }

  /** Bytes sent as command payloads (Lc..), ignoring headers. */
  payloads() {
    return this.apdus.map(a => parseApdu(a).data);
  }
}

class MockTransport extends MockTransportBase {
  constructor(handler, opts = {}) {
    super(opts);
    this.handler = handler;
  }
  onExchange(apdu) {
    const out = this.handler(apdu, this);
    if (out instanceof Error) throw out;
    return toBuf(out);
  }
}

/** Scripted mock: answers from a queue, repeating the final entry. */
class ScriptedTransport extends MockTransportBase {
  constructor(replies = [], opts = {}) {
    super(opts);
    this.replies = replies.slice();
  }
  onExchange() {
    const next = this.replies.length > 1 ? this.replies.shift() : this.replies[0];
    if (next instanceof Error) throw next;
    return toBuf(next === undefined ? reply() : next);
  }
}

// Secure element emulator: GET RESPONSE (0xc0) returns the staged remainder and any other command discards it; handlers return {response, sw} | {response, remaining} | {error}.
class SecureElementTransport extends MockTransportBase {
  constructor(applet, opts = {}) {
    super(opts);
    this.applet = applet;
    this.staged = null;
    this.trace = [];
  }

  onExchange(apdu) {
    const { ins } = parseApdu(apdu);

    if (ins === 0xc0) {
      const out = this.staged === null ? Buffer.alloc(0) : this.staged;
      this.staged = null;
      this.trace.push(`GET_RESPONSE(${out.length})`);
      return reply(out);
    }

    const out = this.applet(ins, apdu, this) || {};
    if (out.error) throw out.error;

    if (out.remaining !== undefined && out.remaining !== null) {
      this.staged = toBuf(out.remaining);
      this.trace.push(`${out.label || `INS 0x${ins.toString(16)}`}(+${this.staged.length})`);
      return reply(out.response, SW.GET_RESPONSE);
    }

    this.staged = null;
    this.trace.push(out.label || `INS 0x${ins.toString(16)}`);
    return reply(out.response, out.sw === undefined ? SW.OK : out.sw);
  }
}

module.exports = {
  SW,
  reply,
  toBuf,
  parseApdu,
  readPath,
  statusError,
  MockTransport,
  ScriptedTransport,
  SecureElementTransport,
};
