import { normalizePath, parentPath, toUnixPath } from "../core/path.js";

interface ArchiveFileEntry {
  readonly kind?: "file";
  readonly path: string;
  readonly contents: Uint8Array;
  readonly mode: number;
  readonly modifiedSeconds: number;
}

interface ArchiveSymlinkEntry {
  readonly kind: "symlink";
  readonly path: string;
  readonly linkTarget: string;
  readonly contents: Uint8Array;
  readonly mode: number;
  readonly modifiedSeconds: number;
}

interface ArchiveDirectoryEntry {
  readonly kind: "directory";
  readonly path: string;
  readonly mode: number;
  readonly modifiedSeconds: number;
}

export type ArchiveEntry =
  | ArchiveFileEntry
  | ArchiveSymlinkEntry
  | ArchiveDirectoryEntry;

export const tarBlockSize = 512;
export const maximumCacheArchiveInputBytes = 64 * 1024 * 1024;
export const maximumCacheArchiveOverheadBytes = 64 * 1024 * 1024;
const tarNameBytes = 100;
const tarPrefixBytes = 155;
const encodedLength = (value: string): number =>
  new TextEncoder().encode(value).length;

const writeText = (
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void => {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length > length) {
    throw new TypeError(`tar field exceeds ${length} bytes`);
  }
  target.set(encoded, offset);
};

const writeOctal = (
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void => {
  writeText(
    target,
    offset,
    length,
    value.toString(8).padStart(length - 1, "0"),
  );
};

const checksum = (header: Uint8Array): number =>
  header.reduce(
    (total, byte, index) => total + (index >= 148 && index < 156 ? 0x20 : byte),
    0,
  );

const validateArchivePath = (path: string): string => {
  const unix = toUnixPath(path);
  if (
    unix === "" ||
    unix.startsWith("/") ||
    /^[A-Za-z]:/.test(unix) ||
    unix.includes("\0") ||
    unix.split("/").includes("..")
  ) {
    throw new TypeError(`unsafe archive path: ${path}`);
  }
  const normalized = normalizePath(unix);
  if (normalized === "." || normalized.startsWith("../")) {
    throw new TypeError(`unsafe archive path: ${path}`);
  }
  return normalized;
};

const splitArchivePath = (
  path: string,
): { readonly name: string; readonly prefix: string } | undefined => {
  if (encodedLength(path) <= tarNameBytes) {
    return { name: path, prefix: "" };
  }
  for (
    let separator = path.lastIndexOf("/");
    separator > 0;
    separator = path.lastIndexOf("/", separator - 1)
  ) {
    const prefix = path.slice(0, separator);
    const name = path.slice(separator + 1);
    if (
      encodedLength(prefix) <= tarPrefixBytes &&
      encodedLength(name) <= tarNameBytes
    ) {
      return { name, prefix };
    }
  }
  return undefined;
};

const validateArchiveLinkTarget = (path: string, target: string): string => {
  const unix = toUnixPath(target);
  if (
    unix === "" ||
    unix.startsWith("/") ||
    /^[A-Za-z]:/.test(unix) ||
    unix.includes("\0")
  ) {
    throw new TypeError(`unsafe archive link target: ${target}`);
  }
  const resolved = normalizePath(`${parentPath(path)}/${unix}`);
  if (resolved === ".." || resolved.startsWith("../")) {
    throw new TypeError(`archive link target escapes repository: ${target}`);
  }
  return unix;
};

const createHeader = (
  path: string,
  type: number,
  size: number,
  mode: number,
  modifiedSeconds: number,
  linkTarget = "",
): Uint8Array => {
  const pathFields = splitArchivePath(path);
  if (pathFields === undefined) {
    throw new TypeError("internal tar header path exceeds the ustar limit");
  }
  const header = new Uint8Array(tarBlockSize);
  writeText(header, 0, tarNameBytes, pathFields.name);
  writeOctal(header, 100, 8, mode & 0o777);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.max(0, Math.floor(modifiedSeconds)));
  header[156] = type;
  if (linkTarget !== "") writeText(header, 157, tarNameBytes, linkTarget);
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);
  writeText(header, 345, tarPrefixBytes, pathFields.prefix);
  writeText(header, 148, 6, checksum(header).toString(8).padStart(6, "0"));
  header[154] = 0;
  header[155] = 0x20;
  return header;
};

const paxRecord = (key: "linkpath" | "path", value: string): Uint8Array => {
  let length = encodedLength(` ${key}=${value}\n`) + 1;
  while (true) {
    const record = `${length} ${key}=${value}\n`;
    const actual = encodedLength(record);
    if (actual === length) return new TextEncoder().encode(record);
    length = actual;
  }
};

