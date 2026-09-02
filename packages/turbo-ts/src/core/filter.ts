export interface ParsedPackageFilter {
  readonly negative: boolean;
  readonly includeDependents: boolean;
  readonly includeDependencies: boolean;
  readonly packageSelector?: string;
  readonly directorySelector?: string;
  readonly gitRangeSelector?: string;
}

export const parsePackageFilter = (rawFilter: string): ParsedPackageFilter => {
  const negative = rawFilter.startsWith("!");
  let selector = negative ? rawFilter.slice(1) : rawFilter;
  const includeDependents = selector.startsWith("...");
  if (includeDependents) selector = selector.slice(3);

  let includeDependencies = selector.endsWith("...");
  if (includeDependencies) selector = selector.slice(0, -3);

  let gitRangeSelector: string | undefined;
  if (selector.endsWith("]")) {
    const start = selector.lastIndexOf("[");
    if (start !== -1) {
      gitRangeSelector = selector.slice(start + 1, -1);
      selector = selector.slice(0, start);
    }
  }

  if (selector.endsWith("...")) {
    includeDependencies = true;
    selector = selector.slice(0, -3);
  }

  let directorySelector: string | undefined;
  if (selector.endsWith("}")) {
    const start = selector.lastIndexOf("{");
    if (start !== -1) {
      directorySelector = selector.slice(start + 1, -1);
      selector = selector.slice(0, start);
    }
  }

  return {
    negative,
    includeDependents,
    includeDependencies,
    ...(selector === "" ? {} : { packageSelector: selector }),
    ...(directorySelector === undefined ? {} : { directorySelector }),
    ...(gitRangeSelector === undefined ? {} : { gitRangeSelector }),
  };
};
