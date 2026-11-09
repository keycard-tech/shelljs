// utils: BIP-32 path parsing, hex helpers and raw-transaction decoding - what you parse is what gets sent.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { encode } = require("@ethersproject/rlp");

const { splitPath, hexBuffer, decodeTxInfo, intAsHexBytes, tokenSelectors, nftSelectors } = require("../lib/utils.js");
const txs = require("./fixtures/transactions.js");

describe("splitPath", () => {
  test("parses a standard Ethereum account path", () => {
    assert.deepEqual(splitPath("44'/60'/0'/0/0"), [0x80000000 + 44, 0x80000000 + 60, 0x80000000, 0, 0]);
  });

  test("hardens only components ending with an apostrophe", () => {
    assert.deepEqual(splitPath("0/0'/1/1'"), [0, 0x80000000, 1, 0x80000001]);
  });

  test("keeps one element per component", () => {
    assert.equal(splitPath("0/1/2/3/4/5/6/7/8/9").length, 10);
  });

  test("handles the largest hardened and non-hardened indices", () => {
    assert.deepEqual(splitPath("2147483647'"), [0xffffffff]);
    assert.deepEqual(splitPath("2147483647"), [2147483647]);
  });

  test("rejects an empty path", () => {
    assert.throws(() => splitPath(""), /path/i);
  });

  test("rejects components that are not numbers", () => {
    for (const path of ["44'/60'/x/0", "abc", "1/2/3;rm", "44'--60'"]) {
      assert.throws(() => splitPath(path), /path|component|invalid/i, `splitPath(${JSON.stringify(path)}) must not silently drop components`);
    }
  });

  test("rejects trailing junk on a numeric component instead of truncating it", () => {
    assert.throws(() => splitPath("1x"), /path|component|invalid/i, "'1x' must not be read as 1");
    assert.throws(() => splitPath("44'junk"), /path|component|invalid/i);
  });

  test("rejects negative and out-of-range components", () => {
    assert.throws(() => splitPath("-1"), /range|invalid|path/i);
    assert.throws(() => splitPath("4294967296"), /range|invalid|path/i);
    assert.throws(() => splitPath("2147483648'"), /range|invalid|path/i, "hardened index must stay inside 32 bits");
  });

  test("tolerates the leading m/ used by BIP-32 textual paths", () => {
    assert.deepEqual(splitPath("m/44'/60'/0'"), [0x80000000 + 44, 0x80000000 + 60, 0x80000000]);
  });
});

describe("hexBuffer", () => {
  test("decodes hex with and without the 0x prefix", () => {
    assert.equal(hexBuffer("aabbcc").toString("hex"), "aabbcc");
    assert.equal(hexBuffer("0xaabbcc").toString("hex"), "aabbcc");
  });

  test("decodes an empty string to an empty buffer", () => {
    assert.equal(hexBuffer("").length, 0);
  });

  test("rejects characters that are not hexadecimal", () => {
    assert.throws(() => hexBuffer("zz"), /hex/i);
    assert.throws(() => hexBuffer("ag"), /hex/i);
    assert.throws(() => hexBuffer("a b"), /hex/i);
  });

  test("rejects a hex string of odd length", () => {
    assert.throws(() => hexBuffer("abc"), /hex|length/i);
  });
});

describe("intAsHexBytes", () => {
  test("pads to the requested number of bytes", () => {
    assert.equal(intAsHexBytes(0, 4), "00000000");
    assert.equal(intAsHexBytes(1, 4), "00000001");
    assert.equal(intAsHexBytes(255, 2), "00ff");
    assert.equal(intAsHexBytes(0x1234, 4), "00001234");
  });

  test("produces exactly 2 characters per byte", () => {
    for (const bytes of [1, 2, 4, 8]) {
      assert.equal(intAsHexBytes(7, bytes).length, bytes * 2);
    }
  });

  test("rejects a value that does not fit the requested width", () => {
    assert.throws(() => intAsHexBytes(256, 1), /range|fit|overflow/i);
    assert.throws(() => intAsHexBytes(-1, 2), /range|fit|overflow/i);
  });
});

