import { DeviceModel } from "./types/device-types";

export namespace KProDevice {
  const device: DeviceModel = {
    id: 0,
    productName: "Keycard Pro Wallet",
    productId: 0x0001
  }

  export const identifyUSBProductId = (usbProductId: number): DeviceModel | null | undefined => {
    return device.productId === usbProductId ? device : null;
  };

  export const identifyProductName = (productName: string): DeviceModel | null | undefined => {
    return (productName === device.productName) ? device : null;
  };
}