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
import { DeviceModel } from "./types/device-types";

export namespace ShellDevice {
  const devices: DeviceModel[] = [
    {
        id: 0,
        productName: "Keycard Shell (Beta)",
        productId: 0x0001
    },
    {
        id: 1,
        productName: "Keycard Shell",
        productId: 0x21F7
    }
]

  export const identifyUSBProductId = (usbProductId: number): DeviceModel | null | undefined => {
    return devices.find((device) => device.productId === usbProductId);
  };

  export const identifyProductName = (productName: string): DeviceModel | null | undefined => {
    return devices.find((device) => device.productName === productName);
  };
}