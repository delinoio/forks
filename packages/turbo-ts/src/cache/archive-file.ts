import { Effect } from "effect";
import { CacheError } from "../effect/errors.js";
import { FileSystemService } from "../effect/services.js";
import {
  type PaxValues,
  parsePaxContents,
  parseTarHeader,
  resolveArchiveLinkTarget,
  resolveArchivePath,
  tarBlockSize,
} from "./archive.js";
import type { RestorableArchiveEntry } from "./restore.js";

const maximumPaxHeaderBytes = 64 * 1024;

const archiveFileError = (path: string, cause: unknown): CacheError =>
  new CacheError({ path, message: String(cause), retryable: false });

const readExactRange = (
  path: string,
  offset: number,
  length: number,
): Effect.Effect<Uint8Array, CacheError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const contents = yield* fileSystem
      .readBytesRange(path, offset, length)
      .pipe(Effect.mapError((error) => archiveFileError(path, error.message)));
    if (contents.length !== length) {
      return yield* Effect.fail(
        archiveFileError(
          path,
          `truncated tar range at offset ${offset}: expected ${length} bytes, read ${contents.length}`,
        ),
      );
    }
    return contents;
  });

export const parseTarArchiveFile = (
  path: string,
): Effect.Effect<
  ReadonlyArray<RestorableArchiveEntry>,
  CacheError,
  FileSystemService
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const metadata = yield* fileSystem
      .metadata(path)
      .pipe(Effect.mapError((error) => archiveFileError(path, error.message)));
    if (metadata.kind !== "file") {
      return yield* Effect.fail(
        archiveFileError(path, "decompressed cache archive is not a file"),
      );
    }
    const entries: Array<RestorableArchiveEntry> = [];
    let extended: PaxValues | undefined;
    let offset = 0;
    while (offset + tarBlockSize <= metadata.size) {
      const header = yield* readExactRange(path, offset, tarBlockSize);
      if (header.every((byte) => byte === 0)) {
        if (extended !== undefined) {
          return yield* Effect.fail(
            archiveFileError(path, "PAX header is missing its archive entry"),
          );
        }
        return entries;
      }
      let parsed: ReturnType<typeof parseTarHeader>;
      try {
        parsed = parseTarHeader(header);
      } catch (cause) {
        return yield* Effect.fail(archiveFileError(path, cause));
      }
      const start = offset + tarBlockSize;
      const paddedSize = Math.ceil(parsed.size / tarBlockSize) * tarBlockSize;
      const nextOffset = start + paddedSize;
      if (
        !Number.isSafeInteger(nextOffset) ||
        nextOffset < start ||
        start + parsed.size > metadata.size ||
        nextOffset > metadata.size
      ) {
        return yield* Effect.fail(
          archiveFileError(path, "truncated tar entry"),
        );
      }
      if (parsed.type === 0x78) {
        if (parsed.size > maximumPaxHeaderBytes) {
          return yield* Effect.fail(
            archiveFileError(
              path,
              `PAX header exceeds the ${maximumPaxHeaderBytes} byte limit`,
            ),
          );
        }
        try {
          extended = {
            ...extended,
            ...parsePaxContents(
              yield* readExactRange(path, start, parsed.size),
            ),
          };
        } catch (cause) {
          return yield* Effect.fail(archiveFileError(path, cause));
        }
        offset = nextOffset;
        continue;
      }
      let entryPath: string;
      try {
        entryPath = resolveArchivePath(parsed.headerPath, extended?.path);
      } catch (cause) {
        return yield* Effect.fail(archiveFileError(path, cause));
      }
      if (extended?.linkpath !== undefined && parsed.type !== 0x32) {
        return yield* Effect.fail(
          archiveFileError(path, "PAX linkpath applies to a non-symlink entry"),
        );
      }
      if (parsed.type === 0x35 && parsed.size !== 0) {
        return yield* Effect.fail(
          archiveFileError(path, "tar directory entry has contents"),
        );
      }
      const common = {
        path: entryPath,
        mode: parsed.mode,
        modifiedSeconds: parsed.modifiedSeconds,
      };
      if (parsed.type === 0x32) {
        let linkTarget: string;
        try {
          linkTarget = resolveArchiveLinkTarget(
            entryPath,
            parsed.linkTarget,
            extended?.linkpath,
          );
        } catch (cause) {
          return yield* Effect.fail(archiveFileError(path, cause));
        }
        entries.push({
          ...common,
          kind: "symlink",
          linkTarget,
          contents: new Uint8Array(),
        });
      } else if (parsed.type === 0x35) {
        entries.push({ ...common, kind: "directory" });
      } else {
        entries.push({
          ...common,
          contents: { sourcePath: path, offset: start, length: parsed.size },
        });
      }
      extended = undefined;
      offset = nextOffset;
    }
    return yield* Effect.fail(
      archiveFileError(path, "tar archive is missing its end marker"),
    );
  });