const paxContents = (
  values: Readonly<{ readonly path?: string; readonly linkpath?: string }>,
): Uint8Array => {
  const records = [
    ...(values.path === undefined ? [] : [paxRecord("path", values.path)]),
    ...(values.linkpath === undefined
      ? []
      : [paxRecord("linkpath", values.linkpath)]),
  ];
  const contents = new Uint8Array(
    records.reduce((size, record) => size + record.length, 0),
  );
  let offset = 0;
  for (const record of records) {
    contents.set(record, offset);
    offset += record.length;
  }
  return contents;
};

const pushArchiveRecord = (
  chunks: Array<Uint8Array>,
  header: Uint8Array,
  contents: Uint8Array,
): void => {
  chunks.push(header, contents);
  const padding =
    (tarBlockSize - (contents.length % tarBlockSize)) % tarBlockSize;
  if (padding > 0) chunks.push(new Uint8Array(padding));
};

const archiveRecordBytes = (contentsLength: number): number =>
  tarBlockSize + Math.ceil(contentsLength / tarBlockSize) * tarBlockSize;

interface PreparedArchiveEntry {
  readonly entry: ArchiveEntry;
  readonly path: string;
  readonly pathFields:
    | { readonly name: string; readonly prefix: string }
    | undefined;
  readonly symlink: boolean;
  readonly directory: boolean;
  readonly contents: Uint8Array;
  readonly linkTarget: string;
  readonly extensions: {
    readonly path?: string;
    readonly linkpath?: string;
  };
}

export const createTarArchive = (
  entries: ReadonlyArray<ArchiveEntry>,
): Uint8Array => {
  const preparedEntries: Array<PreparedArchiveEntry> = [];
  let inputBytes = 0;
  let overheadBytes = tarBlockSize * 2;
  for (const entry of entries) {
    const path = validateArchivePath(entry.path);
    const pathFields = splitArchivePath(path);
    const symlink = entry.kind === "symlink";
    const directory = entry.kind === "directory";
    const contents = symlink || directory ? new Uint8Array() : entry.contents;
    const linkTarget = symlink
      ? validateArchiveLinkTarget(path, entry.linkTarget)
      : "";
    const extensions = {
      ...(pathFields === undefined ? { path } : {}),
      ...(encodedLength(linkTarget) > tarNameBytes
        ? { linkpath: linkTarget }
        : {}),
    };
    const extendedContentsBytes =
      extensions.path === undefined && extensions.linkpath === undefined
        ? 0
        : paxContents(extensions).length;
    inputBytes += contents.length;
    overheadBytes +=
      archiveRecordBytes(contents.length) -
      contents.length +
      (extendedContentsBytes === 0
        ? 0
        : archiveRecordBytes(extendedContentsBytes));
    if (inputBytes > maximumCacheArchiveInputBytes) {
      throw new TypeError(
        `cache archive input exceeds the ${maximumCacheArchiveInputBytes} byte limit`,
      );
    }
    if (overheadBytes > maximumCacheArchiveOverheadBytes) {
      throw new TypeError(
        `cache archive overhead exceeds the ${maximumCacheArchiveOverheadBytes} byte limit`,
      );
    }
    preparedEntries.push({
      entry,
      path,
      pathFields,
      symlink,
      directory,
      contents,
      linkTarget,
      extensions,
    });
  }
  const chunks: Array<Uint8Array> = [];
  const sorted = preparedEntries.sort((left, right) =>
    left.entry.path.localeCompare(right.entry.path),
  );
  for (const [index, prepared] of sorted.entries()) {
    const {
      entry,
      path,
      pathFields,
      symlink,
      directory,
      contents,
      linkTarget,
      extensions,
    } = prepared;
    if (extensions.path !== undefined || extensions.linkpath !== undefined) {
      const extendedContents = paxContents(extensions);
      pushArchiveRecord(
        chunks,
        createHeader(
          `PaxHeaders/${index}`,
          0x78,
          extendedContents.length,
          0o644,
          0,
        ),
        extendedContents,
      );
    }
    const storedPath = pathFields === undefined ? `PaxEntries/${index}` : path;
    const storedLinkTarget =
      encodedLength(linkTarget) > tarNameBytes ? "" : linkTarget;
    pushArchiveRecord(
      chunks,
      createHeader(
        storedPath,
        symlink ? 0x32 : directory ? 0x35 : 0x30,
        contents.length,
        entry.mode,
        entry.modifiedSeconds,
        storedLinkTarget,
      ),
      contents,
    );
  }
  chunks.push(new Uint8Array(tarBlockSize * 2));
  const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }
  return archive;
};

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const readText = (
  source: Uint8Array,
  offset: number,
  length: number,
): string => {
  const field = source.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return utf8Decoder.decode(end === -1 ? field : field.subarray(0, end));
};

const readOctal = (
  source: Uint8Array,
  offset: number,
  length: number,
): number => {
  const text = readText(source, offset, length).trim();
  const value = text === "" ? 0 : Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("invalid tar numeric field");
  }
  return value;
};

export interface PaxValues {
  readonly path?: string;
  readonly linkpath?: string;
}

