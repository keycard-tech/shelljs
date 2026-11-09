// Commands: APDU wire format and reply parsing for every Shell command.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const Commands = require("../lib/commands.js").default;
const { TransportError } = require("../lib/errors.js");
const { SW, MockTransport, ScriptedTransport, parseApdu, readPath, reply, statusError } = require("./helpers/mock-device.js");
const { publicKeyPayload, signaturePayload, appConfigPayload, psbtBlob, blob } = require("./helpers/eth-responses.js");
const txs = require("./fixtures/transactions.js");

const PATH = "44'/60'/0'/0/0";
const HARDENED = [0x80000000 + 44, 0x80000000 + 60, 0x80000000 + 0, 0, 0];

/** [pathCount][paths...][body] - the shape of every command's first chunk. */
const pathPrefixed = (body, path = HARDENED) => {
  const buf = Buffer.alloc(1 + path.length * 4 + body.length);
  buf[0] = path.length;
  path.forEach((el, i) => buf.writeUInt32BE(el, 1 + 4 * i));
  body.copy(buf, 1 + path.length * 4);
  return buf;
};

/** Concatenate the payload of every APDU, optionally skipping a header on the first one. */
const reassemble = (apdus, firstHeaderBytes = 0, restHeaderBytes = 0) =>
  Buffer.concat(apdus.map((a, i) => parseApdu(a).data.subarray(i === 0 ? firstHeaderBytes : restHeaderBytes)));

describe("getPublicKey", () => {
  test("requests the key with CLA 0xE0, INS 0x02 and the BIP-32 path", async () => {
    const t = new MockTransport(() => reply(publicKeyPayload()));
    await new Commands(t).getPublicKey(PATH);

    const apdu = parseApdu(t.apdus[0]);
    assert.equal(apdu.cla, 0xe0);
    assert.equal(apdu.ins, 0x02);
    assert.equal(apdu.p1, 0x00);
    assert.deepEqual(readPath(apdu.data).path, HARDENED);
  });

  test("P2 selects whether the chain code is returned", async () => {
    const without = new MockTransport(() => reply(publicKeyPayload()));
    const withCc = new MockTransport(() => reply(publicKeyPayload({ chainCode: "cc".repeat(32) })));

    await new Commands(without).getPublicKey(PATH);
    await new Commands(withCc).getPublicKey(PATH, true);

    assert.equal(parseApdu(without.apdus[0]).p2, 0x00);
    assert.equal(parseApdu(withCc.apdus[0]).p2, 0x01);
  });

  test("parses fingerprint and public key from a well-formed reply", async () => {
    const t = new MockTransport(() => reply(publicKeyPayload()));
    const res = await new Commands(t).getPublicKey(PATH);

    assert.equal(res.fingerprint, "01020304");
    assert.equal(res.publicKey, "03" + "aa".repeat(32));
  });

  test("parses the chain code when it was requested", async () => {
    const chainCode = "cc".repeat(32);
    const t = new MockTransport(() => reply(publicKeyPayload({ chainCode })));
    const res = await new Commands(t).getPublicKey(PATH, true);

    assert.equal(res.chainCode, chainCode);
  });

  test("does not return a chain code that was not requested", async () => {
    const t = new MockTransport(() => reply(publicKeyPayload({ chainCode: "cc".repeat(32) })));
    const res = await new Commands(t).getPublicKey(PATH);

    assert.equal(res.chainCode, undefined);
  });

  test("rejects a reply that is too short to hold the documented fields", async () => {
    for (const bytes of [0, 1, 8, 35]) {
      const t = new MockTransport(() => reply(Buffer.alloc(bytes)));
      await assert.rejects(
        () => new Commands(t).getPublicKey(PATH),
        e => e instanceof TransportError,
        `${bytes}-byte payload must be rejected, not parsed`,
      );
    }
  });

  test("rejects a reply whose declared field lengths do not match the payload", async () => {
    // [fpLen=4][fp...] but only 6 bytes follow: no room for a 33-byte key
    const t = new MockTransport(() => reply(Buffer.from([4, 1, 2, 3, 4, 33, 0x90, 0x00])));
    await assert.rejects(() => new Commands(t).getPublicKey(PATH), e => e instanceof TransportError);
  });

  test("rejects a path with no components", async () => {
    const t = new MockTransport(() => reply(publicKeyPayload()));
    await assert.rejects(() => new Commands(t).getPublicKey(""), e => e instanceof Error && !(e instanceof TransportError) === false);
    assert.equal(t.exchangeCount, 0, "an empty path must not be sent");
  });

  test("rejects a path with more components than the protocol can count", async () => {
    const tooMany = Array.from({ length: 256 }, (_, i) => String(i % 10)).join("/");
    const t = new MockTransport(() => reply(publicKeyPayload()));

    await assert.rejects(
      () => new Commands(t).getPublicKey(tooMany),
      e => e instanceof Error,
      "256 path components do not fit the single count byte",
    );
    if (t.exchangeCount > 0) {
      assert.fail(`path was sent with count byte ${t.apdus[0][5]}, which is not ${256}`);
    }
  });

  test("rejects malformed path components instead of silently dropping them", async () => {
    const t = new MockTransport(() => reply(publicKeyPayload()));
    await assert.rejects(
      () => new Commands(t).getPublicKey("44'/60'/junk/0"),
      e => e instanceof Error,
      "'junk' must not be silently dropped from the derivation path",
    );
    if (t.exchangeCount > 0) assert.equal(readPath(parseApdu(t.apdus[0]).data).count, 4, "path length sent must match the input");
  });

  test("propagates a device error", async () => {
    const t = new MockTransport(() => statusError(SW.USER_REFUSED));
    await assert.rejects(() => new Commands(t).getPublicKey(PATH), e => e.statusCode === SW.USER_REFUSED);
  });
});

