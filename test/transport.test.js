// Transport: APDU encoding, status handling, GET RESPONSE chaining, atomicity, events and create().

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const Transport = require("../lib/transport.js").default;
const { StatusCodes, TransportError } = require("../lib/errors.js");
const Commands = require("../lib/commands.js").default;
const {
  SW,
  reply,
  parseApdu,
  statusError,
  MockTransport,
  ScriptedTransport,
  SecureElementTransport,
} = require("./helpers/mock-device.js");
const { appConfigPayload, publicKeyPayload } = require("./helpers/eth-responses.js");

describe("send: APDU encoding", () => {
  test("writes CLA, INS, P1, P2, Lc and data in order", async () => {
    const t = new MockTransport(() => reply());
    await t.send(0xe0, 0x06, 0x01, 0x02, Buffer.from("aabbcc", "hex"));
    assert.equal(t.hexApdus()[0], "e006010203aabbcc");
  });

  test("sends an empty data field when none is given", async () => {
    const t = new MockTransport(() => reply());
    await t.send(0xe0, 0x06, 0x00, 0x00);
    assert.equal(t.hexApdus()[0], "e006000000");
  });

  test("resolves with the device payload followed by its status word", async () => {
    const t = new MockTransport(() => reply("112233"));
    const res = await t.send(0xe0, 0x02, 0x00, 0x00);
    assert.equal(res.toString("hex"), "1122339000");
  });

  test("accepts the largest data field the protocol allows (255 bytes)", async () => {
    const t = new MockTransport(() => reply());
    await t.send(0xe0, 0x02, 0x00, 0x00, Buffer.alloc(255, 0x41));
    assert.equal(parseApdu(t.apdus[0]).lc, 255);
  });

  test("rejects data that cannot be encoded in the one-byte Lc field, before touching the device", async () => {
    const t = new MockTransport(() => reply());
    await assert.rejects(
      () => t.send(0xe0, 0x02, 0x00, 0x00, Buffer.alloc(256)),
      e => e instanceof TransportError && e.id === "DataLengthTooBig",
    );
    assert.equal(t.exchangeCount, 0);
  });

});

describe("send: status handling", () => {
  test("throws TransportStatusError for a status outside the accepted list", async () => {
    const t = new MockTransport(() => reply(Buffer.alloc(0), SW.USER_REFUSED));
    await assert.rejects(
      () => t.send(0xe0, 0x04, 0x00, 0x00),
      e =>
        e.name === "TransportStatusError" &&
        e.statusCode === SW.USER_REFUSED &&
        e.statusText === "CONDITIONS_OF_USE_NOT_SATISFIED",
    );
  });

  test("accepts additional statuses passed through statusList", async () => {
    const t = new MockTransport(() => reply("aa", SW.USER_REFUSED));
    const res = await t.send(0xe0, 0x04, 0x00, 0x00, Buffer.alloc(0), [StatusCodes.OK, SW.USER_REFUSED]);
    assert.equal(res.toString("hex"), "aa6985");
  });

  test("an error raised by exchange() propagates unchanged", async () => {
    const boom = new Error("cable unplugged");
    const t = new MockTransport(() => boom);
    await assert.rejects(() => t.send(0xe0, 0x06, 0x00, 0x00), e => e === boom);
  });
});

