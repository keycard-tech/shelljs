// Framing: block = [channel:u16BE][tag 0x05][seq:u16BE][payload]; the first payload carries [apduLength:u16BE][apdu].

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { hidFraming, shellUSBVendorId } = require("../lib/hid-framing.js");
const { TransportError } = require("../lib/errors.js");

const CHANNEL = 0x1007;
const PACKET = 64;
const BLOCK_PAYLOAD = PACKET - 5;

const blockHeader = (channel, tag, seq) => Buffer.concat([Uint8Array.from([(channel >> 8) & 0xff, channel & 0xff, tag, (seq >> 8) & 0xff, seq & 0xff])]);

describe("vendor id", () => {
  test("the Shell USB vendor id is 0x1209", () => {
    assert.equal(shellUSBVendorId, 0x1209);
  });
});

describe("makeBlocks", () => {
  test("wraps an APDU in one block with channel, tag, sequence and length prefix", () => {
    const apdu = Buffer.from("e006000000", "hex");
    const blocks = hidFraming(CHANNEL, PACKET).makeBlocks(apdu);

    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].length, PACKET, "a block must be exactly one HID report");
    assert.equal(blocks[0].subarray(0, 5).toString("hex"), blockHeader(CHANNEL, 0x05, 0).toString("hex"));
    assert.equal(blocks[0].readUInt16BE(5), apdu.length, "payload starts with the APDU length");
    assert.equal(blocks[0].subarray(7, 7 + apdu.length).toString("hex"), apdu.toString("hex"));
  });

  test("pads the tail of the last block with zeroes", () => {
    const apdu = Buffer.from("e006000000", "hex");
    const block = hidFraming(CHANNEL, PACKET).makeBlocks(apdu)[0];
    assert.match(block.subarray(7 + apdu.length).toString("hex"), /^0+$/);
  });

  test("splits a large APDU across blocks with an incrementing sequence number", () => {
    const apdu = Buffer.alloc(200, 0xab);
    const blocks = hidFraming(CHANNEL, PACKET).makeBlocks(apdu);

    assert.equal(blocks.length, Math.ceil((apdu.length + 2) / BLOCK_PAYLOAD));
    blocks.forEach((b, i) => {
      assert.equal(b.length, PACKET, `block ${i} size`);
      assert.equal(b.readUInt16BE(0), CHANNEL, `block ${i} channel`);
      assert.equal(b[2], 0x05, `block ${i} tag`);
      assert.equal(b.readUInt16BE(3), i, `block ${i} sequence`);
    });
  });

  test("only the first block carries the length prefix", () => {
    const apdu = Buffer.alloc(200, 0xab);
    const blocks = hidFraming(CHANNEL, PACKET).makeBlocks(apdu);

    const payload = Buffer.concat([blocks[0].subarray(7), ...blocks.slice(1).map(b => b.subarray(5))]);
    assert.equal(payload.subarray(0, apdu.length).toString("hex"), apdu.toString("hex"));
  });

  test("handles an APDU that exactly fills a block payload", () => {
    const apdu = Buffer.alloc(BLOCK_PAYLOAD - 2, 0xcd);
    const blocks = hidFraming(CHANNEL, PACKET).makeBlocks(apdu);
    const payload = Buffer.concat([blocks[0].subarray(7), ...blocks.slice(1).map(b => b.subarray(5))]);
    assert.equal(payload.subarray(0, apdu.length).toString("hex"), apdu.toString("hex"));
  });

  test("handles an empty APDU", () => {
    const blocks = hidFraming(CHANNEL, PACKET).makeBlocks(Buffer.alloc(0));
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].readUInt16BE(5), 0);
  });

  test("rejects an APDU too large to record its own length", () => {
    const huge = Buffer.alloc(70000, 1);
    assert.throws(
      () => hidFraming(CHANNEL, PACKET).makeBlocks(huge),
      e => e instanceof TransportError,
      "an over-sized APDU must raise a TransportError",
    );
  });
});

