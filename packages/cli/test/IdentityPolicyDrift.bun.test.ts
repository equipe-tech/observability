import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  environmentNameMaxLength,
  resourceNamePattern,
  serviceNameMaxLength,
} from "../src/ResourceNamePolicy.ts";

const cliPolicyPath = fileURLToPath(new URL("../src/ResourceNamePolicy.ts", import.meta.url));
const telemetryPolicyPath = fileURLToPath(
  new URL("../../telemetry/src/ResourceIdentity.ts", import.meta.url),
);

const readPolicy = async (path: string) => {
  const source = await Bun.file(path).text();
  const pattern = source.match(/resourceNamePattern = \/(.+)\/;/)?.[1];
  const serviceLimit = source.match(/serviceNameMaxLength = (\d+);/)?.[1];
  const environmentLimit = source.match(/environmentNameMaxLength = (\d+);/)?.[1];
  if (pattern === undefined || serviceLimit === undefined || environmentLimit === undefined) {
    throw new Error(`Identity policy declarations are missing from ${path}.`);
  }
  return {
    pattern,
    serviceLimit: Number(serviceLimit),
    environmentLimit: Number(environmentLimit),
  };
};

const grammarBoundaryFixtures = [
  ["a", true],
  ["checkout-api", true],
  ["a1-b2", true],
  ["", false],
  ["Checkout", false],
  ["checkout_api", false],
  ["-checkout", false],
  ["checkout-", false],
  ["checkout--api", false],
] as const;

describe("CLI identity policy ownership seam", () => {
  test("matches telemetry regex source, limits, and boundary fixtures", async () => {
    const cli = await readPolicy(cliPolicyPath);
    const telemetry = await readPolicy(telemetryPolicyPath);

    expect(cli).toEqual(telemetry);
    expect(cli.pattern).toBe(resourceNamePattern.source);
    expect(cli.serviceLimit).toBe(serviceNameMaxLength);
    expect(cli.environmentLimit).toBe(environmentNameMaxLength);

    for (const [value, accepted] of grammarBoundaryFixtures) {
      expect(new RegExp(cli.pattern).test(value)).toBe(accepted);
      expect(new RegExp(telemetry.pattern).test(value)).toBe(accepted);
    }
    for (const [value, accepted] of [
      ["a".repeat(serviceNameMaxLength), true],
      ["a".repeat(serviceNameMaxLength + 1), false],
    ] as const) {
      expect(new RegExp(cli.pattern).test(value) && value.length <= cli.serviceLimit).toBe(
        accepted,
      );
      expect(
        new RegExp(telemetry.pattern).test(value) && value.length <= telemetry.serviceLimit,
      ).toBe(accepted);
    }
    for (const [value, accepted] of [
      ["a".repeat(environmentNameMaxLength), true],
      ["a".repeat(environmentNameMaxLength + 1), false],
    ] as const) {
      expect(new RegExp(cli.pattern).test(value) && value.length <= cli.environmentLimit).toBe(
        accepted,
      );
      expect(
        new RegExp(telemetry.pattern).test(value) && value.length <= telemetry.environmentLimit,
      ).toBe(accepted);
    }
  });
});