describe("send: GET RESPONSE chaining", () => {
  const splitApplet = (first, rest) => ins => ({ response: first, remaining: rest });

  test("answers a 0x61xx status with GET RESPONSE on the same CLA, INS 0xc0, P1=P2=0, Lc=0", async () => {
    const t = new SecureElementTransport(splitApplet(Buffer.from("aabb", "hex"), Buffer.from("ccdd", "hex")));
    await t.send(0xe0, 0x06, 0x00, 0x00);
    assert.equal(t.hexApdus()[1], "e0c0000000");
  });

  test("reassembles a response split across one GET RESPONSE", async () => {
    const t = new SecureElementTransport(splitApplet(Buffer.from("aabb", "hex"), Buffer.from("ccdd", "hex")));
    const res = await t.send(0xe0, 0x06, 0x00, 0x00);
    assert.equal(res.toString("hex"), "aabbccdd9000");
  });

  test("reassembles a response split across several GET RESPONSEs", async () => {
    let hop = 0;
    const t = new MockTransport(() => {
      hop++;
      if (hop === 1) return reply("01", SW.GET_RESPONSE);
      if (hop === 2) return reply("02", SW.GET_RESPONSE);
      if (hop === 3) return reply("03", SW.GET_RESPONSE);
      return reply("04");
    });
    const res = await t.send(0xe0, 0x06, 0x00, 0x00);
    assert.equal(res.toString("hex"), "010203049000");
  });

  test("a GET RESPONSE that fails with a terminal status rejects with that status", async () => {
    const t = new MockTransport(apdu => (parseApdu(apdu).ins === 0xc0 ? statusError(SW.INCORRECT_DATA) : reply("aa", SW.GET_RESPONSE)));
    await assert.rejects(() => t.send(0xe0, 0x06, 0x00, 0x00), e => e.statusCode === SW.INCORRECT_DATA);
  });

  test("a device cannot keep the host chained forever", async () => {
    const t = new MockTransport(() => reply("aa", SW.GET_RESPONSE), { maxExchanges: 300 });
    await assert.rejects(
      () => t.send(0xe0, 0x06, 0x00, 0x00),
      e => e instanceof TransportError && /GET RESPONSE/i.test(e.message),
      "a device stuck on 0x61xx must produce a transport error, not an endless loop",
    );
    assert.ok(t.exchangeCount < 300, `gave up only after the mock budget was hit (${t.exchangeCount} exchanges)`);
  });

  test("a chained response larger than the APDU size limit is rejected", async () => {
    const t = new MockTransport(() => reply(Buffer.alloc(200), SW.GET_RESPONSE), { maxExchanges: 300 });
    await assert.rejects(
      () => t.send(0xe0, 0x06, 0x00, 0x00),
      e => e instanceof TransportError,
      "accumulated response must be bounded (max APDU response is 65535 bytes)",
    );
  });
});

describe("send: untrusted device output", () => {

  test("concurrent commands do not interleave on a device with a single response register", async () => {
    // A real applet holds one pending response; a new command discards it.
    const t = new SecureElementTransport((ins, apdu) => {
      if (ins === 0x06) return { response: appConfigPayload().subarray(0, 8), remaining: appConfigPayload().subarray(8), label: "CONFIG" };
      if (ins === 0x02) return { response: publicKeyPayload(), label: "PUBKEY" };
      return { response: Buffer.alloc(0), sw: SW.INS_NOT_SUPPORTED };
    });
    const cmd = new Commands(t);

    const [config, key] = await Promise.all([cmd.getAppConfiguration(), cmd.getPublicKey("44'/60'/0'/0/0")]);

    assert.equal(config.fwVersion, "3.0.4", "getAppConfiguration got a corrupted payload");
    assert.equal(config.serialNumber, "5b4f0c3d9e0f6f4a2b1c8d7e6f5a4b3c");
    assert.equal(config.publicKey, "04" + "bb".repeat(32));
    assert.equal(key.publicKey, "03" + "aa".repeat(32), "getPublicKey got a corrupted payload");
  });
});

describe("base class defaults", () => {
  test("exchange() is abstract", () => {
    assert.throws(() => new Transport().exchange(Buffer.alloc(5)), /exchange not implemented/);
  });

  test("close() resolves", async () => {
    await new Transport().close();
  });

  test("timeout setters store their values", () => {
    const t = new Transport();
    t.setExchangeTimeout(1234);
    t.setExchangeUnresponsiveTimeout(567);
    assert.equal(t.exchangeTimeout, 1234);
    assert.equal(t.unresponsiveTimeout, 567);
  });
});

