import { Cause, Effect, Exit, Option, Ref } from "effect";
import { joinPath, parentPath } from "../core/path.js";
import { CacheError, CacheRollbackError } from "../effect/errors.js";
import {
  ClockService,
  CompressionService,
  FileSystemService,
  RandomnessService,
} from "../effect/services.js";
import { type ArchiveEntry, createTarArchive } from "./archive.js";
import { parseTarArchiveFile } from "./archive-file.js";
import {
  maximumCacheArchiveBytes,
  maximumCacheArtifactBytes,
} from "./limits.js";
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

const effectFromExit = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<A, E> =>
  Exit.isSuccess(exit)
    ? Effect.succeed(exit.value)
    : Effect.failCause(exit.cause);

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
): Effect.Effect<void, CacheError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const paths = cachePaths(directory, hash);
    const entryPaths = [paths.archive, paths.manifest, paths.metadata];
    const outcomes = yield* Effect.all(
      entryPaths.map((path) => fileSystem.remove(path).pipe(Effect.either)),
      { concurrency: 3 },
    );
    const failures = outcomes.flatMap((outcome, index) =>
      outcome._tag === "Left"
        ? [`${entryPaths[index]}: ${outcome.left.message}`]
        : [],
    );
    if (failures.length > 0) {
      return yield* Effect.fail(
        cacheError(
          directory,
          `cache entry ${hash} cleanup failed: ${failures.join("; ")}`,
        ),
      );
    }
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
        const metadata = yield* fileSystem
          .metadata(paths.archive)
          .pipe(
            Effect.mapError((error) =>
              cacheError(paths.archive, error.message),
            ),
          );
        if (
          metadata.kind !== "file" ||
          metadata.size > maximumCacheArtifactBytes
        ) {
          return yield* Effect.fail(
            cacheError(
              paths.archive,
              `local cache artifact exceeds the ${maximumCacheArtifactBytes} byte limit`,
            ),
          );
        }
        yield* fileSystem
          .withTemporaryDirectory((directory) => {
            const archivePath = joinPath(directory, "local-cache.tar");
            return compression
              .decompressZstdFileToFile(
                paths.archive,
                archivePath,
                maximumCacheArchiveBytes,
              )
              .pipe(
                Effect.mapError((error) =>
                  cacheError(paths.archive, error.message),
                ),
                Effect.flatMap(() => parseTarArchiveFile(archivePath)),
                Effect.flatMap((entries) =>
                  restoreArchiveEntries(
                    root,
                    entries,
                    scope,
                    fileSystem
                      .remove(directory)
                      .pipe(
                        Effect.mapError((error) =>
                          cacheError(
                            paths.archive,
                            `temporary archive cleanup failed: ${error.message}`,
                          ),
                        ),
                      ),
                  ),
                ),
              );
          })
          .pipe(
            Effect.mapError((error) =>
              error._tag === "CacheError" || error._tag === "CacheRollbackError"
                ? error
                : cacheError(paths.archive, error.message),
            ),
          );
      }),
    );
    if (outcome._tag === "Left") {
      const cleanup = yield* Effect.either(
        removeEntry(options.directory, hash),
      );
      if (
        cleanup._tag === "Left" &&
        outcome.left._tag === "CacheRollbackError"
      ) {
        return yield* Effect.fail(
          new CacheRollbackError({
            path: outcome.left.path,
            message: `${outcome.left.message}; ${cleanup.left.message}`,
          }),
        );
      }
      if (cleanup._tag === "Left") {
        return yield* Effect.fail(cleanup.left);
      }
      return yield* Effect.fail(outcome.left);
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
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const cleanupResult = yield* Ref.make<
          Option.Option<Exit.Exit<void, CacheError>>
        >(Option.none());
        const useResult = yield* Effect.scoped(
          Effect.acquireRelease(Effect.succeed(temporary), (temporaryPath) =>
            fileSystem.remove(temporaryPath).pipe(
              Effect.mapError((error) =>
                cacheError(
                  temporaryPath,
                  `atomic write cleanup failed: ${error.message}`,
                ),
              ),
              Effect.exit,
              Effect.flatMap((exit) =>
                Ref.set(cleanupResult, Option.some(exit)),
              ),
            ),
          ).pipe(
            Effect.flatMap((temporaryPath) =>
              restore(
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
                    .pipe(
                      Effect.mapError((error) =>
                        cacheError(path, error.message),
                      ),
                    );
                }),
              ),
            ),
            Effect.exit,
          ),
        );
        const cleanup = yield* Ref.get(cleanupResult);
        if (Option.isSome(cleanup) && Exit.isFailure(cleanup.value)) {
          if (Exit.isFailure(useResult)) {
            return yield* Effect.failCause(
              Cause.sequential(useResult.cause, cleanup.value.cause),
            );
          }
          return yield* Effect.failCause(cleanup.value.cause);
        }
        return yield* effectFromExit(useResult);
      }),
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
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const releaseResult = yield* Ref.make<
        Option.Option<Exit.Exit<void, CacheError>>
      >(Option.none());
      const useResult = yield* Effect.scoped(
        Effect.acquireRelease(
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
            const lockPath = joinPath(
              options.directory,
              `${hash}.turbo-ts.lock`,
            );
            const started = yield* clock.now;
            const owner = yield* randomness.uuidV7.pipe(
              Effect.mapError((error) => cacheError(lockPath, error.message)),
            );
            const contents = JSON.stringify({ owner, createdAt: started });
            while (true) {
              const acquired = yield* fileSystem
                .createExclusiveFile(lockPath, contents)
                .pipe(
                  Effect.mapError((error) =>
                    cacheError(lockPath, error.message),
                  ),
                );
              if (acquired) return { path: lockPath, contents };
              const now = yield* clock.now;
              yield* reclaimStaleLock(lockPath, contents, now);
              if (now - started >= 5_000) {
                return yield* Effect.fail(
                  cacheError(
                    lockPath,
                    "timed out acquiring cache writer lock",
                    true,
                  ),
                );
              }
              yield* clock.sleep(10);
            }
          }),
          (lock) =>
            Effect.gen(function* () {
              const fileSystem = yield* FileSystemService;
              const current = yield* Effect.either(
                fileSystem.readText(lock.path),
              );
              if (current._tag === "Right" && current.right === lock.contents) {
                yield* fileSystem
                  .remove(lock.path)
                  .pipe(
                    Effect.mapError((error) =>
                      cacheError(
                        lock.path,
                        `cache writer lock release failed: ${error.message}`,
                      ),
                    ),
                  );
              }
            }).pipe(
              Effect.exit,
              Effect.flatMap((exit) =>
                Ref.set(releaseResult, Option.some(exit)),
              ),
            ),
        ).pipe(
          Effect.flatMap(() => restore(use)),
          Effect.exit,
        ),
      );
      const release = yield* Ref.get(releaseResult);
      if (Option.isSome(release) && Exit.isFailure(release.value)) {
        if (Exit.isFailure(useResult)) {
          return yield* Effect.failCause(
            Cause.sequential(useResult.cause, release.value.cause),
          );
        }
        return yield* Effect.failCause(release.value.cause);
      }
      return yield* effectFromExit(useResult);
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
): Effect.Effect<
  void,
  CacheError,
  FileSystemService | ClockService | RandomnessService
> =>
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
      yield* withEntryLock(
        options,
        entry.hash,
        removeEntry(options.directory, entry.hash),
      );
      total -= entry.size;
    }
  });
