import Transport from "./transport";
import { splitPath } from "./utils";

/**
 * @ignore for the README
 *
 * Sign an EIP-712 formatted message
 *
 * @param {String} path derivationPath
 * @param {String} jsonMessage message to sign
 * @param {Boolean} fullImplem use the legacy implementation
 * @returns {Promise}
 */
export const signEIP712Message = async (transport: Transport, path: string, jsonMessage: string, fullImplem = false): Promise<{ v: number; s: string; r: string; }> => {
  enum APDU_FIELDS {
    CLA = 0xe0,
    INS = 0x0c,
    P1 = 0x00,
    P2_v0 = 0x00,
    P2_full = 0x01,
  }

  const paths = splitPath(path);
  const message = Buffer.from(jsonMessage, "hex");
  let offset = 0;
  let response: any;

  while (offset !== message.length) {
    const maxChunkSize = offset === 0 ? 150 - 1 - paths.length * 4 - 4 : 150;
    const chunkSize = offset + maxChunkSize > message.length ? message.length - offset : maxChunkSize;
    const buffer = Buffer.alloc(offset === 0 ? 1 + paths.length * 4 + 4 + chunkSize : chunkSize);

    if (offset === 0) {
      buffer[0] = paths.length;
      paths.forEach((element, index) => {
        buffer.writeUInt32BE(element, 1 + 4 * index);
      });
      buffer.writeUInt32BE(message.length, 1 + 4 * paths.length);
      message.copy(buffer, 1 + 4 * paths.length + 4, offset, offset + chunkSize);
    } else {
      message.copy(buffer, 0, offset, offset + chunkSize);
    }

    response = await transport.send(APDU_FIELDS.CLA, APDU_FIELDS.INS, APDU_FIELDS.P1, fullImplem ? APDU_FIELDS.P2_v0 : APDU_FIELDS.P2_full, buffer);

    offset += chunkSize;
  }

  const v = response[0];
  const r = response.subarray(1, 1 + 32).toString("hex");
  const s = response.subarray(1 + 32, 1 + 32 + 32).toString("hex");

  return { v, r, s };
};