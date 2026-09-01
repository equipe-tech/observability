export const encodeCompatibilityJson = <Value>(value: Value): string =>
  `${JSON.stringify(value, null, 2)}\n`.replace(
    /\[\n((?:\s+(?:"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false),?\n)+)\s*\]/g,
    (_array, entries: string) => {
      const values = entries
        .trim()
        .split(/,?\n\s*/)
        .map((entry) => entry.trim());
      const compact = `[${values.join(", ")}]`;
      return compact.length <= 80 ? compact : _array;
    },
  );