describe("events", () => {
  test("listeners are called in registration order and can be removed", () => {
    const t = new MockTransport(() => reply());
    const seen = [];
    const a = v => seen.push(`a${v}`);
    const b = v => seen.push(`b${v}`);

    t.on("chunk-loaded", a);
    t.emit("chunk-loaded", 1);
    t.on("chunk-loaded", b);
    t.emit("chunk-loaded", 2);
    t.off("chunk-loaded", a);
    t.emit("chunk-loaded", 3);

    assert.deepEqual(seen, ["a1", "a2", "b2", "b3"]);
  });

  test("emitting an event nobody listens to is harmless", () => {
    assert.doesNotThrow(() => new MockTransport(() => reply()).emit("disconnect"));
  });
});

describe("exchangeAtomicImpl", () => {
  test("holds a busy flag for the duration of the job and clears it afterwards", async () => {
    const t = new Transport();
    const first = t.exchangeAtomicImpl(() => new Promise(res => setTimeout(res, 20)));
    assert.ok(t.exchangeBusyPromise, "busy flag set while running");
    await first;
    assert.equal(t.exchangeBusyPromise, null);
  });

  test("rejects a second concurrent job with TransportRaceCondition", async () => {
    const t = new Transport();
    const running = t.exchangeAtomicImpl(() => new Promise(res => setTimeout(res, 20)));
    await assert.rejects(() => t.exchangeAtomicImpl(() => Promise.resolve("x")), e => e.name === "TransportRaceCondition");
    await running;
  });

  test("clears the busy flag when the job throws", async () => {
    const t = new Transport();
    await assert.rejects(() => t.exchangeAtomicImpl(() => Promise.reject(new Error("boom"))), /boom/);
    assert.equal(t.exchangeBusyPromise, null);
  });

  test("emits unresponsive while a job stalls, then responsive", async () => {
    const t = new Transport();
    t.setExchangeUnresponsiveTimeout(5);
    const events = [];
    t.on("unresponsive", () => events.push("unresponsive"));
    t.on("responsive", () => events.push("responsive"));

    await t.exchangeAtomicImpl(() => new Promise(res => setTimeout(res, 30)));
    assert.deepEqual(events, ["unresponsive", "responsive"]);
  });
});

describe("exchangeBulk", () => {
  test("sends every APDU in order and streams each response to the observer", async () => {
    const t = new ScriptedTransport([reply("aa"), reply("bb"), reply("cc")]);
    const next = [];

    await new Promise((resolve, reject) => {
      t.exchangeBulk(
        [Buffer.from("e006000000", "hex"), Buffer.from("e002000000", "hex"), Buffer.from("e008000000", "hex")],
        { next: r => next.push(r.toString("hex")), error: reject, complete: resolve },
      );
    });

    assert.deepEqual(next, ["aa9000", "bb9000", "cc9000"]);
    assert.equal(t.exchangeCount, 3);
  });

  test("reports a failing status through observer.error and stops", async () => {
    const t = new ScriptedTransport([reply("aa"), reply(Buffer.alloc(0), SW.USER_REFUSED), reply("cc")]);
    const outcome = await new Promise(resolve => {
      t.exchangeBulk([Buffer.alloc(5), Buffer.alloc(5), Buffer.alloc(5)], {
        next: () => {},
        error: e => resolve({ kind: "error", e }),
        complete: () => resolve({ kind: "complete" }),
      });
    });

    assert.equal(outcome.kind, "error");
    assert.equal(outcome.e.statusCode, SW.USER_REFUSED);
  });

  test("unsubscribe() stops sending further APDUs", async () => {
    const t = new MockTransport(() => reply(), { delayMs: 10 });
    const sub = t.exchangeBulk([Buffer.alloc(5), Buffer.alloc(5), Buffer.alloc(5), Buffer.alloc(5)], {
      next: () => {},
      error: () => {},
      complete: () => {},
    });
    sub.unsubscribe();

    await new Promise(res => setTimeout(res, 80));
    assert.ok(t.exchangeCount <= 2, `kept sending after unsubscribe (${t.exchangeCount} exchanges)`);
  });

});

