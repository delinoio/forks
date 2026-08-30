import { Effect } from "effect";
import { isPathContained, joinPath, parentPath } from "../core/path.js";
import { CacheError } from "../effect/errors.js";
import {
  ClockService,
  CompressionService,
  FileSystemService,
  RandomnessService,
} from "../effect/services.js";
import {
  type ArchiveEntry,
  createTarArchive,
  parseTarArchive,
} from "./archive.js";

export interface CacheWriteEntry extends ArchiveEntry {}

export interface LocalCacheOptions {
  readonly directory: string;
  readonly maxAgeMilliseconds?: number;
  readonly maxSizeBytes?: number;
}

const cacheError = (
  path: string,
  cause: unknown,
  retryable = false,
): CacheError => new CacheError({ path, message: String(cause), retryable });

const cachePaths = (directory: string, hash: string) => ({
  archive: joinPath(directory, `${hash}.tar.zst`),
  manifest: joinPath(directory, `${hash}-manifest.json`),
  metadata: joinPath(directory, `${hash}-meta.json`),
});

const removeEntry = (
  directory: string,
  hash: string,
): Effect.Effect<void, never, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const paths = cachePaths(directory, hash);
    yield* Effect.all(
      [paths.archive, paths.manifest, paths.metadata].map((path) =>
        fileSystem.remove(path).pipe(Effect.ignore),
      ),
      { concurrency: 3 },
    );
  });

export const restoreLocalCache = (
  root: string,
  options: LocalCacheOptions,
  hash: string,
): Effect.Effect<boolean, CacheError, FileSystemService | CompressionService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const compression = yield* CompressionService;
    const paths = cachePaths(options.directory, hash);
    const exists = yield* fileSystem
      .exists(paths.archive)
      .pipe(
        Effect.mapError((error) => cacheError(paths.archive, error.message)),
      );
    if (!exists) {
      return false;
    }
    const outcome = yield* Effect.either(
      Effect.gen(function* () {
        const compressed = yield* fileSystem
          .readBytes(paths.archive)
          .pipe(
            Effect.mapError((error) =>
              cacheError(paths.archive, error.message),
            ),
          );
        const archive = yield* compression
          .decompressZstd(compressed)
          .pipe(
            Effect.mapError((error) =>
              cacheError(paths.archive, error.message),
            ),
          );
        let entries: ReadonlyArray<ArchiveEntry>;
        try {
          entries = parseTarArchive(archive);
        } catch (cause) {
          return yield* Effect.fail(cacheError(paths.archive, cause));
        }
        for (const entry of entries) {
          const destination = joinPath(root, entry.path);
          if (!isPathContained(root, destination)) {
            return yield* Effect.fail(
              cacheError(destination, "archive path escapes repository"),
            );
          }
          yield* fileSystem
            .makeDirectory(parentPath(destination))
            .pipe(
              Effect.mapError((error) =>
                cacheError(destination, error.message),
              ),
            );
          const resolvedParent = yield* fileSystem
            .realPath(parentPath(destination))
            .pipe(
              Effect.mapError((error) =>
                cacheError(destination, error.message),
              ),
            );
          if (!isPathContained(root, resolvedParent)) {
            return yield* Effect.fail(
              cacheError(destination, "archive parent is an escaping symlink"),
            );
          }
          if (
            yield* fileSystem
              .exists(destination)
              .pipe(
                Effect.mapError((error) =>
                  cacheError(destination, error.message),
                ),
              )
          ) {
            const metadata = yield* fileSystem
              .metadata(destination)
              .pipe(
                Effect.mapError((error) =>
                  cacheError(destination, error.message),
                ),
              );
            if (metadata.kind === "symlink") {
              return yield* Effect.fail(
                cacheError(destination, "archive destination is a symlink"),
              );
            }
          }
          yield* fileSystem
            .writeBytes(destination, entry.contents)
            .pipe(
              Effect.mapError((error) =>
                cacheError(destination, error.message),
              ),
            );
          yield* fileSystem
            .setFileMetadata(
              destination,
              entry.mode,
              entry.modifiedSeconds * 1_000,
            )
            .pipe(
              Effect.mapError((error) =>
                cacheError(destination, error.message),
              ),
            );
        }
      }),
    );
    if (outcome._tag === "Left") {
      yield* removeEntry(options.directory, hash);
      return false;
    }
    return true;
  });

const writeAtomically = (
  path: string,
  contents: Uint8Array | string,
): Effect.Effect<void, CacheError, FileSystemService | RandomnessService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const randomness = yield* RandomnessService;
    const identifier = yield* randomness.uuidV7.pipe(
      Effect.mapError((error) => cacheError(path, error.message)),
    );
    const temporary = `${path}.${identifier}.tmp`;
    yield* fileSystem
      .makeDirectory(parentPath(path))
      .pipe(Effect.mapError((error) => cacheError(path, error.message)));
    if (typeof contents === "string") {
      yield* fileSystem
        .writeText(temporary, contents)
        .pipe(Effect.mapError((error) => cacheError(temporary, error.message)));
    } else {
      yield* fileSystem
        .writeBytes(temporary, contents)
        .pipe(Effect.mapError((error) => cacheError(temporary, error.message)));
    }
    yield* fileSystem
      .rename(temporary, path)
      .pipe(Effect.mapError((error) => cacheError(path, error.message)));
  });

