import { type Comparator, type Range, type SemVer } from "semver";

type Interval<Point> = {
  readonly start: Point;
  readonly end: Point;
};
type Prerelease = ReadonlyArray<string | number>;
type PeerCoverage = {
  readonly stable: ReadonlyArray<Interval<bigint>>;
  readonly prereleases: ReadonlyMap<bigint, ReadonlyArray<Interval<Prerelease>>>;
};
type Order<Point> = (left: Point, right: Point) => number;

const componentCardinality = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
const stableEnd = componentCardinality ** 3n;
const coreOrdinal = (version: SemVer): bigint =>
  (BigInt(version.major) * componentCardinality + BigInt(version.minor)) * componentCardinality +
  BigInt(version.patch);
const compareStable: Order<bigint> = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const comparePrerelease: Order<Prerelease> = (left, right) => {
  if (left.length === 0 || right.length === 0)
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  for (const [index, identifier] of left.entries()) {
    const other = right[index];
    if (other === undefined) return 1;
    const a = String(identifier);
    const b = String(other);
    const numericA = /^[0-9]+$/.test(a);
    const numericB = /^[0-9]+$/.test(b);
    const comparison =
      numericA && numericB
        ? compareStable(BigInt(a), BigInt(b))
        : numericA !== numericB
          ? numericA
            ? -1
            : 1
          : a < b
            ? -1
            : a > b
              ? 1
              : 0;
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
};

const intersect = <Point>(
  left: Interval<Point>,
  right: Interval<Point>,
  compare: Order<Point>,
): Interval<Point> => ({
  start: compare(left.start, right.start) >= 0 ? left.start : right.start,
  end: compare(left.end, right.end) <= 0 ? left.end : right.end,
});

const comparatorInterval = <Point>(
  operator: Comparator["operator"],
  lower: Point,
  upper: Point,
  domain: Interval<Point>,
): Interval<Point> => ({
  start: operator === "<" || operator === "<=" ? domain.start : lower,
  end: operator === ">" || operator === ">=" ? domain.end : upper,
});

const stableProjection = (comparators: ReadonlyArray<Comparator>): Interval<bigint> => {
  const domain = { start: 0n, end: stableEnd };
  let interval = domain;
  for (const comparator of comparators) {
    if (comparator.value === "") continue;
    const core = coreOrdinal(comparator.semver);
    const prerelease = comparator.semver.prerelease.length > 0;
    const lower = core + (comparator.operator === ">" && !prerelease ? 1n : 0n);
    const upper = core + (comparator.operator === "<" || prerelease ? 0n : 1n);
    interval = intersect(
      interval,
      comparatorInterval(comparator.operator, lower, upper, domain),
      compareStable,
    );
  }
  return interval;
};

const prereleaseProjection = (
  comparators: ReadonlyArray<Comparator>,
  core: bigint,
): Interval<Prerelease> => {
  const domain: Interval<Prerelease> = { start: [0], end: [] };
  let interval = domain;
  for (const comparator of comparators) {
    if (comparator.value === "") continue;
    const boundCore = coreOrdinal(comparator.semver);
    const identifiers = comparator.semver.prerelease;
    let lower: Prerelease;
    let upper: Prerelease;
    if (core !== boundCore || identifiers.length === 0) {
      const below = core < boundCore || (core === boundCore && identifiers.length === 0);
      lower = below ? domain.end : domain.start;
      upper = lower;
    } else {
      lower = comparator.operator === ">" ? [...identifiers, 0] : identifiers;
      upper = comparator.operator === "<" ? identifiers : [...identifiers, 0];
    }
    interval = intersect(
      interval,
      comparatorInterval(comparator.operator, lower, upper, domain),
      comparePrerelease,
    );
  }
  return interval;
};

const mergeIntervals = <Point>(
  intervals: ReadonlyArray<Interval<Point>>,
  compare: Order<Point>,
): ReadonlyArray<Interval<Point>> => {
  const ordered = intervals
    .filter((interval) => compare(interval.start, interval.end) < 0)
    .toSorted((left, right) => compare(left.start, right.start));
  const merged: Array<Interval<Point>> = [];
  for (const interval of ordered) {
    const previous = merged.at(-1);
    if (previous === undefined || compare(previous.end, interval.start) < 0) {
      merged.push(interval);
    } else if (compare(previous.end, interval.end) < 0) {
      merged[merged.length - 1] = { start: previous.start, end: interval.end };
    }
  }
  return merged;
};

const rangeCoverage = (range: Range): PeerCoverage => {
  const stable: Array<Interval<bigint>> = [];
  const prereleases = new Map<bigint, Array<Interval<Prerelease>>>();
  for (const comparators of range.set) {
    stable.push(stableProjection(comparators));
    const cores = new Set(
      comparators
        .filter((comparator) => comparator.value !== "" && comparator.semver.prerelease.length > 0)
        .map((comparator) => coreOrdinal(comparator.semver)),
    );
    for (const core of cores) {
      const intervals = prereleases.get(core) ?? [];
      intervals.push(prereleaseProjection(comparators, core));
      prereleases.set(core, intervals);
    }
  }
  return {
    stable: mergeIntervals(stable, compareStable),
    prereleases: new Map(
      [...prereleases].map(([core, intervals]) => [
        core,
        mergeIntervals(intervals, comparePrerelease),
      ]),
    ),
  };
};

const intervalsCovered = <Point>(
  source: ReadonlyArray<Interval<Point>>,
  target: ReadonlyArray<Interval<Point>>,
  compare: Order<Point>,
): boolean =>
  source.every((interval) =>
    target.some(
      (cover) => compare(cover.start, interval.start) <= 0 && compare(cover.end, interval.end) >= 0,
    ),
  );

const coverageContains = (target: PeerCoverage, source: PeerCoverage): boolean =>
  intervalsCovered(source.stable, target.stable, compareStable) &&
  [...source.prereleases].every(([core, intervals]) =>
    intervalsCovered(intervals, target.prereleases.get(core) ?? [], comparePrerelease),
  );

export const compareParsedPeerRanges = (
  baseline: Range,
  candidate: Range,
): "equivalent" | "widened" | "narrowed" => {
  const previous = rangeCoverage(baseline);
  const next = rangeCoverage(candidate);
  if (!coverageContains(next, previous)) return "narrowed";
  return coverageContains(previous, next) ? "equivalent" : "widened";
};
