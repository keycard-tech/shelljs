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