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

/**
 * A Log object
 */
import { LogsTypes } from ".";
import { Subscriber, Unsubscribe, Log } from "./types/logs-types";
let id = 0;
const subscribers: Subscriber[] = [];

/**
 * log something
 * @param type a namespaced identifier of the log (it is not a level like "debug", "error" but more like "apdu-in", "apdu-out", etc...)
 * @param message a clear message of the log associated to the type
 */
export const log = (type: string, message?: string, data?: any) => {
  const obj: Log = {
    type,
    id: String(++id),
    date: new Date(),
  };
  if (message) obj.message = message;
  if (data) obj.data = data;
  dispatch(obj);
};

/**
 * listen to logs.
 * @param cb that is called for each future log() with the Log object
 * @return a function that can be called to unsubscribe the listener
 */
export const listen = (cb: Subscriber): Unsubscribe => {
  subscribers.push(cb);
  return () => {
    const i = subscribers.indexOf(cb);

    if (i !== -1) {
      // equivalent of subscribers.splice(i, 1) // https://twitter.com/Rich_Harris/status/1125850391155965952
      subscribers[i] = subscribers[subscribers.length - 1];
      subscribers.pop();
    }
  };
};

const dispatch = (log: Log): void => {
  for (let i = 0; i < subscribers.length; i++) {
    try {
      subscribers[i](log);
    } catch (e) {
      console.error(e);
    }
  }
}

// for debug purpose

declare global {
  interface Window {
    __shellLogsListen: any;
  }
}

if (typeof window !== "undefined") {
  window.__shellLogsListen = listen;
}

export const trace = ({
  type,
  message,
  data,
  context,
}: {
  type: LogsTypes.LogType;
  message?: string;
  data?: LogsTypes.LogData;
  context?: LogsTypes.TraceContext;
}) => {
  const obj: Log = {
    type,
    id: String(++id),
    date: new Date(),
  };

  if (message) obj.message = message;
  if (data) obj.data = data;
  if (context) obj.context = context;

  dispatch(obj);
};

export class LocalTracer {
  constructor(private type: LogsTypes.LogType, private context?: LogsTypes.TraceContext) {}

  trace(message: string, data?: LogsTypes.TraceContext) {
    trace({
      type: this.type,
      message,
      data,
      context: this.context,
    });
  }

  getContext(): LogsTypes.TraceContext | undefined {
    return this.context;
  }

  setContext(context?: LogsTypes.TraceContext) {
    this.context = context;
  }

  updateContext(contextToAdd: LogsTypes.TraceContext) {
    this.context = { ...this.context, ...contextToAdd };
  }

  getType(): LogsTypes.LogType {
    return this.type;
  }

  setType(type: LogsTypes.LogType) {
    this.type = type;
  }

  /**
   * Create a new instance of the LocalTracer with an updated `type`
   *
   * It does not mutate the calling instance, but returns a new LocalTracer,
   * following a simple builder pattern.
   */
  withType(type: LogsTypes.LogType): LocalTracer {
    return new LocalTracer(type, this.context);
  }

  /**
   * Create a new instance of the LocalTracer with a new `context`
   *
   * It does not mutate the calling instance, but returns a new LocalTracer,
   * following a simple builder pattern.
   *
   * @param context A TraceContext, that can undefined to reset the context
   */
  withContext(context?: LogsTypes.TraceContext): LocalTracer {
    return new LocalTracer(this.type, context);
  }

  /**
   * Create a new instance of the LocalTracer with an updated `context`,
   * on which an additional context is merged with the existing one.
   *
   * It does not mutate the calling instance, but returns a new LocalTracer,
   * following a simple builder pattern.
   */
  withUpdatedContext(contextToAdd: LogsTypes.TraceContext): LocalTracer {
    return new LocalTracer(this.type, { ...this.context, ...contextToAdd });
  }
}