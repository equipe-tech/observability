import { $ } from "bun";
import { existsSync } from "node:fs";
import path from "node:path";

type VendoredRepo = {
  readonly name: string;
  readonly url: string;
  readonly ref: string;
};

type VendoredReposManifest = {
  readonly reposDir: string;
  readonly repos: ReadonlyArray<VendoredRepo>;
};

const projectRoot = path.resolve(import.meta.dir, "..");
const manifestPath = path.join(projectRoot, "repos.json");
const manifest: VendoredReposManifest = await Bun.file(manifestPath).json();
const reposDir = path.join(projectRoot, manifest.reposDir);

for (const repo of manifest.repos) {
  const target = path.join(reposDir, repo.name);
  if (existsSync(target)) {
    console.log(`updating ${repo.name} to ${repo.ref}`);
    await $`git -C ${target} fetch --depth 1 origin tag ${repo.ref} --no-tags`.quiet();
    await $`git -C ${target} checkout --detach ${repo.ref}`.quiet();
  } else {
    console.log(`cloning ${repo.name} at ${repo.ref}`);
    await $`git clone --depth 1 --branch ${repo.ref} ${repo.url} ${target}`.quiet();
  }
  console.log(`${repo.name} ready at ${repo.ref}`);
}
