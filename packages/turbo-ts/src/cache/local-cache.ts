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

interface CacheEntryFileSnapshot {
  readonly name: string;
  readonly modified: number;
  readonly size: number;
}

interface CacheEntrySnapshot {
  readonly hash: string;
  readonly files: ReadonlyArray<CacheEntryFileSnapshot>;
  readonly modified: number;
  readonly size: number;
}

const summarizeCacheEntry = (
  hash: string,
  files: ReadonlyArray<CacheEntryFileSnapshot>,
): CacheEntrySnapshot => {
  const sortedFiles = [...files].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const archiveModified = sortedFiles.find((file) =>
    file.name.endsWith(".tar.zst"),
  )?.modified;
  return {
    hash,
    files: sortedFiles,
    modified:
      archiveModified ??
      sortedFiles.reduce(
        (modified, file) => Math.max(modified, file.modified),
        0,
      ),
    size: sortedFiles.reduce((size, file) => size + file.size, 0),
  };
};

const cacheEntrySnapshotMatches = (
  left: CacheEntrySnapshot,
  right: CacheEntrySnapshot,
): boolean =>
  left.files.length === right.files.length &&
  left.files.every((file, index) => {
    const candidate = right.files[index];
    return (
      candidate !== undefined &&
      file.name === candidate.name &&
      file.modified === candidate.modified &&
      file.size === candidate.size
    );
  });

const readCacheEntrySnapshot = (
  directory: string,
  hash: string,
): Effect.Effect<
  CacheEntrySnapshot | undefined,
  CacheError,
  FileSystemService
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const files = (yield* Effect.forEach(
      cacheFileSuffixes,
      (suffix) => {
        const name = `${hash}${suffix}`;
        const path = joinPath(directory, name);
        return fileSystem.exists(path).pipe(
          Effect.mapError((error) => cacheError(path, error.message)),
          Effect.flatMap((exists) =>
            exists
              ? fileSystem.metadata(path).pipe(
                  Effect.map((metadata) =>
                    metadata.kind === "file"
                      ? {
                          name,
                          modified: metadata.modifiedMilliseconds,
                          size: metadata.size,
                        }
                      : undefined,
                  ),
                  Effect.mapError((error) => cacheError(path, error.message)),
                )
              : Effect.succeed(undefined),
          ),
        );
      },
      { concurrency: 3 },
    )).filter((file): file is CacheEntryFileSnapshot => file !== undefined);
    return files.length === 0 ? undefined : summarizeCacheEntry(hash, files);
  });

const atomicTemporaryFile = (
  name: string,
): { readonly hash: string; readonly name: string } | undefined => {
  const match =
    /^(.*)\.([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/.exec(
      name,
    );
  if (match?.[1] === undefined) return undefined;
  const hash = cacheFileHash(match[1]);
  return hash === undefined ? undefined : { hash, name };
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
  windowsPathSeparators = true,
  onHit?: (durationMilliseconds: number) => void,
): Effect.Effect<
  boolean,
  CacheError | CacheRollbackError,
  FileSystemService | CompressionService | ClockService | RandomnessService
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
    return yield* withEntryLock(
      options,
      hash,
      Effect.gen(function* () {
        const stillExists = yield* fileSystem
          .exists(paths.archive)
          .pipe(
            Effect.mapError((error) =>
              cacheError(paths.archive, error.message),
            ),
          );
        if (!stillExists) return false;
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
                        windowsPathSeparators,
                      ),
                    ),
                  );
              })
              .pipe(
                Effect.mapError((error) =>
                  error._tag === "CacheError" ||
                  error._tag === "CacheRollbackError"
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
        const duration = yield* fileSystem.readText(paths.metadata).pipe(
          Effect.map((contents) => {
            const parsed: unknown = JSON.parse(contents);
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              !("duration" in parsed) ||
              typeof parsed.duration !== "number" ||
              !Number.isFinite(parsed.duration)
            ) {
              return 0;
            }
            return Math.max(0, parsed.duration);
          }),
          Effect.catchAll(() => Effect.succeed(0)),
        );
        yield* Effect.sync(() => onHit?.(duration));
        return true;
      }),
    );
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
const lockRenewalMilliseconds = 60 * 1_000;

interface EntryLock {
  readonly path: string;
  readonly contents: string;
}

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

const renewEntryLock = (
  lock: EntryLock,
): Effect.Effect<void, CacheError, FileSystemService | ClockService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const clock = yield* ClockService;
    const current = yield* fileSystem
      .readText(lock.path)
      .pipe(Effect.mapError((error) => cacheError(lock.path, error.message)));
    if (current !== lock.contents) {
      return yield* Effect.fail(
        cacheError(lock.path, "cache writer lock ownership was lost"),
      );
    }
    const now = yield* clock.now;
    yield* fileSystem
      .setFileMetadata(lock.path, 0o600, now)
      .pipe(
        Effect.mapError((error) =>
          cacheError(
            lock.path,
            `cache writer lock renewal failed: ${error.message}`,
          ),
        ),
      );
    const renewed = yield* fileSystem
      .readText(lock.path)
      .pipe(Effect.mapError((error) => cacheError(lock.path, error.message)));
    if (renewed !== lock.contents) {
      return yield* Effect.fail(
        cacheError(lock.path, "cache writer lock ownership was lost"),
      );
    }
  });

