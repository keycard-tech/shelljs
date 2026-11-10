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
import { encode, decode } from "@ethersproject/rlp";
import { BigNumber } from "bignumber.js";

export const splitPath = (path: string): number[] => {
  const components = path.split("/");
  if (components[0] === "m") {
    components.shift();
  }

  const result = components.map(element => {
    const hardened = element.endsWith("'");
    const digits = hardened ? element.slice(0, -1) : element;
    const value = Number(digits) + (hardened ? 0x80000000 : 0);

    if (!/^[0-9]+$/.test(digits) || value > 0xffffffff) {
      throw new Error(`Invalid BIP-32 path component "${element}" in path "${path}"`);
    }

    return value;
  });

  if (!result.length) {
    throw new Error("Empty derivation path");
  }

  return result;
}

export const hexBuffer = (str: string): Buffer => {
  const hex = str.startsWith("0x") ? str.slice(2) : str;

  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`Invalid hex string "${str}"`);
  }

  return Buffer.from(hex, "hex");
}

export const decodeTxInfo = (rawTx: Buffer) : any => {
  const VALID_TYPES = [1, 2];
  const firstByte = rawTx[0] ?? 0;
  const txType = VALID_TYPES.includes(firstByte) ? firstByte : null;
  const rlpData = txType === null ? rawTx : rawTx.subarray(1);
  const rlpTx = decode(rlpData).map((hex: any) => Buffer.from(hex.slice(2), "hex"));
  let chainIdTruncated = 0;
  const rlpDecoded = decode(rlpData);

  let decodedTx;
  if (txType === 2) {
    // EIP1559
    decodedTx = {
      data: rlpDecoded[7],
      to: rlpDecoded[5],
      chainId: rlpTx[0],
    };
  } else if (txType === 1) {
    // EIP2930
    decodedTx = {
      data: rlpDecoded[6],
      to: rlpDecoded[4],
      chainId: rlpTx[0],
    };
  } else {
    // Legacy tx
    decodedTx = {
      data: rlpDecoded[5],
      to: rlpDecoded[3],
      // Default to 1 for non EIP 155 txs
      chainId: rlpTx.length > 6 ? rlpTx[6] : Buffer.from("01", "hex"),
    };
  }

  const chainIdSrc = decodedTx.chainId;
  let chainId = new BigNumber(0);
  if (chainIdSrc) {
    // Using BigNumber because chainID could be any uint256.
    chainId = new BigNumber(chainIdSrc.toString("hex"), 16);
    const chainIdTruncatedBuf = Buffer.alloc(4);
    if (chainIdSrc.length > 4) {
      chainIdSrc.copy(chainIdTruncatedBuf);
    } else {
      chainIdSrc.copy(chainIdTruncatedBuf, 4 - chainIdSrc.length);
    }
    chainIdTruncated = chainIdTruncatedBuf.readUInt32BE(0);
  }

  let vrsOffset = 0;
  if (txType === null && rlpTx.length > 6) {
    const rlpVrs = Buffer.from(encode(rlpTx.slice(-3)).slice(2), "hex");

    vrsOffset = rawTx.length - (rlpVrs.length - 1);

    const rlpVrsFirst = rlpVrs[0] ?? 0;

    if (rlpVrsFirst > 0xf7) {
      vrsOffset++;
      const sizeOfListLen = rlpVrsFirst - 0xf7;
      vrsOffset += sizeOfListLen - 1;
    }
  }

  return {
    decodedTx,
    txType,
    chainId,
    chainIdTruncated,
    vrsOffset,
  };
};

/**
 * @ignore for the README
 *
 * Helper to convert an integer as a hexadecimal string with the right amount of digits
 * to respect the number of bytes given as parameter
 *
 * @param int Integer
 * @param bytes Number of bytes it should be represented as (1 byte = 2 caraters)
 * @returns The given integer as an hexa string padded with the right number of 0
 */
export const intAsHexBytes = (int: number, bytes: number): string => {
  if (!Number.isInteger(int) || int < 0 || int >= Math.pow(2, 8 * bytes)) {
    throw new Error(`${int} does not fit in ${bytes} bytes`);
  }

  return int.toString(16).padStart(2 * bytes, "0");
};

/**
 * @ignore for the README
 *
 * List of selectors (hexadecimal representation of the used method's signature) related to
 * ERC20 (Tokens), ERC721/ERC1155 (NFT).
 * You can verify and/or get more info about them on http://4byte.directory
 */

export enum ERC20_CLEAR_SIGNED_SELECTORS {
  APPROVE = "0x095ea7b3",
  TRANSFER = "0xa9059cbb",
}

export enum ERC721_CLEAR_SIGNED_SELECTORS {
  APPROVE = "0x095ea7b3",
  SET_APPROVAL_FOR_ALL = "0xa22cb465",
  TRANSFER_FROM = "0x23b872dd",
  SAFE_TRANSFER_FROM = "0x42842e0e",
  SAFE_TRANSFER_FROM_WITH_DATA = "0xb88d4fde",
}

export enum ERC1155_CLEAR_SIGNED_SELECTORS {
  SET_APPROVAL_FOR_ALL = "0xa22cb465",
  SAFE_TRANSFER_FROM = "0xf242432a",
  SAFE_BATCH_TRANSFER_FROM = "0x2eb2c2d6",
}

export const tokenSelectors = Object.values(ERC20_CLEAR_SIGNED_SELECTORS);
export const nftSelectors = Array.from(
  new Set([
    ...Object.values(ERC721_CLEAR_SIGNED_SELECTORS),
    ...Object.values(ERC1155_CLEAR_SIGNED_SELECTORS),
  ]),
);