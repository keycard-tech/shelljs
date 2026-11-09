/**
 * Raw transaction fixtures, RLP-encoded with the same library the transport uses
 * (@ethersproject/rlp) so they are valid by construction.
 *
 * Field layouts (yellowpaper / EIP-2718):
 *   legacy   : [nonce, gasPrice, gasLimit, to, value, data, v, r, s]
 *   EIP-2930 : 0x01 || [chainId, nonce, gasPrice, gasLimit, to, value, data, accessList, yParity, r, s]
 *   EIP-1559 : 0x02 || [chainId, nonce, maxPrioFee, maxFee, gasLimit, to, value, data, accessList, yParity, r, s]
 *
 * NOTE: every string here is bare hex, *without* the "0x" prefix, because
 * Buffer.from("0x...", "hex") silently decodes to an empty buffer.
 * See bugs.test.js -> "0x-prefixed raw tx is rejected with an opaque rlp error".
 */
const { encode } = require("@ethersproject/rlp");

const R = "0x" + "11".repeat(32);
const S = "0x" + "22".repeat(32);
const TO = "0x28ee52a8f3d6e5d15f8b131996950d7f296c7952";

const strip = hex => hex.replace(/^0x/, "");

/** EIP-155 legacy tx on chainId 1 -> v = 2 * 1 + 35 = 37 (0x25) */
const legacyChainId1 = strip(
  encode(["0x00", "0x04e3b29200", "0x5208", TO, "0x01", "0xdeadbeef", "0x25", R, S]),
);

/** Pre-EIP-155 legacy tx -> v = 27 (0x1b), no chain id */
const legacyPre155 = strip(
  encode(["0x00", "0x04e3b29200", "0x5208", TO, "0x01", "0xdeadbeef", "0x1b", R, S]),
);

/** Legacy tx with a chain id that does not fit in one byte (0x0aee = 2798) */
const legacyBigChainId = strip(
  encode(["0x00", "0x3b9aca00", "0x5208", TO, "0x00", "0x", "0x165c", R, S]),
);

/** EIP-1559 tx on chainId 1 */
const eip1559 =
  "02" +
  strip(
    encode([
      "0x01", // chainId
      "0x02", // nonce
      "0x02", // maxPriorityFeePerGas
      "0x012a", // maxFeePerGas
      "0x5208", // gasLimit
      TO, // to
      "0x00", // value
      "0xdeadbeef", // data
      [], // accessList
      "0x01", // yParity
      R,
      S,
    ]),
  );

/** EIP-2930 tx on chainId 1 with a populated access list */
const eip2930AccessList =
  "01" +
  strip(
    encode([
      "0x01", // chainId
      "0x02", // nonce
      "0x04e3b29200", // gasPrice
      "0x5208", // gasLimit
      TO, // to
      "0x00", // value
      "0x", // data
      [[TO, ["0xaaaa", "0xbbbb"]]], // accessList
      "0x01", // yParity
      R,
      S,
    ]),
  );

/** Long legacy tx (> 150 bytes, forces signEthTransaction to chunk) */
const longLegacy = strip(
  encode([
    "0x00",
    "0x04e3b29200",
    "0x01c9c380",
    TO,
    "0x00",
    "0x" + "de".repeat(200),
    "0x25",
    R,
    S,
  ]),
);

const rawTransactions = {
  legacyChainId1,
  legacyPre155,
  legacyBigChainId,
  eip1559,
  eip2930AccessList,
  longLegacy,
};

module.exports = {
  ...rawTransactions,
  rawTransactions,
  TO,
  R,
  S,
};
