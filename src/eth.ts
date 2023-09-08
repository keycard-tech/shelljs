/********************************************************************************
 *   KPro Node JS API
 *   (c) 2016-2017 KPro
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
/* eslint @typescript-eslint/no-duplicate-enum-values: 1 */
// FIXME drop:
import type Transport from "./transport";
// NB: these are temporary import for the deprecated fallback mechanism
import { log } from "./logs";
import { decodeTxInfo, splitPath } from "./utils";
import { EthAppPleaseEnableContractData } from "./errors";
import { signEIP712Message } from "./eip712";
import { json } from "stream/consumers";

export * from "./utils";

const remapTransactionRelatedErrors = (e: any) => {
  if (e && e.statusCode === 0x6a80) {
    return new EthAppPleaseEnableContractData( "Please enable Blind signing or Contract data in the Ethereum app Settings");
  }

  return e;
};

/**
 * Ethereum API
 *
 * @example
 * import Eth from "@KProhq/hw-app-eth";
 * const eth = new Eth(transport)
 */

export default class Eth {
  transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /**
   * get Ethereum address for a given BIP 32 path.
   * @param path a path in BIP 32 format
   * @option boolDisplay optionally enable or not the display
   * @option boolChaincode optionally enable or not the chaincode request
   * @return an object with a publicKey, address and (optionally) chainCode
   * @example
   * eth.getAddress("44'/60'/0'/0/0").then(o => o.address)
   */
  async getAddress(path: string, boolDisplay?: boolean, boolChaincode?: boolean): Promise<{ publicKey: string; address: string; chainCode?: string }> {
    const paths = splitPath(path);
    const buffer = Buffer.alloc(1 + paths.length * 4);

    buffer[0] = paths.length;

    paths.forEach((element, index) => {
      buffer.writeUInt32BE(element, 1 + 4 * index);
    });

    try {
      let response = await this.transport.send(0xe0, 0x02, boolDisplay ? 0x01 : 0x00, boolChaincode ? 0x01 : 0x00, buffer);
    const publicKeyLength = response[0];
    const addressLength = response[1 + publicKeyLength];

    return {
      publicKey: response.subarray(1, 1 + publicKeyLength).toString("hex"),
      address: "0x" + response.subarray(1 + publicKeyLength + 1, 1 + publicKeyLength + 1 + addressLength).toString("ascii"),
      chainCode: boolChaincode ? response.subarray(1 + publicKeyLength + 1 + addressLength, 1 + publicKeyLength + 1 + addressLength + 32).toString("hex") : undefined
    };
    } catch (error) {
      log("error", "Couldn't get address", error);
      throw error;
    }
  }

  /**
   * You can sign a transaction and retrieve v, r, s given the raw transaction and the BIP 32 path of the account to sign.
   *
   * @param path: the BIP32 path to sign the transaction on
   * @param rawTxHex: the raw ethereum transaction in hexadecimal to sign
   * @param resolution: resolution is an object with all "resolved" metadata necessary to allow the device to clear sign information. This includes: ERC20 token information, plugins, contracts, NFT signatures,... You must explicitly provide something to avoid having a warning. By default, you can use KPro's service or your own resolution service. See services/types.js for the contract. Setting the value to "null" will fallback everything to blind signing but will still allow the device to sign the transaction.
   * @example
   import { KProService } from "@KProhq/hw-app-eth"
   const tx = "e8018504e3b292008252089428ee52a8f3d6e5d15f8b131996950d7f296c7952872bd72a2487400080"; // raw tx to sign
   const resolution = await KProService.resolveTransaction(tx);
   const result = eth.signTransaction("44'/60'/0'/0/0", tx, resolution);
   console.log(result);
   */
  async signTransaction(path: string, rawTxHex: string): Promise<{s: string; v: string;  r: string;}> {
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
   */
  getAppConfiguration(): Promise<{
    arbitraryDataEnabled: number;
    erc20ProvisioningNecessary: number;
    starkEnabled: number;
    starkv2Supported: number;
    version: string;
  }> {
    return this.transport.send(0xe0, 0x06, 0x00, 0x00).then((response: any) => {
      return {
        arbitraryDataEnabled: response[0] & 0x01,
        erc20ProvisioningNecessary: response[0] & 0x02,
        starkEnabled: response[0] & 0x04,
        starkv2Supported: response[0] & 0x08,
        version: "" + response[1] + "." + response[2] + "." + response[3],
      };
    });
  }

  /**
  * You can sign a message according to eth_sign RPC call and retrieve v, r, s given the message and the BIP 32 path of the account to sign.
  * @example
  eth.signPersonalMessage("44'/60'/0'/0/0", Buffer.from("test").toString("hex")).then(result => {
  var v = result['v'] - 27;
  v = v.toString(16);
  if (v.length < 2) {
    v = "0" + v;
  }
  console.log("Signature 0x" + result['r'] + result['s'] + v);
  })
   */
  async signPersonalMessage(path: string, messageHex: string): Promise<{ v: number; s: string; r: string; }> {
    const paths = splitPath(path);
    const message = Buffer.from(messageHex, "hex");
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

      response = await this.transport.send(0xe0, 0x08, offset === 0 ? 0x00 : 0x80, 0x00, buffer);

      offset += chunkSize;
    }

    const v = response[0];
    const r = response.slice(1, 1 + 32).toString("hex");
    const s = response.slice(1 + 32, 1 + 32 + 32).toString("hex");

    return { v, r, s };
  }

  /**
   * Sign an EIP-721 formatted message following the specification here:
   * https://github.com/KProHQ/app-ethereum/blob/develop/doc/ethapp.asc#sign-eth-eip-712
   * ⚠️ This method is not compatible with nano S (LNS). Make sure to use a try/catch to fallback on the signEIP712HashedMessage method ⚠️
   @example
   eth.signEIP721Message("44'/60'/0'/0/0", {
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
    })
   *
   * @param {String} path derivationPath
   * @param {Object} jsonMessage message to sign
   * @param {Boolean} fullImplem use the legacy implementation
   * @returns {Promise}
   */
  async signEIP712Message( path: string, jsonMessage: Object, fullImplem = false): Promise<{ v: number; s: string; r: string; }> {
    const messageStr = JSON.stringify(jsonMessage);
    return signEIP712Message(this.transport, path, messageStr, fullImplem);
  }

  /**
   * Method returning a 4 bytes TLV challenge as an hexa string
   *
   * @returns {Promise<string>}
   */
  async getChallenge(): Promise<string> {
    enum APDU_FIELDS {
      CLA = 0xe0,
      INS = 0x20,
      P1 = 0x00,
      P2 = 0x00,
      LC = 0x00,
    }

    try {
      let response = await this.transport.send(APDU_FIELDS.CLA, APDU_FIELDS.INS, APDU_FIELDS.P1, APDU_FIELDS.P2);
      const [fourBytesChallenge, statusCode] = new RegExp("(.*)(.{4}$)").exec(response.toString("hex")) || [];

      if (statusCode !== "9000") {
        throw new Error(`An error happened while generating the challenge. Status code: ${statusCode}`);
      }

      return `0x${fourBytesChallenge}`;
    } catch (error) {
      log("error", "Couldn't request a challenge", error);
      throw error;
    }
  }
}