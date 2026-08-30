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

export type ArchiveEntry = ArchiveFileEntry | ArchiveSymlinkEntry;

const blockSize = 512;
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
): { readonly name: string; readonly prefix: string } => {
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
  throw new TypeError("tar path exceeds the ustar path limit");
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
  if (encodedLength(unix) > tarNameBytes) {
    throw new TypeError("tar link target exceeds the ustar link limit");
  }
  return unix;
};

export const createTarArchive = (
  entries: ReadonlyArray<ArchiveEntry>,
): Uint8Array => {
  const chunks: Array<Uint8Array> = [];
  for (const entry of [...entries].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    const path = validateArchivePath(entry.path);
    const pathFields = splitArchivePath(path);
    const header = new Uint8Array(blockSize);
    writeText(header, 0, tarNameBytes, pathFields.name);
    writeOctal(header, 100, 8, entry.mode & 0o777);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    const symlink = entry.kind === "symlink";
    const contents = symlink ? new Uint8Array() : entry.contents;
    writeOctal(header, 124, 12, contents.length);
    writeOctal(header, 136, 12, Math.max(0, Math.floor(entry.modifiedSeconds)));
    header[156] = symlink ? 0x32 : 0x30;
    if (symlink) {
      writeText(
        header,
        157,
        tarNameBytes,
        validateArchiveLinkTarget(path, entry.linkTarget),
      );
    }
    writeText(header, 257, 6, "ustar\0");
    writeText(header, 263, 2, "00");
    writeOctal(header, 329, 8, 0);
    writeOctal(header, 337, 8, 0);
    writeText(header, 345, tarPrefixBytes, pathFields.prefix);
    writeText(header, 148, 6, checksum(header).toString(8).padStart(6, "0"));
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header, contents);
    const padding = (blockSize - (contents.length % blockSize)) % blockSize;
    if (padding > 0) {
      chunks.push(new Uint8Array(padding));
    }
  }
  chunks.push(new Uint8Array(blockSize * 2));
  const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }
  return archive;
};

const readText = (
  source: Uint8Array,
  offset: number,
  length: number,
): string => {
  const field = source.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end));
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

export const parseTarArchive = (
  archive: Uint8Array,
): ReadonlyArray<ArchiveEntry> => {
  const entries: Array<ArchiveEntry> = [];
  let offset = 0;
  while (offset + blockSize <= archive.length) {
    const header = archive.subarray(offset, offset + blockSize);
    if (header.every((byte) => byte === 0)) {
      return entries;
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
    const path = validateArchivePath(
      prefix === "" ? name : `${prefix}/${name}`,
    );
    const type = header[156];
    if (type !== 0 && type !== 0x30 && type !== 0x32) {
      throw new TypeError(
        `unsupported tar entry type: ${String.fromCharCode(type ?? 0)}`,
      );
    }
    const size = readOctal(header, 124, 12);
    const start = offset + blockSize;
    const end = start + size;
    if (end > archive.length) {
      throw new TypeError("truncated tar entry");
    }
    const common = {
      path,
      contents: archive.slice(start, end),
      mode: readOctal(header, 100, 8),
      modifiedSeconds: readOctal(header, 136, 12),
    };
    entries.push(
      type === 0x32
        ? {
            ...common,
            kind: "symlink",
            linkTarget: validateArchiveLinkTarget(
              path,
              readText(header, 157, tarNameBytes),
            ),
          }
        : common,
    );
    offset = start + Math.ceil(size / blockSize) * blockSize;
  }
  throw new TypeError("tar archive is missing its end marker");
};
