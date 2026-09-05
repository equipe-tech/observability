export type EvlogDeliveryReceipt = {
  readonly runId: string;
  readonly eventName: string;
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly environment: string;
};

const receipts = new WeakSet<EvlogDeliveryReceipt>();

export const sealEvlogDeliveryReceipt = (receipt: EvlogDeliveryReceipt): EvlogDeliveryReceipt => {
  const sealed = Object.freeze({ ...receipt });
  receipts.add(sealed);
  return sealed;
};

export const isEvlogDeliveryReceipt = (receipt: EvlogDeliveryReceipt): boolean =>
  receipts.has(receipt);
