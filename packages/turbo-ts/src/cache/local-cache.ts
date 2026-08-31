import { Effect } from "effect";
import { joinPath, parentPath } from "../core/path.js";
import { CacheError, CacheRollbackError } from "../effect/errors.js";
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
import { type CacheRestoreScope, restoreArchiveEntries } from "./restore.js";

export type CacheWriteEntry = ArchiveEntry;

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

const cacheFileSuffixes = [".tar.zst", "-manifest.json", "-meta.json"] as const;

const cacheFileHash = (name: string): string | undefined => {
  const suffix = cacheFileSuffixes.find(
    (candidate) => name.length > candidate.length && name.endsWith(candidate),
  );
  return suffix === undefined ? undefined : name.slice(0, -suffix.length);
};

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
  scope: CacheRestoreScope,
): Effect.Effect<
  boolean,
  CacheError | CacheRollbackError,
  FileSystemService | CompressionService
> =>
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
        yield* restoreArchiveEntries(root, entries, scope);
      }),
    );
    if (outcome._tag === "Left") {
      yield* removeEntry(options.directory, hash);
      if (outcome.left._tag === "CacheRollbackError") {
        return yield* Effect.fail(outcome.left);
      }
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
    yield* Effect.acquireUseRelease(
      Effect.succeed(temporary),
      (temporaryPath) =>
        Effect.gen(function* () {
          if (typeof contents === "string") {
            yield* fileSystem
              .writeText(temporaryPath, contents)
              .pipe(
                Effect.mapError((error) =>
                  cacheError(temporaryPath, error.message),
                ),
              );
          } else {
            yield* fileSystem
              .writeBytes(temporaryPath, contents)
              .pipe(
                Effect.mapError((error) =>
                  cacheError(temporaryPath, error.message),
                ),
              );
          }
          yield* fileSystem
            .rename(temporaryPath, path)
            .pipe(Effect.mapError((error) => cacheError(path, error.message)));
        }),
      (temporaryPath) => fileSystem.remove(temporaryPath).pipe(Effect.ignore),
    );
  });

const staleLockMilliseconds = 5 * 60 * 1_000;

const lockOwner = (contents: string): string => {
  try {
    const owner = (JSON.parse(contents) as { readonly owner?: unknown }).owner;
    return typeof owner === "string" && /^[0-9a-f-]+$/.test(owner)
      ? owner
      : "invalid";
  } catch {
    return "invalid";
  }
};

const isStaleFile = (
  path: string,
  now: number,
): Effect.Effect<boolean, never, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const metadata = yield* Effect.either(fileSystem.metadata(path));
    return (
      metadata._tag === "Right" &&
      now - metadata.right.modifiedMilliseconds >= staleLockMilliseconds
    );
  });

const reclaimStaleLock = (
  lockPath: string,
  contenderContents: string,
  now: number,
): Effect.Effect<void, never, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const observed = yield* Effect.either(fileSystem.readText(lockPath));
    if (observed._tag === "Left" || !(yield* isStaleFile(lockPath, now))) {
      return;
    }
    // Serialize reclamation by the observed owner so concurrent contenders do
    // not both remove a successor's lock. Reclaim the marker itself by age if
    // the contender that created it was terminated.
    const reclaimPath = `${lockPath}.${lockOwner(observed.right)}.reclaim`;
    let claimed = yield* Effect.either(
      fileSystem.createExclusiveFile(reclaimPath, contenderContents),
    );
    if (
      claimed._tag === "Right" &&
      !claimed.right &&
      (yield* isStaleFile(reclaimPath, now))
    ) {
      yield* fileSystem.remove(reclaimPath).pipe(Effect.ignore);
      claimed = yield* Effect.either(
        fileSystem.createExclusiveFile(reclaimPath, contenderContents),
      );
    }
    if (claimed._tag !== "Right" || !claimed.right) {
      return;
    }
    const current = yield* Effect.either(fileSystem.readText(lockPath));
    if (
      current._tag === "Right" &&
      current.right === observed.right &&
      (yield* isStaleFile(lockPath, now))
    ) {
      yield* fileSystem.remove(lockPath).pipe(Effect.ignore);
    }
    yield* fileSystem.remove(reclaimPath).pipe(Effect.ignore);
  });