describe("decodeTxInfo", () => {
  const info = raw => decodeTxInfo(Buffer.from(raw, "hex"));

  test("legacy transactions have no type byte", () => {
    assert.equal(info(txs.legacyChainId1).txType, null);
  });

  test("recognises EIP-2930 (0x01) and EIP-1559 (0x02) envelopes", () => {
    assert.equal(info(txs.eip2930AccessList).txType, 1);
    assert.equal(info(txs.eip1559).txType, 2);
  });

  test("rejects an unknown transaction type", () => {
    const raw = "03" + txs.legacyChainId1.slice(2);
    assert.throws(() => info(raw), Error, "a 0x03 envelope is not a known type and must not be decoded as legacy");
  });

  test("extracts chain id, recipient and payload from a legacy tx", () => {
    const { decodedTx } = info(txs.legacyChainId1);
    assert.equal(decodedTx.to, txs.TO);
    assert.equal(decodedTx.data, "0xdeadbeef");
  });

  test("extracts chain id, recipient and payload from an EIP-1559 tx", () => {
    const { decodedTx } = info(txs.eip1559);
    assert.equal(decodedTx.chainId.toString("hex"), "01");
    assert.equal(decodedTx.to, txs.TO);
    assert.equal(decodedTx.data, "0xdeadbeef");
  });

  test("extracts chain id, recipient and payload from an EIP-2930 tx with an access list", () => {
    const { decodedTx } = info(txs.eip2930AccessList);
    assert.equal(decodedTx.chainId.toString("hex"), "01");
    assert.equal(decodedTx.to, txs.TO);
  });

  test("defaults the chain id to 1 for a transaction that carries none", () => {
    const unsigned = encode(["0x00", "0x04e3b29200", "0x5208", txs.TO, "0x01", "0x"]).replace(/^0x/, "");
    const { chainId, decodedTx } = info(unsigned);

    assert.equal(decodedTx.chainId.toString("hex"), "01", 'documented as "default to 1 for non EIP 155 txs"');
    assert.equal(chainId.toString(), "1");
  });

  test("reads a chain id wider than 4 bytes without losing precision", () => {
    const wideV = "0xffffffffffffffff";
    const raw = encode(["0x00", "0x3b9aca00", "0x5208", txs.TO, "0x00", "0x", wideV, "0x", "0x"]).replace(/^0x/, "");
    const { chainId } = info(raw);

    assert.equal(chainId.toString(), "18446744073709551615");
  });

  test("chainIdTruncated stays inside 32 bits", () => {
    for (const raw of [txs.legacyChainId1, txs.legacyBigChainId, txs.eip1559, txs.eip2930AccessList]) {
      const { chainIdTruncated } = info(raw);
      assert.ok(Number.isInteger(chainIdTruncated) && chainIdTruncated >= 0 && chainIdTruncated <= 0xffffffff, `chainIdTruncated ${chainIdTruncated}`);
    }
  });

  test("vrsOffset points at the first byte of the v field of a legacy tx", () => {
    const cases = [
      [txs.legacyChainId1, "0x25"],
      [txs.legacyPre155, "0x1b"],
      [txs.legacyBigChainId, "0x165c"],
      [txs.longLegacy, "0x25"],
    ];

    for (const [rawHex, v] of cases) {
      const raw = Buffer.from(rawHex, "hex");
      const { vrsOffset } = info(rawHex);
      const vEncoding = Buffer.from(encode(v).slice(2), "hex");

      assert.ok(vrsOffset > 0 && vrsOffset < raw.length, `vrsOffset ${vrsOffset} out of range`);
      assert.equal(
        raw.subarray(vrsOffset, vrsOffset + vEncoding.length).toString("hex"),
        vEncoding.toString("hex"),
        `a chunk split at vrsOffset ${vrsOffset} must land exactly on the v field (0x${v})`,
      );
    }
  });

  test("vrsOffset is 0 for typed transactions (no EIP-155 marker to protect)", () => {
    assert.equal(info(txs.eip1559).vrsOffset, 0);
    assert.equal(info(txs.eip2930AccessList).vrsOffset, 0);
  });

  test("malformed RLP raises rather than returning a partial result", () => {
    for (const raw of ["", "f8", "ff", "b8ff00", "c0c0c0"]) {
      assert.throws(() => info(raw), Error, `decodeTxInfo(${JSON.stringify(raw)}) should not silently succeed`);
    }
  });
});

describe("selector tables", () => {
  test("token selectors cover ERC-20 transfer and approve", () => {
    assert.ok(tokenSelectors.includes("0xa9059cbb"));
    assert.ok(tokenSelectors.includes("0x095ea7b3"));
  });

  test("nft selectors cover the ERC-721 and ERC-1155 methods", () => {
    for (const sel of ["0x23b872dd", "0x42842e0e", "0xb88d4fde", "0xa22cb465", "0xf242432a", "0x2eb2c2d6"]) {
      assert.ok(nftSelectors.includes(sel), `missing ${sel}`);
    }
  });

  test("selector lists contain no duplicates", () => {
    assert.equal(new Set(nftSelectors).size, nftSelectors.length, JSON.stringify(nftSelectors));
    assert.equal(new Set(tokenSelectors).size, tokenSelectors.length);
  });

  test("every selector is 4 bytes of hex", () => {
    for (const sel of [...tokenSelectors, ...nftSelectors]) {
      assert.match(sel, /^0x[0-9a-f]{8}$/, sel);
    }
  });
});