describe("signEthTransaction", () => {
  // Legacy tx in the hardware-wallet "ready to sign" shape: v carries the chain id, r and s are empty.
  const unsignedChainId1 = (() => {
    const { encode } = require("@ethersproject/rlp");
    return encode(["0x00", "0x04e3b29200", "0x5208", txs.TO, "0x01", "0xdeadbeef", "0x01", "0x", "0x"]).replace(/^0x/, "");
  })();

  test("sends the tx to INS 0x04 with the derivation path in front of it", async () => {
    const t = new MockTransport(() => reply(signaturePayload()));
    await new Commands(t).signEthTransaction(PATH, unsignedChainId1);

    const apdu = parseApdu(t.apdus[0]);
    assert.equal(apdu.cla, 0xe0);
    assert.equal(apdu.ins, 0x04);
    assert.equal(apdu.p1, 0x00);
    assert.equal(apdu.p2, 0x00);
    assert.deepEqual(readPath(apdu.data).path, HARDENED);
    assert.equal(reassemble(t.apdus, 1 + 4 * HARDENED.length).toString("hex"), unsignedChainId1);
  });

  test("transfers a long tx completely, in order, with P1=0x80 on follow-up chunks", async () => {
    const t = new MockTransport(() => reply(signaturePayload()));
    await new Commands(t).signEthTransaction(PATH, txs.longLegacy);

    assert.ok(t.apdus.length > 1, "a tx larger than one APDU must be chunked");
    assert.equal(parseApdu(t.apdus[0]).p1, 0x00);
    t.apdus.slice(1).forEach(a => assert.equal(parseApdu(a).p1, 0x80));
    assert.equal(reassemble(t.apdus, 1 + 4 * HARDENED.length).toString("hex"), txs.longLegacy);
  });

  test("never emits a chunk that cannot be encoded (Lc fits in one byte)", async () => {
    for (const [name, raw] of Object.entries(txs.rawTransactions)) {
      const t = new MockTransport(() => reply(signaturePayload()));
      await new Commands(t).signEthTransaction(PATH, raw);
      t.apdus.forEach((a, i) =>
        assert.ok(parseApdu(a).lc <= 255, `${name}: chunk ${i} has Lc=${parseApdu(a).lc}`),
      );
    }
  });

  test("returns r and s as 32-byte hex values from the final reply", async () => {
    const t = new MockTransport(() => reply(signaturePayload({ r: "ab".repeat(32), s: "cd".repeat(32) })));
    const res = await new Commands(t).signEthTransaction(PATH, unsignedChainId1);

    assert.equal(res.r, "ab".repeat(32));
    assert.equal(res.s, "cd".repeat(32));
  });

  test("returns v as a two-digit hex string", async () => {
    for (const [vByte, expected] of [[0x00, "00"], [0x01, "01"], [0x1b, "1b"], [0xff, "ff"]]) {
      const t = new MockTransport(() => reply(signaturePayload({ v: vByte })));
      const res = await new Commands(t).signEthTransaction(PATH, unsignedChainId1);
      assert.match(res.v, /^[0-9a-f]{2,}$/, `v must be hex, got ${JSON.stringify(res.v)}`);
      assert.equal(res.v, expected);
    }
  });

  test("rebuilds v for a chain id too large for one byte (legacy tx, chain id 0x165c)", async () => {
    // v = 2*chainId + 35 + parity; the device reports only the parity when v would not fit in one byte.
    const parity0 = new MockTransport(() => reply(signaturePayload({ v: 219 })));
    assert.equal((await new Commands(parity0).signEthTransaction(PATH, txs.legacyBigChainId)).v, (2 * 5724 + 35).toString(16));

    const parity1 = new MockTransport(() => reply(signaturePayload({ v: 220 })));
    assert.equal((await new Commands(parity1).signEthTransaction(PATH, txs.legacyBigChainId)).v, (2 * 5724 + 36).toString(16));
  });

  test("signs EIP-2930 and EIP-1559 envelopes byte-for-byte", async () => {
    for (const raw of [txs.eip1559, txs.eip2930AccessList]) {
      const t = new MockTransport(() => reply(signaturePayload()));
      await new Commands(t).signEthTransaction(PATH, raw);
      assert.equal(reassemble(t.apdus, 1 + 4 * HARDENED.length).toString("hex"), raw);
      assert.equal(t.apdus[0][5], HARDENED.length);
    }
  });

  test("accepts a 0x-prefixed raw transaction", async () => {
    const t = new MockTransport(() => reply(signaturePayload()));
    await new Commands(t).signEthTransaction(PATH, `0x${unsignedChainId1}`);

    assert.equal(reassemble(t.apdus, 1 + 4 * HARDENED.length).toString("hex"), unsignedChainId1);
  });

  test("rejects a transaction that is not valid RLP with a clear error", async () => {
    const t = new MockTransport(() => reply(signaturePayload()));
    await assert.rejects(
      () => new Commands(t).signEthTransaction(PATH, "zz"),
      e => e.name === "InvalidTxData" || e instanceof TransportError,
      "invalid hex must raise a library error type",
    );
  });

  test("rejects an empty transaction instead of crashing", async () => {
    const t = new MockTransport(() => reply(signaturePayload()));
    await assert.rejects(
      () => new Commands(t).signEthTransaction(PATH, ""),
      e => e.name === "InvalidTxData" || e instanceof TransportError,
    );
  });

  test("maps status 0x6a80 to InvalidTxData", async () => {
    const t = new MockTransport(() => statusError(SW.INCORRECT_DATA));
    await assert.rejects(() => new Commands(t).signEthTransaction(PATH, unsignedChainId1), e => e.name === "InvalidTxData");
  });

  test("leaves other statuses untouched", async () => {
    const t = new MockTransport(() => statusError(SW.USER_REFUSED));
    await assert.rejects(
      () => new Commands(t).signEthTransaction(PATH, unsignedChainId1),
      e => e.name === "TransportStatusError" && e.statusCode === SW.USER_REFUSED,
    );
  });

  test("rejects a reply shorter than one parity byte plus r and s", async () => {
    const t = new MockTransport(() => reply(Buffer.alloc(20)));
    await assert.rejects(
      () => new Commands(t).signEthTransaction(PATH, unsignedChainId1),
      e => e instanceof TransportError,
      "a truncated signature must not be returned as if it were valid",
    );
  });
});

