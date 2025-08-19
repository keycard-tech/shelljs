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

import { TransportError } from "./errors";
import { ResponseAcc } from "./types/hid-types";

const Tag = 0x05;

export const shellUSBVendorId = 0x1209;

const asUInt16BE = (value: any) : any => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value, 0);
  return b;
}

const initialAcc = {
  data: Buffer.alloc(0),
  dataLength: 0,
  sequence: 0
};

/**
 *
 */
export const hidFraming = (channel: number, packetSize: number) :
{
  makeBlocks: (apdu: Buffer) => Buffer[],
  reduceResponse: (acc: ResponseAcc, chunk: Buffer) => ResponseAcc,
  getReducedResult: (acc: ResponseAcc) => Buffer | null | undefined
} =>

{
  return {
    makeBlocks(apdu: Buffer): Buffer[] {
      let data = Buffer.concat([asUInt16BE(apdu.length), apdu]);
      const blockSize = packetSize - 5;
      const nbBlocks = Math.ceil(data.length / blockSize);
      data = Buffer.concat([
        data, // fill data with padding
        Buffer.alloc(nbBlocks * blockSize - data.length + 1).fill(0),
      ]);
      const blocks: Buffer[] = [];

      for (let i = 0; i < nbBlocks; i++) {
        const head = Buffer.alloc(5);
        head.writeUInt16BE(channel, 0);
        head.writeUInt8(Tag, 2);
        head.writeUInt16BE(i, 3);
        const chunk = data.subarray(i * blockSize, (i + 1) * blockSize);
        blocks.push(Buffer.concat([head, chunk]));
      }

      return blocks;
    },

    reduceResponse(acc: ResponseAcc, chunk: Buffer): ResponseAcc {
      let { data, dataLength, sequence } = acc || initialAcc;

      if (chunk.readUInt16BE(0) !== channel) {
        throw new TransportError("Invalid channel", "InvalidChannel");
      }

      if (chunk.readUInt8(2) !== Tag) {
        throw new TransportError("Invalid tag", "InvalidTag");
      }

      if (chunk.readUInt16BE(3) !== sequence) {
        throw new TransportError("Invalid sequence", "InvalidSequence");
      }

      if (!acc) {
        dataLength = chunk.readUInt16BE(5);
      }

      sequence++;
      const chunkData = chunk.subarray(acc ? 5 : 7);
      data = Buffer.concat([data, chunkData]);

      if (data.length > dataLength) {
        data = data.subarray(0, dataLength);
      }

      return {
        data,
        dataLength,
        sequence
      };
    },

    getReducedResult(acc: ResponseAcc): Buffer | null | undefined {
      if (acc && acc.dataLength === acc.data.length) {
        return acc.data;
      }
    },
  };
};