describe("create", () => {
  class AsyncListenTransport extends Transport {
    static listen(observer) {
      const timer = setTimeout(() => {
        observer.next({ type: "add", descriptor: "desc-1" });
        observer.complete();
      }, 5);
      this.unsubscribeCalls = 0;
      return {
        unsubscribe: () => {
          AsyncListenTransport.unsubscribeCalls++;
          clearTimeout(timer);
        },
      };
    }
    static open(descriptor) {
      this.openedWith = descriptor;
      return Promise.resolve(new AsyncListenTransport());
    }
  }

  test("opens the first descriptor reported by listen()", async () => {
    const transport = await AsyncListenTransport.create();
    assert.ok(transport instanceof AsyncListenTransport);
    assert.equal(AsyncListenTransport.openedWith, "desc-1");
  });

  test("stops listening once a device is found", async () => {
    await AsyncListenTransport.create();
    assert.ok(AsyncListenTransport.unsubscribeCalls > 0, "listen subscription was never released");
  });

  test("rejects with ListenTimeout when no device shows up in time", async () => {
    class SilentTransport extends Transport {
      static listen() {
        return { unsubscribe: () => {} };
      }
    }
    await assert.rejects(
      () => SilentTransport.create(1000, 20),
      e => e instanceof TransportError && e.id === "ListenTimeout",
    );
  });

  test("rejects with NoDeviceFound when listen() completes without a device", async () => {
    class EmptyTransport extends Transport {
      static listen(observer) {
        observer.complete();
        return { unsubscribe: () => {} };
      }
    }
    await assert.rejects(
      () => EmptyTransport.create(),
      e => e instanceof TransportError && e.id === "NoDeviceFound",
    );
  });

  test("propagates errors reported by listen()", async () => {
    class FailingTransport extends Transport {
      static listen(observer) {
        setTimeout(() => observer.error(new Error("usb stack failure")), 1);
        return { unsubscribe: () => {} };
      }
    }
    await assert.rejects(() => FailingTransport.create(), /usb stack failure/);
  });

  test("propagates failures from open()", async () => {
    class UnopenableTransport extends Transport {
      static listen(observer) {
        setTimeout(() => observer.next({ type: "add", descriptor: "x" }), 1);
        return { unsubscribe: () => {} };
      }
      static open() {
        return Promise.reject(new Error("device busy"));
      }
    }
    await assert.rejects(() => UnopenableTransport.create(), /device busy/);
  });

  test("works with a transport that reports devices synchronously", async () => {
    // Transports may emit "add" during the listen() call itself.
    class SyncListenTransport extends Transport {
      static listen(observer) {
        observer.next({ type: "add", descriptor: "sync-1" });
        observer.complete();
        return { unsubscribe: () => {} };
      }
      static open(descriptor) {
        return Promise.resolve(new SyncListenTransport());
      }
    }
    const transport = await SyncListenTransport.create();
    assert.ok(transport instanceof SyncListenTransport);
  });

  test("releases the subscription exactly once when devices are reported synchronously", async () => {
    let unsubscribeCalls = 0;
    class SyncTransport extends Transport {
      static listen(observer) {
        observer.next({ type: "add", descriptor: "sync-2" });
        observer.complete();
        return {
          unsubscribe: () => {
            unsubscribeCalls++;
          },
        };
      }
      static open() {
        return Promise.resolve(new SyncTransport());
      }
    }

    await SyncTransport.create();
    assert.equal(unsubscribeCalls, 1, "device enumeration was left subscribed (or released twice)");
  });
});

describe("exchange timeout", () => {
  test("an exchange that never answers is cut off by the configured exchange timeout", async () => {
    class DeafTransport extends Transport {
      exchange() {
        return new Promise(() => {});
      }
    }
    const t = new DeafTransport();
    t.setExchangeTimeout(20);

    const outcome = await Promise.race([
      t.send(0xe0, 0x06, 0x00, 0x00).then(
        () => "resolved",
        e => `rejected:${e.constructor.name}`,
      ),
      new Promise(res => setTimeout(() => res("NO_TIMEOUT"), 150)),
    ]);
    assert.notEqual(outcome, "NO_TIMEOUT", "setExchangeTimeout() does not bound exchange()");
  });
});
