import { expect, test } from "bun:test";
import { Range, type SemVer } from "semver";
import { compareParsedPeerRanges } from "../scripts/peer-range-coverage.ts";

type VersionPoint = {
  readonly core: number;
  readonly prerelease: ReadonlyArray<string>;
};

const point = (version: SemVer): VersionPoint => ({
  core: version.major,
  prerelease: version.prerelease.map(String),
});
const order = (left: VersionPoint, right: VersionPoint): number => {
  if (left.core !== right.core) return left.core - right.core;
  if (left.prerelease.length === 0 || right.prerelease.length === 0)
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
        ? 1
        : -1;
  for (let index = 0; index < Math.min(left.prerelease.length, right.prerelease.length); index++) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined) break;
    const numericA = /^[0-9]+$/.test(a);
    const numericB = /^[0-9]+$/.test(b);
    if (numericA !== numericB) return numericA ? -1 : 1;
    if (numericA && a.length !== b.length) return a.length - b.length;
    if (a !== b) return a < b ? -1 : 1;
  }
  return left.prerelease.length - right.prerelease.length;
};
const includes = (range: Range, version: VersionPoint): boolean =>
  range.set.some(
    (arm) =>
      (version.prerelease.length === 0 ||
        arm.some(
          (bound) =>
            bound.value !== "" &&
            bound.semver.major === version.core &&
            bound.semver.prerelease.length > 0,
        )) &&
      arm.every((bound) => {
        if (bound.value === "") return true;
        const comparison = order(version, point(bound.semver));
        switch (bound.operator) {
          case "<":
            return comparison < 0;
          case "<=":
            return comparison <= 0;
          case ">":
            return comparison > 0;
          case ">=":
            return comparison >= 0;
          default:
            return comparison === 0;
        }
      }),
  );
const oracle = (baseline: Range, candidate: Range) => {
  const points: Array<VersionPoint> = [
    { core: 0, prerelease: [] },
    { core: 1, prerelease: [] },
    { core: 2, prerelease: [] },
    { core: 1, prerelease: ["0"] },
  ];
  for (const range of [baseline, candidate]) {
    for (const bound of range.set.flat()) {
      if (bound.value === "" || bound.semver.prerelease.length === 0) continue;
      const endpoint = point(bound.semver);
      points.push(endpoint, { ...endpoint, prerelease: [...endpoint.prerelease, "0"] });
    }
  }
  if (points.some((version) => includes(baseline, version) && !includes(candidate, version)))
    return "narrowed";
  return points.some((version) => !includes(baseline, version) && includes(candidate, version))
    ? "widened"
    : "equivalent";
};

test("orders numeric prerelease singleton and lower bounds without rounding", () => {
  const a = "1.0.0-9007199254740992";
  const b = "1.0.0-9007199254740993";
  const cases: ReadonlyArray<readonly [string, string, "narrowed" | "widened" | "equivalent"]> = [
    [a, b, "narrowed"],
    [`>=${a}`, `>=${b}`, "narrowed"],
    [`>=${b}`, `>=${a}`, "widened"],
    [a, a, "equivalent"],
    [a, `${a}.0`, "narrowed"],
    [a, `${b}.0`, "narrowed"],
  ];
  for (const [baseline, candidate, expected] of cases) {
    expect(compareParsedPeerRanges(new Range(baseline), new Range(candidate))).toBe(expected);
  }
});

test("matches exact decimal cell membership across prerelease endpoints and unions", () => {
  const identifiers = [
    "0",
    "9007199254740990",
    "9007199254740991",
    "9007199254740992",
    "9007199254740992.0",
    "9007199254740993",
    "9007199254740993.0",
    "9007199254740994",
    "99999999999999999999",
    "100000000000000000000",
    "a",
    "a.9007199254740992",
    "a.9007199254740993",
    "z".repeat(250),
  ];
  const ranges = [new Range("*"), new Range("<0.0.0"), new Range(">=1.0.0")];
  for (const identifier of identifiers) {
    const version = `1.0.0-${identifier}`;
    for (const operator of ["", "<", "<=", ">", ">="])
      ranges.push(new Range(`${operator}${version}`));
    if (version.length < 254) {
      ranges.push(
        new Range(`${version} || >=${version}.0 <1.0.0`),
        new Range(`${version} || >${version}.0 <1.0.0`),
        new Range(`>${version} <${version}.0`),
      );
    }
  }
  for (const baseline of ranges) {
    for (const candidate of ranges) {
      expect(
        compareParsedPeerRanges(baseline, candidate),
        `${baseline.raw} -> ${candidate.raw}`,
      ).toBe(oracle(baseline, candidate));
    }
  }
});
