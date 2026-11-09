/**
 * Well-formed device replies, built to the exact wire layout each command parses.
 * Keeping them in one place means a change in the parsing code shows up as a
 * failing test rather than a silently "successful" garbage value.
 */
const { reply } = require("./mock-device");

/** [fpLen][fp][pkLen][pubkey][ccLen][chaincode] */
const publicKeyPayload = ({ fingerprint = "01020304", publicKey = "03" + "aa".repeat(32), chainCode = null } = {}) => {
  const fp = Buffer.from(fingerprint, "hex");
  const pk = Buffer.from(publicKey, "hex");
  const cc = chainCode === null ? null : Buffer.from(chainCode, "hex");
  return Buffer.concat([
    Uint8Array.from([fp.length]),
    fp,
    Uint8Array.from([pk.length]),
    pk,
    ...(cc ? [Uint8Array.from([cc.length]), cc] : []),
  ]);
};

/** [v][r(32)][s(32)] as returned by signEthTransaction / signEthPersonalMessage / signEIP712Message */
const signaturePayload = ({ v = 0x01, r = "11".repeat(32), s = "22".repeat(32) } = {}) =>
  Buffer.concat([Uint8Array.from([v]), Buffer.from(r, "hex"), Buffer.from(s, "hex")]);

/**
 * getAppConfiguration payload:
 * [fwMajor][fwMinor][fwPatch][dbVersion(4)][serial(16)][devicePubKey(33)](+[fwVariant][fwBeta])
 * @param {boolean} extended add the fwVariant/fwBeta trailer (firmware >= 1.2 style replies)
 */
const appConfigPayload = ({
  fw = [3, 0, 4],
  db = 0x00010203,
  serial = "5b4f0c3d9e0f6f4a2b1c8d7e6f5a4b3c",
  publicKey = "04" + "bb".repeat(32),
  fwVariant = undefined,
  fwBeta = undefined,
  extended = false,
} = {}) => {
  const dbBuf = Buffer.alloc(4);
  dbBuf.writeUInt32BE(db >>> 0, 0);
  const parts = [
    Uint8Array.from(fw),
    dbBuf,
    Buffer.from(serial, "hex"),
    Buffer.from(publicKey, "hex"),
  ];
  if (extended || fwVariant !== undefined) {
    parts.push(Uint8Array.from([fwVariant === undefined ? 0x07 : fwVariant, fwBeta === undefined ? 0x01 : fwBeta]));
  }
  return Buffer.concat(parts);
};

/** A PSBT-ish blob: "psbt" magic + deterministic filler. */
const psbtBlob = bytes => Buffer.concat([Buffer.from("70736274ff", "hex"), Buffer.alloc(bytes, 0x5a)]);

/** Firmware / database blob of a given size. */
const blob = bytes => Buffer.from(Array.from({ length: bytes }, (_, i) => (i * 7 + 3) % 256));

module.exports = { publicKeyPayload, signaturePayload, appConfigPayload, psbtBlob, blob, reply };