describe("signEthPersonalMessage", () => {
  test("sends INS 0x08 with [path][message length][message]", async () => {
    const t = new MockTransport(() => reply(signaturePayload()));
    await new Commands(t).signEthPersonalMessage(PATH, "Hello world!");

    const apdu = parseApdu(t.apdus[0]);
    assert.equal(apdu.cla, 0xe0);
    assert.equal(apdu.ins, 0x08);
    assert.equal(apdu.p1, 0x00);
    assert.equal(apdu.p2, 0x00);
    assert.deepEqual(readPath(apdu.data).path, HARDENED);
    assert.equal(apdu.data.readUInt32BE(1 + 4 * HARDENED.length), 12);
    assert.equal(apdu.data.subarray(1 + 4 * HARDENED.length + 4).toString("utf-8"), "Hello world!");
  });

  test("declares the full message length while sending the first chunk only", async () => {
    const message = "z".repeat(1000);
    const t = new MockTransport(() => reply(signaturePayload()));
    await new Commands(t).signEthPersonalMessage(PATH, message);

    assert.equal(parseApdu(t.apdus[0]).data.readUInt32BE(1 + 4 * HARDENED.length), 1000);
  });

  test("chunks a long message, keeps P1=0x80 on follow-ups and never exceeds Lc 255", async () => {
    const message = "y".repeat(1000);
    const t = new MockTransport(() => reply(signaturePayload()));
    await new Commands(t).signEthPersonalMessage(PATH, message);

    assert.ok(t.apdus.length > 1);
    t.apdus.forEach(a => assert.ok(parseApdu(a).lc <= 255, `Lc ${parseApdu(a).lc} too big`));
    t.apdus.slice(1).forEach(a => assert.equal(parseApdu(a).p1, 0x80));
    assert.equal(reassemble(t.apdus, 1 + 4 * HARDENED.length + 4).toString("utf-8"), message);
  });

  test("signs an empty message", async () => {
    const t = new MockTransport(() => reply(signaturePayload()));
    const res = await new Commands(t).signEthPersonalMessage(PATH, "");

    assert.ok(res.r && res.s, "an empty message is signable and must return a signature");
    assert.equal(parseApdu(t.apdus[0]).data.readUInt32BE(1 + 4 * HARDENED.length), 0);
  });

  test("returns v as a number and r/s as 32-byte hex", async () => {
    const t = new MockTransport(() => reply(signaturePayload({ v: 28 })));
    const res = await new Commands(t).signEthPersonalMessage(PATH, "hi");

    assert.equal(res.v, 28);
    assert.equal(res.r.length, 64);
    assert.equal(res.s.length, 64);
  });

  test("honours the encoding parameter", async () => {
    const t = new MockTransport(() => reply(signaturePayload()));
    await new Commands(t).signEthPersonalMessage(PATH, "deadbeef", "hex");

    assert.equal(parseApdu(t.apdus[0]).data.readUInt32BE(1 + 4 * HARDENED.length), 4);
    assert.equal(parseApdu(t.apdus[0]).data.subarray(1 + 4 * HARDENED.length + 4).toString("hex"), "deadbeef");
  });

  test("a multibyte message is measured in bytes, not characters", async () => {
    const message = "héllo";
    const t = new MockTransport(() => reply(signaturePayload()));
    await new Commands(t).signEthPersonalMessage(PATH, message);

    assert.equal(parseApdu(t.apdus[0]).data.readUInt32BE(1 + 4 * HARDENED.length), 6);
  });

  test("propagates a device refusal", async () => {
    const t = new MockTransport(() => statusError(SW.USER_REFUSED));
    await assert.rejects(() => new Commands(t).signEthPersonalMessage(PATH, "hi"), e => e.statusCode === SW.USER_REFUSED);
  });
});

