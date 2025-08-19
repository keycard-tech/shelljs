import Commands from "./commands"
import Transport from "./transport"
import { ShellDevice } from "./device"
import * as ShellError from "./errors"
import * as ShellErrorHelpers from "./error-helpers"
import * as HIDFraming from "./hid-framing"
import * as ShellLogs from "./logs"
import * as ShellPromise from "./promise"

import type * as DeviceTypes from "./types/device-types"
import type * as ErrorTypes from "./types/error-types"
import type * as HIDTypes from "./types/hid-types"
import type * as LogsTypes from "./types/logs-types"
import type * as PromiseTypes from "./types/promise-types"
import type * as TransportTypes from "./types/transport-types"


export let ShellJS = {
  Commands: Commands,
  ShellDevice: ShellDevice,
  ShellError: ShellError,
  ShellErrorHelpers: ShellErrorHelpers,
  HIDFraming: HIDFraming,
  ShellLogs: ShellLogs,
  ShellPromise: ShellPromise,
  Transport: Transport,
}

export { DeviceTypes, ErrorTypes, TransportTypes, LogsTypes, HIDTypes, PromiseTypes} ;
export default ShellJS;