const withEntryLock = <A, E, R>(
  options: LocalCacheOptions,
  hash: string,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | CacheError,
  R | FileSystemService | ClockService | RandomnessService
> =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystemService;
      const clock = yield* ClockService;
      const randomness = yield* RandomnessService;
      yield* fileSystem
        .makeDirectory(options.directory)
        .pipe(
          Effect.mapError((error) =>
            cacheError(options.directory, error.message),
          ),
        );
      const lockPath = joinPath(options.directory, `${hash}.turbo-ts.lock`);
      const started = yield* clock.now;
      const owner = yield* randomness.uuidV7.pipe(
        Effect.mapError((error) => cacheError(lockPath, error.message)),
      );
      const contents = JSON.stringify({ owner, createdAt: started });
      while (true) {
        const acquired = yield* fileSystem
          .createExclusiveFile(lockPath, contents)
          .pipe(
            Effect.mapError((error) => cacheError(lockPath, error.message)),
          );
        if (acquired) return { path: lockPath, contents };
        const now = yield* clock.now;
        yield* reclaimStaleLock(lockPath, contents, now);
        if (now - started >= 5_000) {
          return yield* Effect.fail(
            cacheError(lockPath, "timed out acquiring cache writer lock", true),
          );
        }
        yield* clock.sleep(10);
      }
    }),
    () => use,
    (lock) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystemService;
        const current = yield* Effect.either(fileSystem.readText(lock.path));
        if (current._tag === "Right" && current.right === lock.contents) {
          yield* fileSystem.remove(lock.path).pipe(Effect.ignore);
        }
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
            size: entry.kind === "directory" ? 0 : entry.contents.length,
            mtime_nanos: Math.floor(entry.modifiedSeconds * 1_000_000_000),
            mode: entry.mode,
            is_dir: entry.kind === "directory",
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
    const directoryEntries = yield* fileSystem
      .list(options.directory)
      .pipe(
        Effect.mapError((error) =>
          cacheError(options.directory, error.message),
        ),
      );
    const cacheFiles = yield* Effect.forEach(
      directoryEntries.flatMap((entry) => {
        const hash =
          entry.kind === "file" ? cacheFileHash(entry.name) : undefined;
        return hash === undefined ? [] : [{ hash, name: entry.name }];
      }),
      (entry) => {
        const path = joinPath(options.directory, entry.name);
        return fileSystem.metadata(path).pipe(
          Effect.map((metadata) => ({
            hash: entry.hash,
            archive: entry.name.endsWith(".tar.zst"),
            modified: metadata.modifiedMilliseconds,
            size: metadata.size,
          })),
          Effect.mapError((error) => cacheError(path, error.message)),
        );
      },
    );
    const grouped = new Map<
      string,
      {
        readonly hash: string;
        readonly size: number;
        readonly modified: number;
        readonly archiveModified?: number;
      }
    >();
    for (const file of cacheFiles) {
      const current = grouped.get(file.hash);
      grouped.set(file.hash, {
        hash: file.hash,
        size: (current?.size ?? 0) + file.size,
        modified: Math.max(current?.modified ?? 0, file.modified),
        archiveModified: file.archive
          ? file.modified
          : current?.archiveModified,
      });
    }
    const cacheEntries = [...grouped.values()].map((entry) => ({
      hash: entry.hash,
      size: entry.size,
      modified: entry.archiveModified ?? entry.modified,
    }));
    let total = cacheEntries.reduce((size, entry) => size + entry.size, 0);
    const now = yield* clock.now;
    for (const entry of cacheEntries.sort(
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
