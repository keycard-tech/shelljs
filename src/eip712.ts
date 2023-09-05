/* eslint @typescript-eslint/no-duplicate-enum-values: 1 */
import type * as EIP712Types from "./types/eip712-types";
import Transport from "./transport";
import { hexBuffer, intAsHexBytes, splitPath } from "./utils";
import { destructTypeFromString, EIP712_TYPE_ENCODERS, EIP712_TYPE_PROPERTIES } from "./eip712-utils";

const NULL_ADDRESS = "0x0000000000000000000000000000000000000000";
const CryptoJS = require("crypto-js");

// As defined in [spec](https://eips.ethereum.org/EIPS/eip-712), the properties below are all required.
export function isEIP712Message(message: unknown): message is EIP712Types.EIP712Message {
  return (
    !!message &&
    typeof message === "object" &&
    "types" in message &&
    "primaryType" in message &&
    "domain" in message &&
    "message" in message
  );
}

export const sortObjectAlphabetically = (obj: Record<string, unknown>): Record<string, unknown> => {
  const keys = Object.keys(obj).sort();

  return keys.reduce((acc, curr) => {
    const value = (() => {
      if (Array.isArray(obj[curr])) {
        return (obj[curr] as unknown[]).map(field =>
          sortObjectAlphabetically(field as Record<string, unknown>),
        );
      }
      return obj[curr];
    })();

    (acc as Record<string, unknown>)[curr] = value;
    return acc;
  }, {});
};

export const getSchemaHashForMessage = (message: EIP712Types.EIP712Message): string => {
  const { types } = message;
  const sortedTypes = sortObjectAlphabetically(types);

  return CryptoJS.SHA224(JSON.stringify(sortedTypes).replace(" ", "")).toString();
};

/**
 * Get the value at a specific path of an object and return it as a string or as an array of string
 * Used recursively by getValueFromPath
 *
 * @see getValueFromPath
 */
const getValue = (
  path: string,
  value: Record<string, any> | Array<any> | string,
): Record<string, any> | Array<any> | string => {
  if (typeof value === "object") {
    if (Array.isArray(value)) {
      return value.map(v => getValue(path, v)).flat();
    }

    /* istanbul ignore if : unecessary test of a throw */
    if (!(path in value)) {
      throw new Error(`Could not find key ${value} in ${path}`);
    }
    const result = value[path];
    return typeof result === "object" ? result : result.toString();
  }

  return value.toString();
};

/**
 * Using a path as a string, returns the value(s) of a json key without worrying about depth or arrays
 * (e.g: 'to.wallets.[]' => ["0x123", "0x456"])
 */
const getValueFromPath = (path: string, eip721Message: EIP712Types.EIP712Message): string | string[] => {
  const splittedPath = path.split(".");
  const { message } = eip721Message;

  let value: any = message;
  for (let i = 0; i <= splittedPath.length - 1; i++) {
    const subPath = splittedPath[i];
    const isLastElement = i >= splittedPath.length - 1;
    if (subPath === "[]" && !isLastElement) continue;

    value = getValue(subPath, value);
  }

  /* istanbul ignore if : unecessary test of a throw */
  if (value === message) {
    throw new Error("getValueFromPath returned the whole original message");
  }

  return value as string | string[];
};

/**
 * @ignore for the README
 *
 * Factory to create the recursive function that will pass on each
 * field level and APDUs to describe its structure implementation
 *
 * @param {Eth["sendStructImplem"]} sendStructImplem
 * @param {EIP712MessageTypes} types
 * @returns {void}
 */
