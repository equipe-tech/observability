import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { parseRegistryTarball, RegistryPackageFetchError } from "../scripts/registry-package.ts";

const writeText = (target: Uint8Array, offset: number, length: number, value: string): void => {
  target.set(Buffer.from(value).subarray(0, length), offset);
};

const tarball = (path: string, type: string, content = "value"): Uint8Array => {
  const header = new Uint8Array(512);
  writeText(header, 0, 100, path);
  writeText(header, 100, 8, "0000644\0");
  writeText(header, 108, 8, "0000000\0");
  writeText(header, 116, 8, "0000000\0");
  writeText(header, 124, 12, `${content.length.toString(8).padStart(11, "0")}\0`);
  writeText(header, 136, 12, "00000000000\0");
  writeText(header, 148, 8, "        ");
  writeText(header, 156, 1, type);
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const bodyBlocks = Math.ceil(content.length / 512);
  const archive = new Uint8Array(512 + bodyBlocks * 512 + 1024);
  archive.set(header, 0);
  archive.set(Buffer.from(content), 512);
  return gzipSync(archive);
};

const expectUnsafeTarball = (archive: Uint8Array): void => {
  expect(() => parseRegistryTarball(archive)).toThrow(RegistryPackageFetchError);
};

describe("registry package extraction", () => {
  test("accepts regular files under the package root", () => {
    expect(parseRegistryTarball(tarball("package/dist/index.d.ts", "0"))).toEqual([
      expect.objectContaining({ path: "dist/index.d.ts", type: "file" }),
    ]);
  });

  test("rejects traversal, absolute, symlink and hardlink entries", () => {
    expectUnsafeTarball(tarball("package/../../outside", "0"));
    expectUnsafeTarball(tarball("/package/index.js", "0"));
    expectUnsafeTarball(tarball("package/link", "2", ""));
    expectUnsafeTarball(tarball("package/link", "1", ""));
  });
});
