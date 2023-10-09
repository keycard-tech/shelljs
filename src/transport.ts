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
import EventEmitter from "events";
import { TransportRaceCondition, TransportError, StatusCodes, getAltStatusMessage, TransportStatusError } from "./errors";
import * as TransportTypes from "./types/transport-types"
export { TransportError, TransportStatusError, StatusCodes, getAltStatusMessage };
import { TraceContext, LogType } from "./types/logs-types";
import { LocalTracer } from "./logs";

const DEFAULT_LOG_TYPE = "transport";

/**
 * The Transport class defines a generic interface for communicating with a KPro hardware wallet.
 * There are different kind of transports based on the technology (channels like U2F, HID, Bluetooth, Webusb) and environment (Node, Web,...).
 * It is an abstract class that needs to be implemented.
 */
export default class Transport {
  exchangeTimeout = 30000;
  unresponsiveTimeout = 15000;
  exchangeBusyPromise: Promise<void> | null | undefined;
  tracer: LocalTracer;

  constructor({ context, logType }: { context?: TraceContext; logType?: LogType } = {}) {
    this.tracer = new LocalTracer(logType ?? DEFAULT_LOG_TYPE, context);
  }

  /**
   * Check if the transport is supported on the current platform/browser.
   * @returns {Promise<boolean>} A promise that resolves with a boolean indicating support.
   */
  static readonly isSupported: () => Promise<boolean>;

  /**
   * List all available descriptors for the transport.
   * For a better granularity, checkout `listen()`.
   *
   * @returns {Promise<Array<any>>} A promise that resolves with an array of descriptors.
   * @example
   * TransportFoo.list().then(descriptors => ...)
   */
  static readonly list: () => Promise<Array<any>>;

  /**
   * Listen for device events for the transport. The method takes an observer of DescriptorEvent and returns a Subscription.
   * A DescriptorEvent is an object containing a "descriptor" and a "type" field. The "type" field can be "add" or "remove", and the "descriptor" field can be passed to the "open" method.
   * The "listen" method will first emit all currently connected devices and then will emit events as they occur, such as when a USB device is plugged in or a Bluetooth device becomes discoverable.
   * @param {Observer<DescriptorEvent<any>>} observer - An object with "next", "error", and "complete" functions, following the observer pattern.
   * @returns {Subscription} A Subscription object on which you can call ".unsubscribe()" to stop listening to descriptors.
   * @example
  const sub = TransportFoo.listen({
  next: e => {
    if (e.type==="add") {
      sub.unsubscribe();
      const transport = await TransportFoo.open(e.descriptor);
      ...
    }
  },
  error: error => {},
  complete: () => {}
  })
   */
  static readonly listen: (observer: TransportTypes.Observer<TransportTypes.DescriptorEvent<any>>) => TransportTypes.Subscription;

  /**
   * Attempt to create a Transport instance with a specific descriptor.
   * @param {any} descriptor - The descriptor to open the transport with.
   * @param {number} timeout - An optional timeout for the transport connection.
   * @returns {Promise<Transport>} A promise that resolves with a Transport instance.
   * @example
  TransportFoo.open(descriptor).then(transport => ...)
   */
  static readonly open: (descriptor?: any, timeout?: number) => Promise<Transport>;

  /**
   * Send data to the device using a low level API.
   * It's recommended to use the "send" method for a higher level API.
   * @param {Buffer} apdu - The data to send.
   * @returns {Promise<Buffer>} A promise that resolves with the response data from the device.
   */
  exchange(_apdu: Buffer): Promise<Buffer> {
    throw new Error("exchange not implemented");
  }

  /**
   * Send apdus in batch to the device using a low level API.
   * The default implementation is to call exchange for each apdu.
   * @param {Array<Buffer>} apdus - array of apdus to send.
   * @param {Observer<Buffer>} observer - an observer that will receive the response of each apdu.
   * @returns {Subscription} A Subscription object on which you can call ".unsubscribe()" to stop sending apdus.
   */
  exchangeBulk(apdus: Buffer[], observer: TransportTypes.Observer<Buffer>): TransportTypes.Subscription {
    let unsubscribed = false;
    const unsubscribe = () => {
      unsubscribed = true;
    };

    const main = async () => {
      if (unsubscribed) return;
      for (const apdu of apdus) {
        const r = await this.exchange(apdu);
        if (unsubscribed) return;
        const status = r.readUInt16BE(r.length - 2);
        if (status !== StatusCodes.OK) {
          throw new TransportStatusError(status);
        }
        observer.next(r);
      }
    };

    main().then(
      () => !unsubscribed && observer.complete(),
      e => !unsubscribed && observer.error(e),
    );

    return { unsubscribe };
  }

  /**
   * Close the connection with the device.
   * @returns {Promise<void>} A promise that resolves when the transport is closed.
   */
  close(): Promise<void> {
    return Promise.resolve();
  }