const makeRecursiveFieldStructImplem = (
  transport: Transport,
  types: EIP712Types.EIP712MessageTypes,
  filters?: EIP712Types.MessageFilters,
): ((
  destructedType: ReturnType<typeof destructTypeFromString>,
  data: unknown,
  path?: string,
) => Promise<void>) => {
  const typesMap = {} as Record<string, Record<string, string>>;
  for (const type in types) {
    typesMap[type] = types[type]?.reduce((acc: any, curr: any) => ({ ...acc, [curr.name]: curr.type }), {});
  }

  // This recursion will call itself to handle each level of each field
  // in order to send APDUs for each of them
  const recursiveFieldStructImplem = async (
    destructedType: ReturnType<typeof destructTypeFromString>,
    data: any,
    path = "",
  ) => {
    const [typeDescription, arrSizes] = destructedType;
    const [currSize, ...restSizes] = arrSizes;
    const isCustomType = !EIP712_TYPE_PROPERTIES[typeDescription?.name?.toUpperCase() || ""];

    if (Array.isArray(data) && typeof currSize !== "undefined") {
      await sendStructImplem(transport, {
        structType: "array",
        value: data.length,
      });
      for (const entry of data) {
        await recursiveFieldStructImplem([typeDescription, restSizes], entry, `${path}.[]`);
      }
    } else if (isCustomType) {
      for (const [fieldName, fieldValue] of Object.entries(data as EIP712Types.EIP712Message["message"])) {
        const fieldType = typesMap[typeDescription?.name || ""]?.[fieldName];

        if (fieldType) {
          await recursiveFieldStructImplem(
            destructTypeFromString(fieldType),
            fieldValue,
            `${path}.${fieldName}`,
          );
        }
      }
    } else {
      const filter = filters?.fields.find((f: any) => path === f.path);

      if (filter) {
        await sendFilteringInfo(transport, "showField", {
          displayName: filter.label,
          sig: filter.signature,
        });
      }

      await sendStructImplem(transport, {
        structType: "field",
        value: {
          data,
          type: typeDescription?.name || "",
          sizeInBits: typeDescription?.bits,
        },
      });
    }
  };

  return recursiveFieldStructImplem;
};

/**
 * @ignore for the README
 *
 * This method is used to send the message definition with all its types.
 * This method should be used before the sendStructImplem one
 *
 * @param {String} structType
 * @param {String|Buffer} value
 * @returns {Promise<void>}
 */
const sendStructDef = (transport: Transport, structDef: EIP712Types.StructDefData): Promise<Buffer> => {
  enum APDU_FIELDS {
    CLA = 0xe0,
    INS = 0x1a,
    P1_complete = 0x00,
    P1_partial = 0x01,
    P2_name = 0x00,
    P2_field = 0xff,
  }

  const { structType, value } = structDef;
  const data =
    structType === "name" && typeof value === "string"
      ? Buffer.from(value, "utf-8")
      : (value as Buffer);

  return transport.send(
    APDU_FIELDS.CLA,
    APDU_FIELDS.INS,
    APDU_FIELDS.P1_complete,
    structType === "name" ? APDU_FIELDS.P2_name : APDU_FIELDS.P2_field,
    data,
  );
};

/**
 * @ignore for the README
 *
 * This method provides a trusted new display name to use for the upcoming field.
 * This method should be used after the sendStructDef one.
 *
 * If the method describes an empty name (length of 0), the upcoming field will be taken
 * into account but won’t be shown on the device.
 *
 * The signature is computed on :
 * json key length || json key || display name length || display name
 *
 * signed by the following secp256k1 public key:
 * 0482bbf2f34f367b2e5bc21847b6566f21f0976b22d3388a9a5e446ac62d25cf725b62a2555b2dd464a4da0ab2f4d506820543af1d242470b1b1a969a27578f353
 *
 * @param {String} structType "root" | "array" | "field"
 * @param {string | number | StructFieldData} value
 * @returns {Promise<Buffer | void>}
 */