describe("signEIP712Message", () => {
  const doc = { domain: { chainId: 69, name: "Da Domain" }, primaryType: "Test", message: { contents: "Hello, Bob!" } };

  test("sends the JSON document to INS 0x0C with P2=0x01", async () => {
    const t = new MockTransport(() => reply(signaturePayload()));
    await new Commands(t).signEIP712Message(PATH, doc);

    const apdu = parseApdu(t.apdus[0]);
    assert.equal(apdu.ins, 0x0c);
    assert.equal(apdu.p2, 0x01);
    assert.deepEqual(JSON.parse(apdu.data.subarray(1 + 4 * HARDENED.length + 4).toString("utf-8")), doc);
  });

  test("transfers a large document completely and declares its byte length", async () => {
    const big = { contents: "ü".repeat(500) };
    const t = new MockTransport(() => reply(signaturePayload()));
    await new Commands(t).signEIP712Message(PATH, big);

    const json = JSON.stringify(big);
    assert.ok(t.apdus.length > 1);
    assert.equal(parseApdu(t.apdus[0]).data.readUInt32BE(1 + 4 * HARDENED.length), Buffer.byteLength(json, "utf-8"));
    assert.equal(reassemble(t.apdus, 1 + 4 * HARDENED.length + 4).toString("utf-8"), json);
  });
});