const maintainEntryLock = (
  lock: EntryLock,
): Effect.Effect<never, CacheError, FileSystemService | ClockService> =>
  Effect.forever(
    Effect.gen(function* () {
      const clock = yield* ClockService;
      yield* clock.sleep(lockRenewalMilliseconds);
      yield* renewEntryLock(lock);
    }),
  );

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
          Effect.flatMap((lock) =>
            Effect.raceFirst(restore(use), restore(maintainEntryLock(lock))),
          ),
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
  windowsPathSeparators = true,
): Effect.Effect<
  void,
  CacheError,
  FileSystemService | CompressionService | RandomnessService | ClockService
> =>
  Effect.gen(function* () {
    const compression = yield* CompressionService;
    let archive: Uint8Array;
    try {
      archive = createTarArchive(entries, windowsPathSeparators);
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

const removeStaleTemporaryFiles = (
  directory: string,
  names: ReadonlyArray<string>,
  now: number,
): Effect.Effect<void, CacheError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const outcomes = yield* Effect.all(
      names.map((name) => {
        const path = joinPath(directory, name);
        return isStaleFile(path, now).pipe(
          Effect.flatMap((stale) =>
            stale ? fileSystem.remove(path) : Effect.void,
          ),
          Effect.either,
        );
      }),
      { concurrency: 3 },
    );
    const failures = outcomes.flatMap((outcome, index) =>
      outcome._tag === "Left"
        ? [`${joinPath(directory, names[index]!)}: ${outcome.left.message}`]
        : [],
    );
    if (failures.length > 0) {
      return yield* Effect.fail(
        cacheError(
          directory,
          `stale atomic temporary cleanup failed: ${failures.join("; ")}`,
        ),
      );
    }
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
    const now = yield* clock.now;
    const staleTemporaries = (yield* Effect.forEach(
      directoryEntries.flatMap((entry) =>
        entry.kind === "file" ? (atomicTemporaryFile(entry.name) ?? []) : [],
      ),
      (entry) =>
        isStaleFile(joinPath(options.directory, entry.name), now).pipe(
          Effect.map((stale) => (stale ? entry : undefined)),
        ),
      { concurrency: 8 },
    )).filter(
      (entry): entry is NonNullable<typeof entry> => entry !== undefined,
    );
    const temporaryNamesByHash = new Map<string, Array<string>>();
    for (const temporary of staleTemporaries) {
      const names = temporaryNamesByHash.get(temporary.hash) ?? [];
      names.push(temporary.name);
      temporaryNamesByHash.set(temporary.hash, names);
    }
    for (const [hash, names] of temporaryNamesByHash) {
      yield* withEntryLock(
        options,
        hash,
        removeStaleTemporaryFiles(options.directory, names, now),
      );
    }
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
            name: entry.name,
            modified: metadata.modifiedMilliseconds,
            size: metadata.size,
          })),
          Effect.mapError((error) => cacheError(path, error.message)),
        );
      },
    );
    const grouped = new Map<string, Array<CacheEntryFileSnapshot>>();
    for (const file of cacheFiles) {
      const current = grouped.get(file.hash) ?? [];
      current.push({
        name: file.name,
        modified: file.modified,
        size: file.size,
      });
      grouped.set(file.hash, current);
    }
    const cacheEntries = [...grouped].map(([hash, files]) =>
      summarizeCacheEntry(hash, files),
    );
    let total = cacheEntries.reduce((size, entry) => size + entry.size, 0);
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
      const revalidated = yield* withEntryLock(
        options,
        entry.hash,
        Effect.gen(function* () {
          const current = yield* readCacheEntrySnapshot(
            options.directory,
            entry.hash,
          );
          const currentTotal = total - entry.size + (current?.size ?? 0);
          if (current === undefined) {
            return currentTotal;
          }
          const lockedNow = yield* clock.now;
          const stillExpired =
            options.maxAgeMilliseconds !== undefined &&
            lockedNow - current.modified > options.maxAgeMilliseconds;
          const stillOversized =
            options.maxSizeBytes !== undefined &&
            currentTotal > options.maxSizeBytes;
          if (
            !cacheEntrySnapshotMatches(entry, current) ||
            (!stillExpired && !stillOversized)
          ) {
            return currentTotal;
          }
          yield* removeEntry(options.directory, entry.hash);
          return currentTotal - current.size;
        }),
      );
      total = revalidated;
    }
  });
