import { minimatch } from "minimatch";
import { toUnixPath } from "./path.js";

const globValue = (value: string, windowsPathSeparators: boolean): string =>
  (windowsPathSeparators ? toUnixPath(value) : value).replace(/^\.\//, "");

export const matchesGlob = (
  path: string,
  pattern: string,
  windowsPathSeparators = false,
): boolean =>
  minimatch(
    globValue(path, windowsPathSeparators),
    globValue(pattern, windowsPathSeparators),
    { dot: true },
  );

export const canMatchGlobDescendant = (
  path: string,
  pattern: string,
  windowsPathSeparators = false,
): boolean =>
  minimatch(
    globValue(path, windowsPathSeparators),
    globValue(pattern, windowsPathSeparators),
    { dot: true, partial: true },
  );

export const canMatchGlobsDescendantWithExclusions = (
  path: string,
  patterns: ReadonlyArray<string>,
  windowsPathSeparators = false,
): boolean =>
  patterns.some(
    (pattern) =>
      !pattern.startsWith("!") &&
      canMatchGlobDescendant(path, pattern, windowsPathSeparators),
  ) &&
  !patterns.some(
    (pattern) =>
      pattern.startsWith("!") &&
      (matchesGlob(path, pattern.slice(1), windowsPathSeparators) ||
        matchesGlob(`${path}/`, pattern.slice(1), windowsPathSeparators)),
  );

export const selectByGlobs = (
  values: ReadonlyArray<string>,
  patterns: ReadonlyArray<string>,
  windowsPathSeparators = false,
): ReadonlyArray<string> => {
  const selected = new Set<string>();
  for (const pattern of patterns) {
    const negative = pattern.startsWith("!");
    const matcher = negative ? pattern.slice(1) : pattern;
    for (const value of values) {
      if (!matchesGlob(value, matcher, windowsPathSeparators)) {
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

export const matchesGlobsWithExclusions = (
  values: ReadonlyArray<string>,
  patterns: ReadonlyArray<string>,
  windowsPathSeparators = false,
): boolean =>
  patterns.some(
    (pattern) =>
      !pattern.startsWith("!") &&
      values.some((value) =>
        matchesGlob(value, pattern, windowsPathSeparators),
      ),
  ) &&
  !patterns.some(
    (pattern) =>
      pattern.startsWith("!") &&
      values.some((value) =>
        matchesGlob(value, pattern.slice(1), windowsPathSeparators),
      ),
  );