describe("signPSBT", () => {
  test("sends INS 0x0E with the total length in front of the first chunk", async () => {
    const psbt = psbtBlob(50);
    const t = new MockTransport(() => reply("cafebabe"));
    const out = await new Commands(t).signPSBT(psbt);

    const apdu = parseApdu(t.apdus[0]);
    assert.equal(apdu.cla, 0xe0);
    assert.equal(apdu.ins, 0x0e);
    assert.equal(apdu.p1, 0x00);
    assert.equal(apdu.p2, 0x00);
    assert.equal(apdu.data.readUInt32BE(0), psbt.length);
    assert.equal(apdu.data.subarray(4).toString("hex"), psbt.toString("hex"));
    assert.equal(out.toString("hex"), "cafebabe", "the status word must be stripped from the returned PSBT");
  });

  test("chunks a large PSBT, reassembles byte-for-byte and keeps Lc within one byte", async () => {
    const psbt = psbtBlob(600);
    const t = new MockTransport(() => reply("00"));
    await new Commands(t).signPSBT(psbt);

    assert.ok(t.apdus.length > 2);
    t.apdus.forEach(a => assert.ok(parseApdu(a).lc <= 255, `Lc ${parseApdu(a).lc} too big`));
    assert.equal(parseApdu(t.apdus[0]).p1, 0x00);
    t.apdus.slice(1).forEach(a => assert.equal(parseApdu(a).p1, 0x80));
    assert.equal(reassemble(t.apdus, 4).length, psbt.length);
    assert.equal(reassemble(t.apdus, 4).toString("hex"), psbt.toString("hex"));
  });

  test("accepts ArrayBuffer, Uint8Array and Buffer inputs", async () => {
    const psbt = psbtBlob(32);
    const variants = {
      Buffer: psbt,
      Uint8Array: new Uint8Array(psbt),
      ArrayBuffer: psbt.buffer.slice(psbt.byteOffset, psbt.byteOffset + psbt.byteLength),
    };

    for (const [kind, value] of Object.entries(variants)) {
      const t = new MockTransport(() => reply("00"));
      await new Commands(t).signPSBT(value);
      assert.equal(parseApdu(t.apdus[0]).data.readUInt32BE(0), psbt.length, `${kind}: declared length`);
      assert.equal(parseApdu(t.apdus[0]).data.subarray(4).toString("hex"), psbt.toString("hex"), `${kind}: payload`);
    }
  });

  test("rejects an empty PSBT with a clear error", async () => {
    const t = new MockTransport(() => reply("00"));
    await assert.rejects(
      () => new Commands(t).signPSBT(new ArrayBuffer(0)),
      e => e instanceof TransportError || e.name === "InvalidTxData",
    );
  });

  test("rejects a non-binary input instead of encoding it as text", async () => {
    const t = new MockTransport(() => reply("00"));
    await assert.rejects(
      // a hex string is a common caller mistake; utf-8 encoding it would sign garbage
      () => new Commands(t).signPSBT(psbtBlob(16).toString("hex")),
      e => e instanceof TransportError || e instanceof TypeError,
    );
  });

  test("propagates a device error", async () => {
    const t = new MockTransport(() => statusError(SW.INCORRECT_DATA));
    await assert.rejects(() => new Commands(t).signPSBT(psbtBlob(16)), e => e.statusCode === SW.INCORRECT_DATA);
  });
});

