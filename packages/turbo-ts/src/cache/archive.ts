import { normalizePath, toUnixPath } from "../core/path.js";

export interface ArchiveEntry {
  readonly path: string;
  readonly contents: Uint8Array;
  readonly mode: number;
  readonly modifiedSeconds: number;
}

const blockSize = 512;

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

export const createTarArchive = (
  entries: ReadonlyArray<ArchiveEntry>,
): Uint8Array => {
  const chunks: Array<Uint8Array> = [];
  for (const entry of [...entries].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    const path = validateArchivePath(entry.path);
    const header = new Uint8Array(blockSize);
    writeText(header, 0, 100, path);
    writeOctal(header, 100, 8, entry.mode & 0o777);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.contents.length);
    writeOctal(header, 136, 12, Math.max(0, Math.floor(entry.modifiedSeconds)));
    header[156] = 0x30;
    writeText(header, 257, 8, "ustar  \0");
    writeOctal(header, 329, 8, 0);
    writeOctal(header, 337, 8, 0);
    writeText(header, 148, 6, checksum(header).toString(8).padStart(6, "0"));
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header, entry.contents);
    const padding =
      (blockSize - (entry.contents.length % blockSize)) % blockSize;
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
    const path = validateArchivePath(readText(header, 0, 100));
    const type = header[156];
    if (type !== 0 && type !== 0x30) {
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
    entries.push({
      path,
      contents: archive.slice(start, end),
      mode: readOctal(header, 100, 8),
      modifiedSeconds: readOctal(header, 136, 12),
    });
    offset = start + Math.ceil(size / blockSize) * blockSize;
  }
  throw new TypeError("tar archive is missing its end marker");
};