  _events = new EventEmitter();

  /**
   * Listen for an event on the transport instance.
   * Transport implementations may have specific events. Common events include:
   * "disconnect" : triggered when the transport is disconnected.
   * @param {string} eventName - The name of the event to listen for.
   * @param {(...args: Array<any>) => any} cb - The callback function to be invoked when the event occurs.
   */
  on(eventName: string, cb: (...args: Array<any>) => any): void {
    this._events.on(eventName, cb);
  }

  /**
   * Stop listening to an event on an instance of transport.
   */
  off(eventName: string, cb: (...args: Array<any>) => any): void {
    this._events.removeListener(eventName, cb);
  }

  emit(event: string, ...args: any): void {
    this._events.emit(event, ...args);
  }

  /**
   * Set a timeout (in milliseconds) for the exchange call. Only some transport might implement it. (e.g. U2F)
   */
  setExchangeTimeout(exchangeTimeout: number): void {
    this.exchangeTimeout = exchangeTimeout;
  }

  /**
   * Define the delay before emitting "unresponsive" on an exchange that does not respond
   */
  setExchangeUnresponsiveTimeout(unresponsiveTimeout: number): void {
    this.unresponsiveTimeout = unresponsiveTimeout;
  }

  /**
   * Send data to the device using the higher level API.
   * @param {number} cla - The instruction class for the command.
   * @param {number} ins - The instruction code for the command.
   * @param {number} p1 - The first parameter for the instruction.
   * @param {number} p2 - The second parameter for the instruction.
   * @param {Buffer} data - The data to be sent. Defaults to an empty buffer.
   * @param {Array<number>} statusList - A list of acceptable status codes for the response. Defaults to [StatusCodes.OK].
   * @returns {Promise<Buffer>} A promise that resolves with the response data from the device.
   */
  send = async ( cla: number, ins: number, p1: number, p2: number, data: Buffer = Buffer.alloc(0), statusList: Array<number> = [StatusCodes.OK]): Promise<Buffer> => {
    if (data.length >= 256) {
      throw new TransportError(
        "data.length exceed 256 bytes limit. Got: " + data.length,
        "DataLengthTooBig",
      );
    }

    const response = await this.exchange(Buffer.concat([Buffer.from([cla, ins, p1, p2]), Buffer.from([data.length]), data]));
    const sw = response.readUInt16BE(response.length - 2);

    if (!statusList.some(s => s === sw)) {
      throw new TransportStatusError(sw);
    }

    return response;
  };

  /**
   * create() allows to open the first descriptor available or
   * throw if there is none or if timeout is reached.
   * This is a light helper, alternative to using listen() and open() (that you may need for any more advanced usecase)
   * @example
  TransportFoo.create().then(transport => ...)
   */
  static create(openTimeout = 3000, listenTimeout?: number): Promise<Transport> {
    return new Promise((resolve, reject) => {
      let found = false;
      const sub = this.listen({
        next: e => {
          found = true;
          if (sub) sub.unsubscribe();
          if (listenTimeoutId) clearTimeout(listenTimeoutId);
          this.open(e.descriptor, openTimeout).then(resolve, reject);
        },
        error: e => {
          if (listenTimeoutId) clearTimeout(listenTimeoutId);
          reject(e);
        },
        complete: () => {
          if (listenTimeoutId) clearTimeout(listenTimeoutId);

          if (!found) {
            reject(new TransportError(this.ErrorMessage_NoDeviceFound, "NoDeviceFound"));
          }
        },
      });
      const listenTimeoutId = listenTimeout
        ? setTimeout(() => {
            sub.unsubscribe();
            reject(new TransportError(this.ErrorMessage_ListenTimeout, "ListenTimeout"));
          }, listenTimeout)
        : null;
    });
  }

  exchangeAtomicImpl = async (f: () => Promise<Buffer | void>): Promise<Buffer | void> => {
    if (this.exchangeBusyPromise) {
      throw new TransportRaceCondition(
        "An action was already pending on the KPro device. Please deny or reconnect.",
      );
    }

    let resolveBusy: any;
    const busyPromise: Promise<void> = new Promise(r => {
      resolveBusy = r;
    });

    this.exchangeBusyPromise = busyPromise;
    let unresponsiveReached = false;
    const timeout = setTimeout(() => {
      unresponsiveReached = true;
      this.emit("unresponsive");
    }, this.unresponsiveTimeout);

    try {
      const res = await f();

      if (unresponsiveReached) {
        this.emit("responsive");
      }

      return res;
    } finally {
      clearTimeout(timeout);
      if (resolveBusy) resolveBusy();
      this.exchangeBusyPromise = null;
    }
  };

  static ErrorMessage_ListenTimeout = "No KPro device found (timeout)";
  static ErrorMessage_NoDeviceFound = "No KPro device found";
}