describe("loadFirmware / loadDatabase", () => {
  for (const [name, run, ins] of [
    ["loadFirmware", (c, b) => c.loadFirmware(b), 0xf2],
    ["loadDatabase", (c, b) => c.loadDatabase(b), 0xf4],
  ]) {
    test(`${name} sends INS 0x${ins.toString(16)} with the total size up front`, async () => {
      const data = blob(100);
      const t = new MockTransport(() => reply());
      await run(new Commands(t), data);

      const apdu = parseApdu(t.apdus[0]);
      assert.equal(apdu.cla, 0xe0);
      assert.equal(apdu.ins, ins);
      assert.equal(apdu.p1, 0x00);
      assert.equal(apdu.p2, 0x00);
      assert.equal(apdu.data.readUInt32BE(0), 100);
      assert.equal(apdu.data.subarray(4).toString("hex"), data.toString("hex"));
    });

    test(`${name} transfers every byte in 240-byte chunks with P1=0x80 after the first`, async () => {
      const data = blob(1000);
      const t = new MockTransport(() => reply());
      await run(new Commands(t), data);

      assert.deepEqual(t.apdus.map(a => parseApdu(a).data.length - (a === t.apdus[0] ? 4 : 0)), [240, 240, 240, 240, 40]);
      t.apdus.slice(1).forEach(a => assert.equal(parseApdu(a).p1, 0x80));
      assert.equal(reassemble(t.apdus, 4).toString("hex"), data.toString("hex"));
    });

    test(`${name} emits chunk-loaded once per acknowledged chunk, totalling the input size`, async () => {
      const data = blob(500);
      const t = new MockTransport(() => reply(), { delayMs: 1 });
      const sizes = [];
      t.on("chunk-loaded", size => sizes.push(size));

      await run(new Commands(t), data);

      assert.deepEqual(sizes, [240, 240, 20]);
      assert.equal(sizes.reduce((a, b) => a + b, 0), 500);
    });

    test(`${name} stops transferring and propagates an error raised mid-way`, async () => {
      const t = new ScriptedTransport([reply(), statusError(SW.INCORRECT_DATA)]);
      await assert.rejects(() => run(new Commands(t), blob(600)), e => e.statusCode === SW.INCORRECT_DATA);
      assert.ok(t.exchangeCount <= 3, "transfer must stop after the failure");
    });

    test(`${name} does not report progress for a chunk that failed`, async () => {
      const t = new ScriptedTransport([reply(), statusError(SW.MEMORY_PROBLEM)]);
      const sizes = [];
      t.on("chunk-loaded", size => sizes.push(size));

      await assert.rejects(() => run(new Commands(t), blob(500)));
      assert.ok(sizes.reduce((a, b) => a + b, 0) <= 240, `progress reported ${sizes.reduce((a, b) => a + b, 0)} bytes for a failed transfer`);
    });

    test(`${name} rejects an empty payload`, async () => {
      const t = new MockTransport(() => reply());
      await assert.rejects(
        () => run(new Commands(t), new ArrayBuffer(0)),
        e => e instanceof TransportError,
      );
    });
  }
});

