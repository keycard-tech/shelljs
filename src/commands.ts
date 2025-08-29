/********************************************************************************
 *   Ledger Node JS API
 *   (c) 2016-2017 Ledger
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 ********************************************************************************/
import type Transport from "./transport";
import { log } from "./logs";
import { decodeTxInfo, splitPath } from "./utils";
import { InvalidTxData } from "./errors";

export * from "./utils";

const remapTransactionRelatedErrors = (e: any) => {
  if (e && e.statusCode === 0x6a80) {
    return new InvalidTxData("Invalid Transaction Data");
  }

  return e;
};

/**
 * Shell Commandset API
 *
 * @example
 import ShellJS from "shelljs";
 const cmd = new ShellJS.Commands(transport);
 *
 */

export default class Commands {
  transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /**
   * get Public key for a given BIP 32 path.
   * @param path a path in BIP 32 format
   * @option boolChaincode optionally enable or not the chaincode request
   * @return an object with a fingerprint, publicKey and (optionally) chainCode
   *
   * @example
   const resp = await cmd.getPublicKey("44'/60'/0'/0/0");
   console.log(resp.address);
   */
  async getPublicKey(path: string, boolChaincode?: boolean): Promise<{fingerprint: string; publicKey: string; chainCode?: string }> {
    const paths = splitPath(path);
    const buffer = Buffer.alloc(1 + paths.length * 4);

    buffer[0] = paths.length;

    paths.forEach((element, index) => {
      buffer.writeUInt32BE(element, 1 + 4 * index);
    });

    try {
      let response = await this.transport.send(0xe0, 0x02, 0x00, boolChaincode ? 0x01 : 0x00, buffer);
      const fingerprintLength = response[0];
      const publicKeyLength = response[1 + fingerprintLength];
      const chainLength = response[2 + fingerprintLength + publicKeyLength];

      const publicKeyPosition = 2 + fingerprintLength;
      const chainCodePosition = 3 + fingerprintLength + publicKeyLength;

      return {
        fingerprint: response.subarray(1, 1 + fingerprintLength).toString("hex"), 
        publicKey: response.subarray(publicKeyPosition, publicKeyPosition + publicKeyLength).toString("hex"),
        chainCode: boolChaincode ? response.subarray(chainCodePosition, chainCodePosition + chainLength).toString("hex") : undefined
      }
    } catch (error) {
      log("error", "Couldn't get public key", error);
      throw error;
    }
  }

  /**
   * Sign a transaction and retrieve v, r, s given the raw transaction and the BIP 32 path of the account to sign.
   *
   * @param path: the BIP32 path to sign the transaction on
   * @param rawTxHex: the raw ethereum transaction in hexadecimal to sign
   * @return an object with s, v and r
   *
   * @example
   const tx = "e8018504e3b292008252089428ee52a8f3d6e5d15f8b131996950d7f296c7952872bd72a2487400080"; // raw tx to sign
   const resp = await cmd.signEthTransaction("44'/60'/0'/0/0", tx);
   console.log(resp);
   */
  async signEthTransaction(path: string, rawTxHex: string): Promise<{s: string; v: string;  r: string;}> {
    const rawTx = Buffer.from(rawTxHex, "hex");
    const { vrsOffset, txType, chainId, chainIdTruncated } = decodeTxInfo(rawTx);
    const paths = splitPath(path);

    let response: any;
    let offset = 0;

    while (offset !== rawTx.length) {
      const first = offset === 0;
      const maxChunkSize = first ? 150 - 1 - paths.length * 4 : 150;
      let chunkSize = offset + maxChunkSize > rawTx.length ? rawTx.length - offset : maxChunkSize;

      if (vrsOffset != 0 && offset + chunkSize >= vrsOffset) {
        // Make sure that the chunk doesn't end right on the EIP 155 marker if set
        chunkSize = rawTx.length - offset;
      }

      const buffer = Buffer.alloc(first ? 1 + paths.length * 4 + chunkSize : chunkSize);

      if (first) {
        buffer[0] = paths.length;
        paths.forEach((element, index) => {
          buffer.writeUInt32BE(element, 1 + 4 * index);
        });
        rawTx.copy(buffer, 1 + 4 * paths.length, offset, offset + chunkSize);
      } else {
        rawTx.copy(buffer, 0, offset, offset + chunkSize);
      }

      response = await this.transport.send(0xe0, 0x04, first ? 0x00 : 0x80, 0x00, buffer).catch((e: any) => {
        throw remapTransactionRelatedErrors(e);
      });

      offset += chunkSize;
    }

    const response_byte: number = response[0];

    let v = "";

    if (chainId.times(2).plus(35).plus(1).isGreaterThan(255)) {
      const oneByteChainId = (chainIdTruncated * 2 + 35) % 256;
      const ecc_parity = Math.abs(response_byte - oneByteChainId);

      if (txType != null) {
        // For EIP2930 and EIP1559 tx, v is simply the parity.
        v = ecc_parity % 2 == 1 ? "00" : "01";
      } else {
        // Legacy type transaction with a big chain ID
        v = chainId.times(2).plus(35).plus(ecc_parity).toString(16);
      }
    } else {
      v = response_byte.toString(16);
    }

    // Make sure v is prefixed with a 0 if its length is odd ("1" -> "01").
    if (v.length % 2 == 1) {
      v = "0" + v;
    }

    const r = response.slice(1, 1 + 32).toString("hex");
    const s = response.slice(1 + 32, 1 + 32 + 32).toString("hex");

    return { v, r, s };
  }

