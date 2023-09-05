import type { DescriptorEvent } from "./transport-types"

export type ResponseAcc =
  | {
      data: Buffer;
      dataLength: number;
      sequence: number;
    }
  | null
  | undefined;

  export type ListenDescriptorEvent = DescriptorEvent<any>;