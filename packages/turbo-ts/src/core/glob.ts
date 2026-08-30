import { minimatch } from "minimatch";
import { toUnixPath } from "./path.js";

export const matchesGlob = (path: string, pattern: string): boolean =>
  minimatch(
    toUnixPath(path).replace(/^\.\//, ""),
    toUnixPath(pattern).replace(/^\.\//, ""),
    { dot: true },
  );

export const selectByGlobs = (
  values: ReadonlyArray<string>,
  patterns: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const selected = new Set<string>();
  for (const pattern of patterns) {
    const negative = pattern.startsWith("!");
    const matcher = negative ? pattern.slice(1) : pattern;
    for (const value of values) {
      if (!matchesGlob(value, matcher)) {
        continue;
      }
      if (negative) {
        selected.delete(value);
      } else {
        selected.add(value);
      }
    }
  }
  return [...selected].sort();
};
