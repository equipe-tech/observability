export type BundleGzipBudget = {
  readonly artifact: string;
  readonly deltaBytes: number;
  readonly ceilingBytes: number;
};

export const enforceBundleGzipBudget = ({
  artifact,
  deltaBytes,
  ceilingBytes,
}: BundleGzipBudget): void => {
  if (deltaBytes > ceilingBytes) {
    throw new Error(
      `${artifact} gzip delta is ${deltaBytes} bytes, above the ${ceilingBytes} byte regression ceiling.`,
    );
  }
  if (deltaBytes > ceilingBytes * 0.95) {
    throw new Error(
      `${artifact} gzip delta is ${deltaBytes} bytes and leaves less than five percent margin below the ${ceilingBytes} byte ceiling.`,
    );
  }
};
