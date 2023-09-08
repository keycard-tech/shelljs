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
import type { DeviceModel } from "./device-types";

/**
 */
export type Subscription = {
  unsubscribe: () => void;
};

/**
 */
export type Device = any; // Should be a union type of all possible Device object's shape

export type DescriptorEventType = "add" | "remove";
/**
 * A "descriptor" is a parameter that is specific to the implementation, and can be an ID, file path, or URL.
 * type: add or remove event
 * descriptor: a parameter that can be passed to open(descriptor)
 * deviceModel: device info on the model (is it a nano s, nano x, ...)
 * device: transport specific device info
 */
export interface DescriptorEvent<Descriptor> {
  type: DescriptorEventType;
  descriptor: Descriptor;
  deviceModel?: DeviceModel | null | undefined;
  device?: Device;
}

/**
 * Observer generic type, following the Observer pattern
 */
export type Observer<EventType, EventError = unknown> = Readonly<{
  next: (event: EventType) => unknown;
  error: (e: EventError) => unknown;
  complete: () => unknown;
}>;