const withEntryLock = <A, E, R>(
  options: LocalCacheOptions,
  hash: string,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | CacheError, R | FileSystemService | ClockService> =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystemService;
      const clock = yield* ClockService;
      yield* fileSystem
        .makeDirectory(options.directory)
        .pipe(
          Effect.mapError((error) =>
            cacheError(options.directory, error.message),
          ),
        );
      const lockPath = joinPath(options.directory, `${hash}.turbo-ts.lock`);
      const started = yield* clock.now;
      while (true) {
        const acquired = yield* fileSystem
          .createExclusiveFile(lockPath)
          .pipe(
            Effect.mapError((error) => cacheError(lockPath, error.message)),
          );
        if (acquired) return lockPath;
        if ((yield* clock.now) - started >= 5_000) {
          return yield* Effect.fail(
            cacheError(lockPath, "timed out acquiring cache writer lock", true),
          );
        }
        yield* clock.sleep(10);
      }
    }),
    () => use,
    (lockPath) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystemService;
        yield* fileSystem.remove(lockPath).pipe(Effect.ignore);
      }),
  );

export const writeLocalCache = (
  options: LocalCacheOptions,
  hash: string,
  entries: ReadonlyArray<CacheWriteEntry>,
  durationMilliseconds: number,
): Effect.Effect<
  void,
  CacheError,
  FileSystemService | CompressionService | RandomnessService | ClockService
> =>
  Effect.gen(function* () {
    const compression = yield* CompressionService;
    let archive: Uint8Array;
    try {
      archive = createTarArchive(entries);
    } catch (cause) {
      return yield* Effect.fail(cacheError(options.directory, cause));
    }
    const compressed = yield* compression
      .compressZstd(archive)
      .pipe(
        Effect.mapError((error) =>
          cacheError(options.directory, error.message),
        ),
      );
    const paths = cachePaths(options.directory, hash);
    const order = [...entries].map((entry) => entry.path).sort();
    const files = Object.fromEntries(
      [...entries]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((entry) => [
          entry.path,
          {
            size: entry.contents.length,
            mtime_nanos: Math.floor(entry.modifiedSeconds * 1_000_000_000),
            mode: entry.mode,
            is_dir: false,
          },
        ]),
    );
    yield* withEntryLock(
      options,
      hash,
      Effect.all(
        [
          writeAtomically(paths.archive, compressed),
          writeAtomically(paths.manifest, JSON.stringify({ files, order })),
          writeAtomically(
            paths.metadata,
            JSON.stringify({
              hash,
              duration: Math.max(0, Math.round(durationMilliseconds)),
              sha: null,
              dirty_hash: null,
            }),
          ),
        ],
        { concurrency: 3 },
      ),
    );
    yield* evictLocalCache(options);
  });

export const evictLocalCache = (
  options: LocalCacheOptions,
): Effect.Effect<void, CacheError, FileSystemService | ClockService> =>
  Effect.gen(function* () {
    if (
      options.maxAgeMilliseconds === undefined &&
      options.maxSizeBytes === undefined
    ) {
      return;
    }
    const fileSystem = yield* FileSystemService;
    const clock = yield* ClockService;
    const exists = yield* fileSystem
      .exists(options.directory)
      .pipe(
        Effect.mapError((error) =>
          cacheError(options.directory, error.message),
        ),
      );
    if (!exists) {
      return;
    }
    const entries = yield* fileSystem
      .list(options.directory)
      .pipe(
        Effect.mapError((error) =>
          cacheError(options.directory, error.message),
        ),
      );
    const archives = yield* Effect.forEach(
      entries.filter(
        (entry) => entry.kind === "file" && entry.name.endsWith(".tar.zst"),
      ),
      (entry) => {
        const path = joinPath(options.directory, entry.name);
        return fileSystem.metadata(path).pipe(
          Effect.map((metadata) => ({
            hash: entry.name.slice(0, -".tar.zst".length),
            modified: metadata.modifiedMilliseconds,
            size: metadata.size,
          })),
          Effect.mapError((error) => cacheError(path, error.message)),
        );
      },
    );
    let total = archives.reduce((size, entry) => size + entry.size, 0);
    const now = yield* clock.now;
    for (const entry of [...archives].sort(
      (left, right) => left.modified - right.modified,
    )) {
      const expired =
        options.maxAgeMilliseconds !== undefined &&
        now - entry.modified > options.maxAgeMilliseconds;
      const oversized =
        options.maxSizeBytes !== undefined && total > options.maxSizeBytes;
      if (!expired && !oversized) {
        continue;
      }
      yield* removeEntry(options.directory, entry.hash);
      total -= entry.size;
    }
  });
