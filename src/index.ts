import Eth from "./eth"
import Transport from "./transport"
import { KProDevice } from "./device"
import * as EIP712 from "./eip712"
import * as KProError from "./errors"
import * as KProErrorHelpers from "./error-helpers"
import * as HIDFraming from "./hid-framing"
import * as KProLogs from "./logs"
import * as KProPromise from "./promise"

import type * as DeviceTypes from "./types/device-types"
import type * as ErrorTypes from "./types/error-types"
import type * as HIDTypes from "./types/hid-types"
import type * as LogsTypes from "./types/logs-types"
import type * as PromiseTypes from "./types/promise-types"
import type * as TransportTypes from "./types/transport-types"


export let KProJS = {
  Eth: Eth,
  KProDevice: KProDevice,
  EIP712: EIP712,
  KProError: KProError,
  KProErrorHelpers: KProErrorHelpers,
  HIDFraming: HIDFraming,
  KProLogs: KProLogs,
  KProPromise: KProPromise,
  Transport: Transport,
}

export { DeviceTypes, ErrorTypes, TransportTypes, LogsTypes, HIDTypes, PromiseTypes} ;
export default KProJS;
Object.assign(module.exports, KProJS);