describe("reduceResponse", () => {
  // The length field of the first block declares the TOTAL response length, not that block's size.
  const firstBlock = (data, { total = data.length, channel = CHANNEL, tag = 0x05, seq = 0 } = {}) =>
    Buffer.concat([blockHeader(channel, tag, seq), Uint8Array.from([(total >> 8) & 0xff, total & 0xff]), data]);
  const nextBlock = (data, seq = 1, opts = {}) =>
    Buffer.concat([blockHeader(opts.channel ?? CHANNEL, opts.tag ?? 0x05, seq), data]);

  test("reads the total length from the first block", () => {
    const acc = hidFraming(CHANNEL, PACKET).reduceResponse(null, firstBlock(Buffer.from("aabbcc", "hex")));
    assert.equal(acc.dataLength, 3);
    assert.equal(acc.data.toString("hex"), "aabbcc");
    assert.equal(acc.sequence, 1);
  });

  test("appends continuation blocks", () => {
    const f = hidFraming(CHANNEL, PACKET);
    let acc = f.reduceResponse(null, firstBlock(Buffer.from("aabb", "hex"), { total: 4 }));
    assert.equal(f.getReducedResult(acc), undefined, "response is not complete yet");

    acc = f.reduceResponse(acc, nextBlock(Buffer.from("ccdd", "hex"), 1));
    assert.equal(acc.data.toString("hex"), "aabbccdd");
    assert.equal(f.getReducedResult(acc).toString("hex"), "aabbccdd");
  });

  test("getReducedResult returns nothing until every declared byte arrived", () => {
    const f = hidFraming(CHANNEL, PACKET);
    const acc = f.reduceResponse(null, firstBlock(Buffer.alloc(0), { total: 10 }));
    assert.equal(acc.dataLength, 10);
    assert.equal(f.getReducedResult(acc), undefined);
  });

  test("getReducedResult returns nothing for a null accumulator", () => {
    assert.equal(hidFraming(CHANNEL, PACKET).getReducedResult(null), undefined);
  });

  test("drops bytes beyond the declared response length", () => {
    const f = hidFraming(CHANNEL, PACKET);
    // the device declares 4 bytes but sends 5 across two blocks
    let acc = f.reduceResponse(null, firstBlock(Buffer.from("aabb", "hex"), { total: 4 }));
    acc = f.reduceResponse(acc, nextBlock(Buffer.from("ccddee", "hex"), 1));

    assert.equal(acc.data.length, acc.dataLength);
    assert.equal(f.getReducedResult(acc).toString("hex"), "aabbccdd");
  });

  test("rejects a block from another channel", () => {
    const f = hidFraming(CHANNEL, PACKET);
    assert.throws(
      () => f.reduceResponse(null, firstBlock(Buffer.from("aa", "hex"), { channel: CHANNEL + 1 })),
      e => e instanceof TransportError && e.id === "InvalidChannel",
    );
  });

  test("rejects a block with an unexpected tag", () => {
    const f = hidFraming(CHANNEL, PACKET);
    assert.throws(
      () => f.reduceResponse(null, firstBlock(Buffer.from("aa", "hex"), { tag: 0x06 })),
      e => e instanceof TransportError && e.id === "InvalidTag",
    );
  });

  test("rejects an out-of-order block", () => {
    const f = hidFraming(CHANNEL, PACKET);
    const acc = f.reduceResponse(null, firstBlock(Buffer.from("aa", "hex")));
    assert.throws(
      () => f.reduceResponse(acc, nextBlock(Buffer.from("bb", "hex"), 7)),
      e => e instanceof TransportError && e.id === "InvalidSequence",
    );
  });

  test("a truncated block is reported as a framing error, not a raw RangeError", () => {
    const f = hidFraming(CHANNEL, PACKET);
    for (const short of [Buffer.alloc(0), Buffer.alloc(4), Buffer.alloc(6)]) {
      assert.throws(
        () => f.reduceResponse(null, short),
        e => e instanceof TransportError,
        `${short.length}-byte report must raise TransportError`,
      );
    }
  });

  test("a truncated continuation block is reported as a framing error", () => {
    const f = hidFraming(CHANNEL, PACKET);
    const acc = f.reduceResponse(null, firstBlock(Buffer.from("aabb", "hex")));
    assert.throws(() => f.reduceResponse(acc, Buffer.alloc(3)), e => e instanceof TransportError);
  });
});

describe("framing round trip", () => {
  test("an APDU survives blocks -> reduce -> result", () => {
    for (const size of [0, 1, 57, 58, 59, 200, 1000]) {
      const apdu = Buffer.from([0xe0, 0x04, 0x00, 0x00, size & 0xff, ...Buffer.alloc(size, 0x5c)]);
      const f = hidFraming(CHANNEL, PACKET);
      const blocks = f.makeBlocks(apdu);

      let acc;
      for (const block of blocks) acc = f.reduceResponse(acc, block);
      const result = f.getReducedResult(acc);

      assert.ok(result, `no result for a ${size}-byte APDU (${blocks.length} blocks)`);
      assert.equal(result.toString("hex"), apdu.toString("hex"), `round trip of a ${size}-byte APDU`);
    }
  });
});
