import { GLOBSTAR, Minimatch, minimatch } from "minimatch";
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

const exclusionCoversGlobDescendants = (
  path: string,
  pattern: string,
  windowsPathSeparators: boolean,
): boolean => {
  const matcher = new Minimatch(globValue(pattern, windowsPathSeparators), {
    dot: true,
  });
  const pathParts = globValue(path, windowsPathSeparators).split("/");
  return matcher.set.some((alternative) =>
    alternative.some((_, suffixIndex) => {
      const suffix = alternative.slice(suffixIndex);
      const segmentWildcards = suffix.filter(
        (part) => part instanceof RegExp && part._glob === "*",
      ).length;
      if (
        !suffix.includes(GLOBSTAR) ||
        segmentWildcards > 1 ||
        !suffix.every(
          (part) =>
            part === GLOBSTAR || (part instanceof RegExp && part._glob === "*"),
        )
      ) {
        return false;
      }
      const prefix = alternative.slice(0, suffixIndex);
      return (
        matcher.matchOne(pathParts, prefix) ||
        (suffix[0] === GLOBSTAR &&
          matcher.matchOne(pathParts, [...prefix, GLOBSTAR]))
      );
    }),
  );
};

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
      exclusionCoversGlobDescendants(
        path,
        pattern.slice(1),
        windowsPathSeparators,
      ),
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
