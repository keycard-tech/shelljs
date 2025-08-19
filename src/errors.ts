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
import { serializeError, deserializeError, createCustomErrorClass, addCustomErrorDeserializer } from "./error-helpers";
export { serializeError, deserializeError, createCustomErrorClass, addCustomErrorDeserializer };

export const CantOpenDevice = createCustomErrorClass("CantOpenDevice");

export const UnresponsiveDeviceError = createCustomErrorClass("UnresponsiveDeviceError");
export const DisconnectedDevice = createCustomErrorClass("DisconnectedDevice");
export const DisconnectedDeviceDuringOperation = createCustomErrorClass("DisconnectedDeviceDuringOperation");

export const TransportOpenUserCancelled = createCustomErrorClass("TransportOpenUserCancelled");
export const TransportInterfaceNotAvailable = createCustomErrorClass("TransportInterfaceNotAvailable");
export const TransportRaceCondition = createCustomErrorClass("TransportRaceCondition");
export const TransportWebUSBGestureRequired = createCustomErrorClass("TransportWebUSBGestureRequired");

export const LockedDeviceError = createCustomErrorClass("LockedDeviceError");
export const InvalidTxData = createCustomErrorClass("InvalidTxData");

/**
 * Type of a Transport error used to represent all equivalent errors coming from all possible implementation of Transport
 */
export enum HwTransportErrorType {
  Unknown = "Unknown",
  LocationServicesDisabled = "LocationServicesDisabled",
  LocationServicesUnauthorized = "LocationServicesUnauthorized",
  BluetoothScanStartFailed = "BluetoothScanStartFailed",
}

/**
 * Represents an error coming from the usage of any Transport implementation.
 *
 * Needed to map a specific implementation error into an error that
 * can be managed by any code unaware of the specific Transport implementation
 * that was used.
 */
export class HwTransportError extends Error {
  type: HwTransportErrorType;

  constructor(type: HwTransportErrorType, message: string) {
    super(message);
    this.name = "HwTransportError";
    this.type = type;

    // Needed as long as we target < ES6
    Object.setPrototypeOf(this, HwTransportError.prototype);
  }
}

/**
 * TransportError is used for any generic transport errors.
 * e.g. Error thrown when data received by exchanges are incorrect or if exchanged failed to communicate with the device for various reason.
 */
export class TransportError extends Error {
  id: string;

  constructor(message: string, id: string) {
    const name = "TransportError";
    super(message || name);
    this.name = name;
    this.message = message;
    this.stack = new Error(message).stack;
    this.id = id;
  }
}

addCustomErrorDeserializer("TransportError", (e: any) => new TransportError(e.message, e.id));

export const StatusCodes = {
  ACCESS_CONDITION_NOT_FULFILLED: 0x9804,
  ALGORITHM_NOT_SUPPORTED: 0x9484,
  CLA_NOT_SUPPORTED: 0x6e00,
  CODE_BLOCKED: 0x9840,
  CODE_NOT_INITIALIZED: 0x9802,
  COMMAND_INCOMPATIBLE_FILE_STRUCTURE: 0x6981,
  CONDITIONS_OF_USE_NOT_SATISFIED: 0x6985,
  CONTRADICTION_INVALIDATION: 0x9810,
  CONTRADICTION_SECRET_CODE_STATUS: 0x9808,
  CUSTOM_IMAGE_BOOTLOADER: 0x662f,
  CUSTOM_IMAGE_EMPTY: 0x662e,
  FILE_ALREADY_EXISTS: 0x6a89,
  FILE_NOT_FOUND: 0x9404,
  GP_AUTH_FAILED: 0x6300,
  HALTED: 0x6faa,
  INCONSISTENT_FILE: 0x9408,
  INCORRECT_DATA: 0x6a80,
  INCORRECT_LENGTH: 0x6700,
  INCORRECT_P1_P2: 0x6b00,
  INS_NOT_SUPPORTED: 0x6d00,
  DEVICE_NOT_ONBOARDED: 0x6d07,
  DEVICE_NOT_ONBOARDED_2: 0x6611,
  INVALID_KCV: 0x9485,
  INVALID_OFFSET: 0x9402,
  LICENSING: 0x6f42,
  LOCKED_DEVICE: 0x5515,
  MAX_VALUE_REACHED: 0x9850,
  MEMORY_PROBLEM: 0x9240,
  MISSING_CRITICAL_PARAMETER: 0x6800,
  NO_EF_SELECTED: 0x9400,
  NOT_ENOUGH_MEMORY_SPACE: 0x6a84,
  OK: 0x9000,
  PIN_REMAINING_ATTEMPTS: 0x63c0,
  REFERENCED_DATA_NOT_FOUND: 0x6a88,
  SECURITY_STATUS_NOT_SATISFIED: 0x6982,
  TECHNICAL_PROBLEM: 0x6f00,
  UNKNOWN_APDU: 0x6d02,
  USER_REFUSED_ON_DEVICE: 0x5501,
  NOT_ENOUGH_SPACE: 0x5102,
};

export const getAltStatusMessage = (code: number): string | undefined | null => {
  switch (code) {
    // improve text of most common errors
    case 0x6700:
      return "Incorrect length";
    case 0x6800:
      return "Missing critical parameter";
    case 0x6982:
      return "Security not satisfied (dongle locked or have invalid access rights)";
    case 0x6985:
      return "Condition of use not satisfied (denied by the user?)";
    case 0x6a80:
      return "Invalid data received";
    case 0x6b00:
      return "Invalid parameter received";
    case 0x5515:
      return "Locked device";
  }
  if (0x6f00 <= code && code <= 0x6fff) {
    return "Internal error, please report";
  }
}

/**
 * Error thrown when a device returned a non success status.
 * the error.statusCode is one of the `StatusCodes` exported by this library.
 */
export class TransportStatusError extends Error {
  statusCode: number;
  statusText: string;

  constructor(statusCode: number) {
    const statusText = Object.keys(StatusCodes).find(k  => StatusCodes[k as keyof typeof StatusCodes] === statusCode) || "UNKNOWN_ERROR";
    const smsg = getAltStatusMessage(statusCode) || statusText;
    const statusCodeStr = statusCode.toString(16);
    const message = `Shell device: ${smsg} (0x${statusCodeStr})`;

    // Maps to a LockedDeviceError
    if (statusCode === StatusCodes.LOCKED_DEVICE) {
      throw new LockedDeviceError(message);
    }

    super(message);
    this.name = "TransportStatusError";
    this.message = message;
    this.stack = new Error(message).stack;
    this.statusCode = statusCode;
    this.statusText = statusText;
  }

}

addCustomErrorDeserializer("TransportStatusError", (e: any) => new TransportStatusError(e.statusCode));