const sendStructImplem = async (
  transport: Transport,
  structImplem: EIP712Types.StructImplemData,
): Promise<Buffer | void> => {
  enum APDU_FIELDS {
    CLA = 0xe0,
    INS = 0x1c,
    P1_complete = 0x00,
    P1_partial = 0x01,
    P2_root = 0x00,
    P2_array = 0x0f,
    P2_field = 0xff,
  }

  const { structType, value } = structImplem;

  if (structType === "root") {
    return transport.send(
      APDU_FIELDS.CLA,
      APDU_FIELDS.INS,
      APDU_FIELDS.P1_complete,
      APDU_FIELDS.P2_root,
      Buffer.from(value, "utf-8"),
    );
  }

  if (structType === "array") {
    return transport.send(
      APDU_FIELDS.CLA,
      APDU_FIELDS.INS,
      APDU_FIELDS.P1_complete,
      APDU_FIELDS.P2_array,
      Buffer.from(intAsHexBytes(value, 1), "hex"),
    );
  }

  if (structType === "field") {
    const { data: rawData, type, sizeInBits } = value;
    let encodedData: Buffer | null;
    const k = type.toUpperCase();
    if (k == "INT" || k == "BYTES") {
      encodedData = EIP712_TYPE_ENCODERS[k]?.(
        rawData,
        sizeInBits
      );
    } else {
      encodedData = EIP712_TYPE_ENCODERS[k as keyof typeof EIP712_TYPE_ENCODERS]?.(
        rawData
      );
    }


    if (encodedData) {
      // const dataLengthPer16Bits = (encodedData.length & 0xff00) >> 8;
      const dataLengthPer16Bits = Math.floor(encodedData.length / 256);
      // const dataLengthModulo16Bits = encodedData.length & 0xff;
      const dataLengthModulo16Bits = encodedData.length % 256;

      const data = Buffer.concat([
        Buffer.from(intAsHexBytes(dataLengthPer16Bits, 1), "hex"),
        Buffer.from(intAsHexBytes(dataLengthModulo16Bits, 1), "hex"),
        encodedData,
      ]);

      const bufferSlices = new Array(Math.ceil(data.length / 256))
        .fill(null)
        .map((_, i) => data.slice(i * 255, (i + 1) * 255));

      for (const bufferSlice of bufferSlices) {
        await transport.send(
          APDU_FIELDS.CLA,
          APDU_FIELDS.INS,
          bufferSlice !== bufferSlices[bufferSlices.length - 1]
            ? APDU_FIELDS.P1_partial
            : APDU_FIELDS.P1_complete,
          APDU_FIELDS.P2_field,
          bufferSlice,
        );
      }
    }
  }

  return Promise.resolve();
};

