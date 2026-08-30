import { toUnixPath } from "./path.js";

const escapeRegularExpression = (value: string): string =>
  value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");

export const globToRegularExpression = (pattern: string): RegExp => {
  const normalized = toUnixPath(pattern).replace(/^\.\//, "");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        index += 1;
        if (normalized[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegularExpression(character);
    }
  }
  return new RegExp(`^${source}$`);
};

export const matchesGlob = (path: string, pattern: string): boolean =>
  globToRegularExpression(pattern).test(toUnixPath(path).replace(/^\.\//, ""));

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
