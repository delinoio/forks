export const toUnixPath = (value: string): string =>
  value.replaceAll("\\", "/");

const nativeWindowsPathSeparators = process.platform === "win32";

const uncPath = (value: string): RegExpExecArray | null =>
  /^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(value);

export const isAbsolutePath = (
  value: string,
  windowsPathSeparators = nativeWindowsPathSeparators,
): boolean => {
  const normalized = windowsPathSeparators ? toUnixPath(value) : value;
  return (
    normalized.startsWith("/") ||
    (windowsPathSeparators && /^[A-Za-z]:\//.test(normalized))
  );
};

export const normalizePath = (
  value: string,
  windowsPathSeparators = nativeWindowsPathSeparators,
): string => {
  const unix = windowsPathSeparators ? toUnixPath(value) : value;
  const unc = windowsPathSeparators ? uncPath(unix) : null;
  const drive = windowsPathSeparators
    ? (/^[A-Za-z]:/.exec(unix)?.[0] ?? "")
    : "";
  const absolute = unc !== null || unix.startsWith("/") || drive !== "";
  const start =
    unc !== null
      ? (unc[3] ?? "")
      : drive === ""
        ? unix
        : unix.slice(drive.length);
  const segments: Array<string> = [];
  for (const segment of start.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") {
        segments.pop();
      } else if (!absolute) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }
  const prefix =
    unc !== null
      ? `//${unc[1]}/${unc[2]}${segments.length === 0 ? "" : "/"}`
      : drive !== ""
        ? `${drive}/`
        : absolute
          ? "/"
          : "";
  return `${prefix}${segments.join("/")}` || (absolute ? prefix : ".");
};

export const joinPathWithSeparators = (
  windowsPathSeparators: boolean,
  ...values: ReadonlyArray<string>
): string =>
  normalizePath(
    values.filter((value) => value !== "").join("/"),
    windowsPathSeparators,
  );

export const joinPath = (...values: ReadonlyArray<string>): string =>
  joinPathWithSeparators(nativeWindowsPathSeparators, ...values);

export const parentPath = (
  value: string,
  windowsPathSeparators = nativeWindowsPathSeparators,
): string => {
  const normalized = normalizePath(value, windowsPathSeparators);
  const uncRoot = /^\/\/[^/]+\/[^/]+/.exec(normalized)?.[0];
  if (uncRoot !== undefined && normalized.length <= uncRoot.length) {
    return uncRoot;
  }
  const index = normalized.lastIndexOf("/");
  if (uncRoot !== undefined && index <= uncRoot.length) {
    return uncRoot;
  }
  if (index <= 0) {
    return normalized.startsWith("/") ? "/" : ".";
  }
  return normalized.slice(0, index);
};

export const baseName = (
  value: string,
  windowsPathSeparators = nativeWindowsPathSeparators,
): string => {
  const normalized = normalizePath(value, windowsPathSeparators);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
};

export const relativePath = (
  root: string,
  value: string,
  windowsPathSeparators = nativeWindowsPathSeparators,
): string => {
  const normalizedRoot = normalizePath(root, windowsPathSeparators).replace(
    /\/$/,
    "",
  );
  const normalizedValue = normalizePath(value, windowsPathSeparators);
  return normalizedValue === normalizedRoot
    ? "."
    : normalizedValue.startsWith(`${normalizedRoot}/`)
      ? normalizedValue.slice(normalizedRoot.length + 1)
      : normalizedValue;
};

const normalizedPathRoot = (
  value: string,
  windowsPathSeparators: boolean,
): string => {
  if (windowsPathSeparators) {
    const uncRoot = /^\/\/[^/]+\/[^/]+/.exec(value)?.[0];
    if (uncRoot !== undefined) return uncRoot;
    const driveRoot = /^[A-Za-z]:\//.exec(value)?.[0];
    if (driveRoot !== undefined) return driveRoot;
  }
  return value.startsWith("/") ? "/" : "";
};

export const relativePathBetween = (
  directory: string,
  value: string,
  windowsPathSeparators = nativeWindowsPathSeparators,
): string => {
  const normalizedDirectory = normalizePath(directory, windowsPathSeparators);
  const normalizedValue = normalizePath(value, windowsPathSeparators);
  const directoryRoot = normalizedPathRoot(
    normalizedDirectory,
    windowsPathSeparators,
  );
  const valueRoot = normalizedPathRoot(normalizedValue, windowsPathSeparators);
  const comparable = (path: string): string =>
    windowsPathSeparators ? path.toLowerCase() : path;
  if (comparable(directoryRoot) !== comparable(valueRoot)) {
    return normalizedValue;
  }
  const segmentsAfterRoot = (
    path: string,
    root: string,
  ): ReadonlyArray<string> =>
    path
      .slice(root.length)
      .replace(/^\//, "")
      .split("/")
      .filter((segment) => segment !== "");
  const directorySegments = segmentsAfterRoot(
    normalizedDirectory,
    directoryRoot,
  );
  const valueSegments = segmentsAfterRoot(normalizedValue, valueRoot);
  let commonSegments = 0;
  while (
    commonSegments < directorySegments.length &&
    commonSegments < valueSegments.length &&
    comparable(directorySegments[commonSegments]!) ===
      comparable(valueSegments[commonSegments]!)
  ) {
    commonSegments += 1;
  }
  const relative = [
    ...Array.from(
      { length: directorySegments.length - commonSegments },
      () => "..",
    ),
    ...valueSegments.slice(commonSegments),
  ].join("/");
  return relative === "" ? "." : relative;
};

export const isPathContained = (
  root: string,
  value: string,
  windowsPathSeparators = nativeWindowsPathSeparators,
): boolean => {
  const normalizedRoot = normalizePath(root, windowsPathSeparators).replace(
    /\/$/,
    "",
  );
  const normalizedValue = normalizePath(value, windowsPathSeparators);
  const caseInsensitive =
    /^[A-Za-z]:/.test(normalizedRoot) || normalizedRoot.startsWith("//");
  const comparisonRoot = caseInsensitive
    ? normalizedRoot.toLowerCase()
    : normalizedRoot;
  const comparisonValue = caseInsensitive
    ? normalizedValue.toLowerCase()
    : normalizedValue;
  return (
    comparisonValue === comparisonRoot ||
    comparisonValue.startsWith(`${comparisonRoot}/`)
  );
};