async function sendFilteringInfo(transport: Transport, type: "activate"): Promise<Buffer>;
async function sendFilteringInfo(
  transport: Transport,
  type: "contractName",
  data: EIP712Types.FilteringInfoContractName,
): Promise<Buffer>;
async function sendFilteringInfo(
  transport: Transport,
  type: "showField",
  data: EIP712Types.FilteringInfoShowField,
): Promise<Buffer>;
async function sendFilteringInfo(
  transport: Transport,
  type: "activate" | "contractName" | "showField",
  data?: EIP712Types.FilteringInfoContractName | EIP712Types.FilteringInfoShowField,
): Promise<Buffer | void> {
  enum APDU_FIELDS {
    CLA = 0xe0,
    INS = 0x1e,
    P1 = 0x00,
    P2_activate = 0x00,
    P2_contract_name = 0x0f, // officially named "message info"
    P2_show_field = 0xff,
  }

  switch (type) {
    case "activate":
      return transport.send(
        APDU_FIELDS.CLA,
        APDU_FIELDS.INS,
        APDU_FIELDS.P1,
        APDU_FIELDS.P2_activate,
      );

    case "contractName": {
      const { displayName, filtersCount, sig } = data as EIP712Types.FilteringInfoContractName;
      const displayNameLengthBuffer = Buffer.from(intAsHexBytes(displayName.length, 1), "hex");
      const displayNameBuffer = Buffer.from(displayName);
      const filtersCountBuffer = Buffer.from(intAsHexBytes(filtersCount, 1), "hex");
      const sigLengthBuffer = Buffer.from(intAsHexBytes(sig.length / 2, 1), "hex");
      const sigBuffer = Buffer.from(sig, "hex");

      const callData = Buffer.concat([
        displayNameLengthBuffer,
        displayNameBuffer,
        filtersCountBuffer,
        sigLengthBuffer,
        sigBuffer,
      ]);

      return transport.send(
        APDU_FIELDS.CLA,
        APDU_FIELDS.INS,
        APDU_FIELDS.P1,
        APDU_FIELDS.P2_contract_name,
        callData,
      );
    }

    case "showField": {
      const { displayName, sig } = data as EIP712Types.FilteringInfoShowField;
      const displayNameLengthBuffer = Buffer.from(intAsHexBytes(displayName.length, 1), "hex");
      const displayNameBuffer = Buffer.from(displayName);
      const sigLengthBuffer = Buffer.from(intAsHexBytes(sig.length / 2, 1), "hex");
      const sigBuffer = Buffer.from(sig, "hex");

      const callData = Buffer.concat([
        displayNameLengthBuffer,
        displayNameBuffer,
        sigLengthBuffer,
        sigBuffer,
      ]);

      return transport.send(
        APDU_FIELDS.CLA,
        APDU_FIELDS.INS,
        APDU_FIELDS.P1,
        APDU_FIELDS.P2_show_field,
        callData,
      );
    }
  }
}

/**
 * @ignore for the README
 *
 * Sign an EIP-721 formatted message following the specification here:
 * @example
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
export const signEIP712Message = async (transport: Transport, path: string, jsonMessage: EIP712Types.EIP712Message, fullImplem = false): Promise<{ v: number; s: string; r: string; }> => {
  enum APDU_FIELDS {
    CLA = 0xe0,
    INS = 0x0c,
    P1 = 0x00,
    P2_v0 = 0x00,
    P2_full = 0x01,
  }

  return new Promise(() => {});
};

/**
 * @ignore for the README
 * Sign a prepared message following web3.eth.signTypedData specification. The host computes the domain separator and hashStruct(message)
 * @example
 eth.signEIP712HashedMessage("44'/60'/0'/0/0", Buffer.from("0101010101010101010101010101010101010101010101010101010101010101").toString("hex"), Buffer.from("0202020202020202020202020202020202020202020202020202020202020202").toString("hex")).then(result => {
 var v = result['v'] - 27;
 v = v.toString(16);
 if (v.length < 2) {
   v = "0" + v;
 }
 console.log("Signature 0x" + result['r'] + result['s'] + v);
 })
 */
export const signEIP712HashedMessage = (
  transport: Transport,
  path: string,
  domainSeparatorHex: string,
  hashStructMessageHex: string,
): Promise<{
  v: number;
  s: string;
  r: string;
}> => {
  const domainSeparator = hexBuffer(domainSeparatorHex);
  const hashStruct = hexBuffer(hashStructMessageHex);
  const paths = splitPath(path);
  const buffer = Buffer.alloc(1 + paths.length * 4 + 32 + 32, 0);
  let offset = 0;
  buffer[0] = paths.length;
  paths.forEach((element: any, index: any) => {
    buffer.writeUInt32BE(element, 1 + 4 * index);
  });
  offset = 1 + 4 * paths.length;
  domainSeparator.copy(buffer, offset);
  offset += 32;
  hashStruct.copy(buffer, offset);

  return transport.send(0xe0, 0x0c, 0x00, 0x00, buffer).then(response => {
    const v = response[0];
    const r = response.slice(1, 1 + 32).toString("hex");
    const s = response.slice(1 + 32, 1 + 32 + 32).toString("hex");
    return {
      v,
      r,
      s,
    };
  });
};