describe("getAppConfiguration", () => {
  test("sends INS 0x06 with an empty data field", async () => {
    const t = new MockTransport(() => reply(appConfigPayload()));
    await new Commands(t).getAppConfiguration();

    const apdu = parseApdu(t.apdus[0]);
    assert.deepEqual([apdu.cla, apdu.ins, apdu.p1, apdu.p2, apdu.lc], [0xe0, 0x06, 0x00, 0x00, 0]);
  });

  test("reads firmware, database version, serial and device key from a 56-byte payload", async () => {
    const t = new MockTransport(() => reply(appConfigPayload({ fw: [3, 0, 4], db: 0x00010203 })));
    const res = await new Commands(t).getAppConfiguration();

    assert.equal(res.fwVersion, "3.0.4");
    assert.equal(res.dbVersion, 0x00010203);
    assert.equal(res.serialNumber, "5b4f0c3d9e0f6f4a2b1c8d7e6f5a4b3c");
    assert.equal(res.publicKey, "04" + "bb".repeat(32));
  });

  test("database version is a non-negative integer across its whole range", async () => {
    for (const db of [0x00000001, 0x7ffffffe, 0x7fffffff, 0x80000001, 0xfffffffe, 0xffffffff]) {
      const t = new MockTransport(() => reply(appConfigPayload({ db })));
      const res = await new Commands(t).getAppConfiguration();

      assert.ok(Number.isInteger(res.dbVersion), `dbVersion ${res.dbVersion} for 0x${db.toString(16)} is not an integer`);
      assert.ok(res.dbVersion >= 0, `dbVersion ${res.dbVersion} for 0x${db.toString(16)} is negative`);
      assert.equal(res.dbVersion, db, `dbVersion for 0x${db.toString(16)}`);
    }
  });

  test("reports fwVariant and fwBeta from the extended 58-byte payload", async () => {
    const payload = appConfigPayload({ extended: true, fwVariant: 0x07, fwBeta: 0x01 });
    assert.equal(payload.length, 58);
    const t = new MockTransport(() => reply(payload));

    const res = await new Commands(t).getAppConfiguration();
    assert.equal(res.fwVariant, 0x07);
    assert.equal(res.fwBeta, 0x01);
  });

  test("reports fwVariant=0 and fwBeta=0 as present, not absent", async () => {
    const t = new MockTransport(() => reply(appConfigPayload({ extended: true, fwVariant: 0, fwBeta: 0 })));
    const res = await new Commands(t).getAppConfiguration();

    assert.equal(res.fwVariant, 0);
    assert.equal(res.fwBeta, 0);
  });

  test("omits fwVariant/fwBeta for the 56-byte payload of older firmware", async () => {
    const t = new MockTransport(() => reply(appConfigPayload()));
    const res = await new Commands(t).getAppConfiguration();

    assert.equal(res.fwVariant, undefined);
    assert.equal(res.fwBeta, undefined);
  });

  test("rejects a payload too short to contain the documented fields", async () => {
    for (const bytes of [0, 6, 23, 55]) {
      const t = new MockTransport(() => reply(Buffer.alloc(bytes, 0xaa)));
      await assert.rejects(
        () => new Commands(t).getAppConfiguration(),
        e => e instanceof TransportError,
        `${bytes}-byte payload must be rejected`,
      );
    }
  });

  test("propagates a device error", async () => {
    const t = new MockTransport(() => statusError(SW.USER_REFUSED));
    await assert.rejects(() => new Commands(t).getAppConfiguration(), e => e.statusCode === SW.USER_REFUSED);
  });
});