export const parsePaxContents = (contents: Uint8Array): PaxValues => {
  const values: { path?: string; linkpath?: string } = {};
  let offset = 0;
  while (offset < contents.length) {
    let separator = offset;
    while (separator < contents.length && contents[separator] !== 0x20) {
      separator += 1;
    }
    if (separator === offset || separator >= contents.length) {
      throw new TypeError("invalid PAX record length");
    }
    const lengthText = utf8Decoder.decode(contents.subarray(offset, separator));
    if (!/^\d+$/.test(lengthText)) {
      throw new TypeError("invalid PAX record length");
    }
    const length = Number.parseInt(lengthText, 10);
    const end = offset + length;
    if (
      !Number.isSafeInteger(length) ||
      length <= separator - offset + 3 ||
      end > contents.length ||
      contents[end - 1] !== 0x0a
    ) {
      throw new TypeError("invalid PAX record boundary");
    }
    const body = contents.subarray(separator + 1, end - 1);
    const equals = body.indexOf(0x3d);
    if (equals <= 0) throw new TypeError("invalid PAX record");
    const key = utf8Decoder.decode(body.subarray(0, equals));
    const value = utf8Decoder.decode(body.subarray(equals + 1));
    if (key === "path" || key === "linkpath") values[key] = value;
    offset = end;
  }
  return values;
};

export interface ParsedTarHeader {
  readonly headerPath: string;
  readonly type: number;
  readonly size: number;
  readonly mode: number;
  readonly modifiedSeconds: number;
  readonly linkTarget: string;
}

export const parseTarHeader = (header: Uint8Array): ParsedTarHeader => {
  if (header.length !== tarBlockSize) {
    throw new TypeError("truncated tar header");
  }
  const expectedChecksum = readOctal(header, 148, 8);
  if (checksum(header) !== expectedChecksum) {
    throw new TypeError("invalid tar checksum");
  }
  const name = readText(header, 0, tarNameBytes);
  const prefix =
    readText(header, 257, 6) === "ustar" && readText(header, 263, 2) === "00"
      ? readText(header, 345, tarPrefixBytes)
      : "";
  const type = header[156] ?? 0;
  if (
    type !== 0 &&
    type !== 0x30 &&
    type !== 0x32 &&
    type !== 0x35 &&
    type !== 0x78
  ) {
    throw new TypeError(
      `unsupported tar entry type: ${String.fromCharCode(type)}`,
    );
  }
  return {
    headerPath: validateArchivePath(prefix === "" ? name : `${prefix}/${name}`),
    type,
    size: readOctal(header, 124, 12),
    mode: readOctal(header, 100, 8),
    modifiedSeconds: readOctal(header, 136, 12),
    linkTarget: readText(header, 157, tarNameBytes),
  };
};

export const resolveArchivePath = (
  headerPath: string,
  extendedPath: string | undefined,
): string => validateArchivePath(extendedPath ?? headerPath);

export const resolveArchiveLinkTarget = (
  path: string,
  headerTarget: string,
  extendedTarget: string | undefined,
): string => validateArchiveLinkTarget(path, extendedTarget ?? headerTarget);

export const parseTarArchive = (
  archive: Uint8Array,
): ReadonlyArray<ArchiveEntry> => {
  const entries: Array<ArchiveEntry> = [];
  let extended: PaxValues | undefined;
  let offset = 0;
  while (offset + tarBlockSize <= archive.length) {
    const header = archive.subarray(offset, offset + tarBlockSize);
    if (header.every((byte) => byte === 0)) {
      if (extended !== undefined) {
        throw new TypeError("PAX header is missing its archive entry");
      }
      return entries;
    }
    const parsed = parseTarHeader(header);
    const { type, size } = parsed;
    const start = offset + tarBlockSize;
    const end = start + size;
    if (end > archive.length) {
      throw new TypeError("truncated tar entry");
    }
    const contents = archive.slice(start, end);
    if (type === 0x78) {
      extended = { ...extended, ...parsePaxContents(contents) };
      offset = start + Math.ceil(size / tarBlockSize) * tarBlockSize;
      continue;
    }
    const path = resolveArchivePath(parsed.headerPath, extended?.path);
    if (extended?.linkpath !== undefined && type !== 0x32) {
      throw new TypeError("PAX linkpath applies to a non-symlink entry");
    }
    if (type === 0x35 && size !== 0) {
      throw new TypeError("tar directory entry has contents");
    }
    const common = {
      path,
      mode: parsed.mode,
      modifiedSeconds: parsed.modifiedSeconds,
    };
    entries.push(
      type === 0x32
        ? {
            ...common,
            kind: "symlink",
            contents,
            linkTarget: resolveArchiveLinkTarget(
              path,
              parsed.linkTarget,
              extended?.linkpath,
            ),
          }
        : type === 0x35
          ? { ...common, kind: "directory" }
          : { ...common, contents },
    );
    extended = undefined;
    offset = start + Math.ceil(size / tarBlockSize) * tarBlockSize;
  }
  throw new TypeError("tar archive is missing its end marker");
};