  /**
  * Get firmware and database version, serial number, publicKey
  *
  * @return an object with fwVersion, dbVersion, serialNumber, publicKey
  *
  * @example
  const {fwVersion, dbVersion, serialNumber, publicKey} = await cmd.getAppConfiguration();
  console.log(fwVersion);
  console.log(dbVersion);
  console.log(serialNumber);
  console.log(publicKey);
  *
  */
  async getAppConfiguration() : Promise<{ fwVersion: string; dbVersion: number; serialNumber: string; publicKey: string }> {
    try {
      const response = await this.transport.send(0xe0, 0x06, 0x00, 0x00);
      const fwVersion = String(response[0]) + "." + String(response[1]) + "." + String(response[2]);
      const dbVersion = (response[3] << 24) | (response[4] << 16) | (response[5] << 8) | response[6];
      const serialNumber = response.subarray(7, 23).toString("hex");
      const publicKey = response.subarray(23, 56).toString("hex");

      return { fwVersion, dbVersion, serialNumber, publicKey }
    } catch (error) {
      log("error", "Couldn't get app configuration", error);
      throw error;
    }

  }

  private async sendChunks(path: string, m: string, cla: number, ins: number, p2: number, enc: string) : Promise<{ v: number; s: string; r: string; }> {
    const paths = splitPath(path);
    const message = Buffer.from(m, enc as BufferEncoding);
    let offset = 0;
    let response: any;

    while (offset !== message.length) {
      const maxChunkSize = offset === 0 ? 255 - 1 - paths.length * 4 - 4 : 255;
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

      response = await this.transport.send(cla, ins, offset === 0 ? 0x00 : 0x80, p2, buffer);

      offset += chunkSize;
    }

    const v = response[0];
    const r = response.subarray(1, 33).toString("hex");
    const s = response.subarray(33, 65).toString("hex");

    return { v, r, s };
  }

  /**
  * Sign a personal message and retrieve v, r, s given the message and the BIP 32 path of the account to sign.
  * @param path: the BIP32 path to sign the message
  * @param pMessage: personal message
  * @option enc: buffer encoding, default: "utf-8"
  * @return an object with v, s and r
  *
  * @example
  const resp = await cmd.signEthPersonalMessage("44'/60'/0'/0/0", "Hello world!");
  let v = resp['v'] - 27;
  v = v.toString(16);
  if (v.length < 2) {
    v = "0" + v;
  }
  console.log("Signature 0x" + resp['r'] + resp['s'] + v);
  */
  async signEthPersonalMessage(path: string, pMessage: string, enc="utf-8") : Promise<{ v: number; s: string; r: string; }> {
    return this.sendChunks(path, pMessage, 0xe0, 0x08, 0x00, enc);
  }

