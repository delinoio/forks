export const toUnixPath = (value: string): string =>
  value.replaceAll("\\", "/");

const uncPath = (value: string): RegExpExecArray | null =>
  /^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(value);

export const isAbsolutePath = (value: string): boolean => {
  const unix = toUnixPath(value);
  return unix.startsWith("/") || /^[A-Za-z]:\//.test(unix);
};

export const normalizePath = (value: string): string => {
  const unix = toUnixPath(value);
  const unc = uncPath(unix);
  const drive = /^[A-Za-z]:/.exec(unix)?.[0] ?? "";
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

export const joinPath = (...values: ReadonlyArray<string>): string =>
  normalizePath(values.filter((value) => value !== "").join("/"));

export const parentPath = (value: string): string => {
  const normalized = normalizePath(value);
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

export const baseName = (value: string): string => {
  const normalized = normalizePath(value);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
};

export const relativePath = (root: string, value: string): string => {
  const normalizedRoot = normalizePath(root).replace(/\/$/, "");
  const normalizedValue = normalizePath(value);
  return normalizedValue === normalizedRoot
    ? "."
    : normalizedValue.startsWith(`${normalizedRoot}/`)
      ? normalizedValue.slice(normalizedRoot.length + 1)
      : normalizedValue;
};

export const isPathContained = (root: string, value: string): boolean => {
  const normalizedRoot = normalizePath(root).replace(/\/$/, "");
  const normalizedValue = normalizePath(value);
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
