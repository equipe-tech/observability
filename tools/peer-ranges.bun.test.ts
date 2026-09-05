import { describe, expect, test } from "bun:test";
import { satisfies } from "semver";
import { comparePeerRanges, type PeerRangeComparison } from "../scripts/compatibility-gate.ts";

const relations: ReadonlyArray<readonly [string, string, PeerRangeComparison["classification"]]> = [
  [">=1 <3", ">=1 <2 || >=2 <3", "equivalent"],
  [">=1 <3", ">=1 <2 || >=2 <4", "widened"],
  [">=1 <3", ">=1 <2 || >=2.1 <3", "narrowed"],
  [">=1 <3", ">=1 <=2 || >2 <3", "equivalent"],
  [">=1 <3", ">=1 <2.1 || >=2 <3", "equivalent"],
  [">=1 <3", ">=1 <2.0.0 || >2.0.0 <3", "narrowed"],
  ["<1.2.0", "<1.2", "equivalent"],
  ["<1.2", "<1.2.0", "equivalent"],
  ["<0.0", "<0.0.0", "equivalent"],
  [">1 <1", "<0.0", "equivalent"],
  ["<0.0", "0.0.0", "widened"],
  ["0.0.0", "<0.0", "narrowed"],
  ["*", ">=0.0.0", "equivalent"],
  ["*", ">=0.0.0-0", "widened"],
  ["<1.2.0-beta", "<1.2.0", "narrowed"],
  [">=1.2.0-beta <1.2.0", "<0.0", "narrowed"],
  [">=1.2.0-beta <1.2.0", ">=1.2.0-beta <1.2", "narrowed"],
  [">=1.2.0-beta <1.2.0", ">=1.2.0-beta <1.2.0-0", "narrowed"],
  [">=1.2.0-beta <1.2.0", ">=1.2.0-beta <1.2.0-beta.0 || >=1.2.0-beta.0 <1.2.0", "equivalent"],
  [">=1.2.0-beta <1.2.0", ">=1.2.0-beta <1.2.0-beta.0 || >1.2.0-beta.0 <1.2.0", "narrowed"],
  [">1.2.0-beta <1.2.0-beta.0", "<0.0", "equivalent"],
  [">=1.2.0-beta <1.2.0-beta.0", "1.2.0-beta", "equivalent"],
  [">1.2.0-beta <=1.2.0-beta.0", "1.2.0-beta.0", "equivalent"],
  [">1.2.0-0 <1.2.0-0.0", "<0.0", "equivalent"],
  [">=1.2.0-0 <1.2.0-0.0", "1.2.0-0", "equivalent"],
  [">=1.0.0-alpha <3", ">=1.0.0-alpha <2 || >=2 <3", "equivalent"],
  [">=1.0.0-alpha <3", ">=1 <2 || >=2.0.0-alpha <3", "narrowed"],
  [">=1 <3", ">=1 <2 || >=2.0.0-alpha <3", "widened"],
  [">=1.0.0-alpha <2.0.0-beta", ">=1.0.0-alpha <2 || >=2.0.0-0 <2.0.0-beta", "equivalent"],
  [">=1.0.0-alpha <2", ">=1.0.0-alpha <2 || 1.1.0-beta", "widened"],
  [">=1.0.0-alpha <2", ">=1.0.0-alpha <2 || >=1.1.0-beta <1.1.0-beta", "equivalent"],
  ["<0.0", ">=2.0.0-alpha <1.0.0-beta", "equivalent"],
  ["1.2.0-alpha+one", "1.2.0-alpha+two", "equivalent"],
  ["<=0.0", "<=0.0.0", "narrowed"],
  [">0.0", ">0.0.0", "widened"],
  ["=0.0", "=0.0.0", "narrowed"],
  ["0.0 - 0.0", "0.0.0 - 0.0.0", "narrowed"],
  ["^0.0", "^0.0.0", "narrowed"],
  ["~0.0", "~0.0.0", "equivalent"],
];

const versions = Array.from({ length: 5 }, (_, major) =>
  Array.from({ length: 4 }, (_, minor) =>
    Array.from({ length: 5 }, (_, patch) =>
      [
        "",
        "-0",
        "-0.0",
        "-alpha",
        "-alpha.0",
        "-beta",
        "-beta.0",
        "-beta.0.0",
        "-rc.1",
        "+build",
      ].map((suffix) => `${major}.${minor}.${patch}${suffix}`),
    ).flat(),
  ).flat(),
).flat();

describe("peer range set coverage", () => {
  test.each(relations)("relates %s to %s as %s", (baseline, candidate, classification) => {
    expect(comparePeerRanges(baseline, candidate).classification).toBe(classification);
    let removed = false;
    let added = false;
    for (const version of versions) {
      const previous = satisfies(version, baseline);
      const next = satisfies(version, candidate);
      expect(Bun.semver.satisfies(version, baseline)).toBe(previous);
      expect(Bun.semver.satisfies(version, candidate)).toBe(next);
      removed ||= previous && !next;
      added ||= !previous && next;
    }
    expect(removed ? "narrowed" : added ? "widened" : "equivalent").toBe(classification);
    if (classification === "equivalent") {
      expect(comparePeerRanges(candidate, baseline).classification).toBe("equivalent");
    }
    if (classification === "widened") {
      expect(comparePeerRanges(candidate, baseline).classification).toBe("narrowed");
    }
  });

  test("preserves coverage under union order, duplication, empty arms and repeated splitting", () => {
    for (let lower = 0; lower < 4; lower++) {
      for (let upper = lower + 2; upper < 7; upper++) {
        const merged = `>=${lower} <${upper}`;
        const arms = Array.from(
          { length: upper - lower },
          (_, offset) => `>=${lower + offset} <${lower + offset + 1}`,
        );
        for (const split of [
          arms.join(" || "),
          arms.toReversed().join(" || "),
          [...arms, ...arms, "<0.0"].join(" || "),
        ]) {
          expect(comparePeerRanges(merged, split).classification).toBe("equivalent");
          expect(comparePeerRanges(split, merged).classification).toBe("equivalent");
          expect(comparePeerRanges(split, `${merged} || ${upper}.0.0`).classification).toBe(
            "widened",
          );
        }
      }
    }
  });

  test("preserves explicit prerelease coverage under symbolic splits", () => {
    for (const core of ["0.0.0", "1.2.3", "200.400.600"]) {
      for (const identifier of ["0", "alpha", "alpha.0", "9999999999999999999999999", "z"]) {
        const start = `${core}-${identifier}`;
        const split = `${start}.0`;
        expect(
          comparePeerRanges(`>=${start} <${core}`, `${start} || >=${split} <${core}`)
            .classification,
        ).toBe("equivalent");
        expect(comparePeerRanges(`>${start} <${split}`, "<0.0").classification).toBe("equivalent");
      }
    }
  });

  test("handles stable successor boundaries without floating point loss", () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    expect(comparePeerRanges(`>1.2.${maximum}`, ">=1.3.0").classification).toBe("equivalent");
    expect(comparePeerRanges(`>1.${maximum}.${maximum}`, ">=2.0.0").classification).toBe(
      "equivalent",
    );
    expect(comparePeerRanges(`>${maximum}.${maximum}.${maximum}`, "<0.0").classification).toBe(
      "equivalent",
    );
    expect(comparePeerRanges(`<=1.2.${maximum}`, "<1.3.0").classification).toBe("equivalent");
  });
});