  /**
   * Sign an EIP-712 formatted message
   *
   * @param {String} path the BIP32 path to sign the message
   * @param {Object} jsonMessage EIP712 message to sign
   * @return an object with v, s and r
   *
   * @example
   const resp = await cmd.signEIP712Message("44'/60'/0'/0/0", {
     domain: {
       chainId: 69,
       name: "Da Domain",
       verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
        version: "1"
      },
      types: {
        "EIP712Domain": [
              { name: "name", type: "string" },
              { name: "version", type: "string" },
              { name: "chainId", type: "uint256" },
              { name: "verifyingContract", type: "address" }
          ],
        "Test": [
          { name: "contents", type: "string" }
        ]
      },
      primaryType: "Test",
      message: {contents: "Hello, Bob!"},
    });
   *
   */
  async signEIP712Message(path: string, jsonMessage: Object): Promise<{ v: number; s: string; r: string; }> {
    const messageStr = JSON.stringify(jsonMessage);

    enum APDU_FIELDS {
      CLA = 0xe0,
      INS = 0x0c,
      P1 = 0x00,
      P2 = 0x01
    }

    return this.sendChunks(path, messageStr, APDU_FIELDS.CLA, APDU_FIELDS.INS, APDU_FIELDS.P2, "utf-8");
  }

  /**
   * Sign a PSBT
   *
   * @param {ArrayBuffer} psbt PSBT to sign
   * @return an ArrayBuffer
   *
   */
  async signPSBT(psbt: ArrayBuffer): Promise<ArrayBuffer> {
    const message = Buffer.from(psbt);

    enum APDU_FIELDS {
      CLA = 0xe0,
      INS = 0x0e,
      P2 = 0x00
    }

    let offset = 0;
    let response: any;

    while (offset !== message.length) {
      const maxChunkSize = offset === 0 ? 255 - 4 : 255;
      const chunkSize = offset + maxChunkSize > message.length ? message.length - offset : maxChunkSize;
      const buffer = Buffer.alloc(offset === 0 ? 4 + chunkSize : chunkSize);

      if (offset === 0) {
        buffer.writeUInt32BE(message.length, 0);
        message.copy(buffer, 4, offset, offset + chunkSize);
      } else {
        message.copy(buffer, 0, offset, offset + chunkSize);
      }

      response = await this.transport.send(APDU_FIELDS.CLA, APDU_FIELDS.INS, offset === 0 ? 0x00 : 0x80, APDU_FIELDS.P2, buffer);
      offset += chunkSize;
    }

    return response.subarray(0, -2);
  }

  private async load(data: Buffer, ins: number) : Promise<number> {
    let offset = 0;
    let response: any;

    enum APDU_FIELDS {
      CLA = 0xe0,
      INS = ins,
      P2 = 0x00
    }

    while (offset !== data.length) {
      const maxChunkSize = 240;
      const chunkSize = offset + maxChunkSize > data.length ? data.length - offset : maxChunkSize;
      const buffer = Buffer.alloc(offset === 0 ? 4 + chunkSize : chunkSize);

      if (offset === 0) {
        buffer.writeUInt32BE(data.length, 0);
        data.copy(buffer, 4, offset, offset + chunkSize);
      } else {
        data.copy(buffer, 0, offset, offset + chunkSize);
      }

      response = await this.transport.send(APDU_FIELDS.CLA, APDU_FIELDS.INS, offset === 0 ? 0x00 : 0x80, APDU_FIELDS.P2, buffer);

      this.transport.emit("chunk-loaded", chunkSize);

      offset += chunkSize;
    }

    return (response[0] << 8) | response[1];
  }

  /**
  * You can load a firmware
  *
  * @param {ArrayBuffer} fw firmware
  * @return {Promise}
  *
  * @example
  const fs = require('fs'),
  let f = fs.readFileSync('./firmware.bin');
  let fw = new Uint8Array(f);
  await cmd.loadFirmware(fw);
  *
  */
  async loadFirmware(fw: ArrayBuffer) : Promise<number> {
    return await this.load(Buffer.from(fw), 0xf2);
  }

  /**
  * Load a ERC20 and Chain DB
  *
  * @param {ArrayBuffer} db database
  * @return {Promise}
  *
  * @example
  const fs = require('fs'),
  let f = fs.readFileSync('./db.bin');
  let db = new Uint8Array(f);
  await cmd.loadDatabase(db);
  *
  */

  async loadDatabase(db: ArrayBuffer) : Promise<number> {
    return await this.load(Buffer.from(db), 0xf4);
  }
}