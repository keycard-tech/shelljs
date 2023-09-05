export interface DeviceModel {
  id: number;
  productName: string;
  productId: number;
}

export type Device = {
  locationId: number;
  vendorId: number;
  productId: number;
  deviceName: string;
  manufacturer: string;
  serialNumber: number;
  deviceAddress: number;
};