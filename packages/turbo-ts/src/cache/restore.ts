import { Effect } from "effect";
import { matchesGlobsWithExclusions } from "../core/glob.js";
import {
  isPathContained,
  joinPathWithSeparators,
  parentPath,
  relativePath,
} from "../core/path.js";
import { CacheError, CacheRollbackError } from "../effect/errors.js";
import { FileSystemService } from "../effect/services.js";

const restoreError = (path: string, cause: unknown): CacheError =>
  new CacheError({ path, message: String(cause), retryable: false });

export interface CacheRestorePathGroup {
  readonly directory: string;
  readonly patterns: ReadonlyArray<string>;
}

export interface CacheRestoreScope {
  readonly pathsToClear: ReadonlyArray<string>;
  readonly allowedPathGroups: ReadonlyArray<CacheRestorePathGroup>;
  readonly regularFilePaths: ReadonlyArray<string>;
  readonly excludedDirectories: ReadonlyArray<string>;
}

export interface ArchiveFileContentsRange {
  readonly sourcePath: string;
  readonly offset: number;
  readonly length: number;
}

interface RestorableArchiveFileEntry {
  readonly kind?: "file";
  readonly path: string;
  readonly contents: Uint8Array | ArchiveFileContentsRange;
  readonly mode: number;
  readonly modifiedSeconds: number;
}

interface RestorableArchiveSymlinkEntry {
  readonly kind: "symlink";
  readonly path: string;
  readonly linkTarget: string;
  readonly contents: Uint8Array;
  readonly mode: number;
  readonly modifiedSeconds: number;
}

interface RestorableArchiveDirectoryEntry {
  readonly kind: "directory";
  readonly path: string;
  readonly mode: number;
  readonly modifiedSeconds: number;
}

export type RestorableArchiveEntry =
  | RestorableArchiveFileEntry
  | RestorableArchiveSymlinkEntry
  | RestorableArchiveDirectoryEntry;

const isArchiveFileContentsRange = (
  contents: Uint8Array | ArchiveFileContentsRange,
): contents is ArchiveFileContentsRange => !(contents instanceof Uint8Array);

const alternateAsciiCase = (value: string): string | undefined => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x41 && code <= 0x5a) {
      return `${value.slice(0, index)}${value[index]!.toLowerCase()}${value.slice(index + 1)}`;
    }
    if (code >= 0x61 && code <= 0x7a) {
      return `${value.slice(0, index)}${value[index]!.toUpperCase()}${value.slice(index + 1)}`;
    }
  }
  return undefined;
};

const pathNamesAreCaseInsensitive = (
  directory: string,
  windowsPathSeparators: boolean,
): Effect.Effect<boolean, CacheError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const entries = yield* fileSystem
      .list(directory)
      .pipe(Effect.mapError((error) => restoreError(directory, error.message)));
    const names = new Set(entries.map((entry) => entry.name));
    for (const entry of entries) {
      const alternate = alternateAsciiCase(entry.name);
      if (alternate === undefined || names.has(alternate)) continue;
      const alternatePath = joinPathWithSeparators(
        windowsPathSeparators,
        directory,
        alternate,
      );
      const exists = yield* fileSystem
        .exists(alternatePath)
        .pipe(
          Effect.mapError((error) =>
            restoreError(alternatePath, error.message),
          ),
        );
      return exists;
    }
    // A repository always has package.json, but fail closed for an unusual
    // empty or non-ASCII-only restore root whose case behavior cannot be
    // observed without mutating it.
    return true;
  });

const comparablePath = (path: string, caseInsensitive: boolean): string =>
  caseInsensitive ? path.toLowerCase() : path;

export const duplicateArchiveEntryDestination = (
  root: string,
  entries: ReadonlyArray<RestorableArchiveEntry>,
  caseInsensitive: boolean,
  windowsPathSeparators = true,
): string | undefined => {
  const destinations = new Set<string>();
  for (const entry of entries) {
    const destination = joinPathWithSeparators(
      windowsPathSeparators,
      root,
      entry.path,
    );
    const comparableDestination = comparablePath(destination, caseInsensitive);
    if (destinations.has(comparableDestination)) return destination;
    destinations.add(comparableDestination);
  }
  return undefined;
};

const nonDirectoryArchiveEntryAncestor = (
  root: string,
  entries: ReadonlyArray<RestorableArchiveEntry>,
  caseInsensitive: boolean,
  windowsPathSeparators: boolean,
):
  | { readonly destination: string; readonly kind: "file" | "symlink" }
  | undefined => {
  const destinations = entries.map((entry) => {
    const destination = joinPathWithSeparators(
      windowsPathSeparators,
      root,
      entry.path,
    );
    return {
      entry,
      destination,
      comparableDestination: comparablePath(destination, caseInsensitive),
    };
  });
  for (const candidate of destinations) {
    if (candidate.entry.kind === "directory") continue;
    const descendantPrefix = `${candidate.comparableDestination}/`;
    if (
      destinations.some(
        (other) =>
          other !== candidate &&
          other.comparableDestination.startsWith(descendantPrefix),
      )
    ) {
      return {
        destination: candidate.destination,
        kind: candidate.entry.kind ?? "file",
      };
    }
  }
  return undefined;
};

const groupAllowsEntry = (
  root: string,
  destination: string,
  group: CacheRestorePathGroup,
  directoryEntry: boolean,
  windowsPathSeparators: boolean,
): boolean => {
  const directory = joinPathWithSeparators(
    windowsPathSeparators,
    root,
    group.directory,
  );
  const relative = relativePath(directory, destination, windowsPathSeparators);
  const candidates = directoryEntry ? [relative, `${relative}/`] : [relative];
  return (
    isPathContained(root, directory, windowsPathSeparators) &&
    isPathContained(directory, destination, windowsPathSeparators) &&
    matchesGlobsWithExclusions(
      candidates,
      group.patterns,
      windowsPathSeparators,
    )
  );
};

const matchingAllowedGroups = (
  root: string,
  destination: string,
  groups: ReadonlyArray<CacheRestorePathGroup>,
  directoryEntry: boolean,
  windowsPathSeparators: boolean,
): ReadonlyArray<CacheRestorePathGroup> =>
  groups.filter((group) =>
    groupAllowsEntry(
      root,
      destination,
      group,
      directoryEntry,
      windowsPathSeparators,
    ),
  );

const prepareParentDirectory = (
  root: string,
  canonicalRoot: string,
  destination: string,
  restoredPaths: Array<string>,
  windowsPathSeparators: boolean,
): Effect.Effect<void, CacheError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const relativeParent = relativePath(
      root,
      parentPath(destination, windowsPathSeparators),
      windowsPathSeparators,
    );
    let current = root;
    for (const segment of relativeParent.split("/").filter(Boolean)) {
      if (segment === ".") continue;
      current = joinPathWithSeparators(windowsPathSeparators, current, segment);
      const exists = yield* fileSystem
        .exists(current)
        .pipe(Effect.mapError((error) => restoreError(current, error.message)));
      if (!exists) {
        yield* fileSystem
          .makeDirectory(current)
          .pipe(
            Effect.mapError((error) => restoreError(current, error.message)),
          );
        restoredPaths.push(relativePath(root, current, windowsPathSeparators));
      }
      const metadata = yield* fileSystem
        .metadata(current)
        .pipe(Effect.mapError((error) => restoreError(current, error.message)));
      if (metadata.kind === "symlink") {
        return yield* Effect.fail(
          restoreError(current, "archive parent is an escaping symlink"),
        );
      }
      const resolved = yield* fileSystem
        .realPath(current)
        .pipe(Effect.mapError((error) => restoreError(current, error.message)));
      if (!isPathContained(canonicalRoot, resolved, windowsPathSeparators)) {
        return yield* Effect.fail(
          restoreError(current, "archive parent is an escaping symlink"),
        );
      }
    }
  });

const validateExistingPathComponents = (
  root: string,
  canonicalRoot: string,
  path: string,
  windowsPathSeparators: boolean,
): Effect.Effect<void, CacheError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const relative = relativePath(root, path, windowsPathSeparators);
    let current = root;
    for (const segment of relative.split("/").filter(Boolean)) {
      if (segment === ".") continue;
      current = joinPathWithSeparators(windowsPathSeparators, current, segment);
      const exists = yield* fileSystem
        .exists(current)
        .pipe(Effect.mapError((error) => restoreError(current, error.message)));
      if (!exists) return;
      const metadata = yield* fileSystem
        .metadata(current)
        .pipe(Effect.mapError((error) => restoreError(current, error.message)));
      if (metadata.kind === "symlink") {
        return yield* Effect.fail(
          restoreError(
            current,
            "archive symlink target has a symlink component",
          ),
        );
      }
      const resolved = yield* fileSystem
        .realPath(current)
        .pipe(Effect.mapError((error) => restoreError(current, error.message)));
      if (!isPathContained(canonicalRoot, resolved, windowsPathSeparators)) {
        return yield* Effect.fail(
          restoreError(current, "archive symlink target escapes repository"),
        );
      }
    }
  });

export const validateArchiveEntriesForRestore = (
  root: string,
  entries: ReadonlyArray<RestorableArchiveEntry>,
  scope: CacheRestoreScope,
  windowsPathSeparators = true,
): Effect.Effect<string, CacheError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const canonicalRoot = yield* fileSystem
      .realPath(root)
      .pipe(Effect.mapError((error) => restoreError(root, error.message)));
    const caseInsensitive = yield* pathNamesAreCaseInsensitive(
      root,
      windowsPathSeparators,
    );
    const regularFileDestinations = new Set(
      scope.regularFilePaths.map((path) =>
        comparablePath(
          joinPathWithSeparators(windowsPathSeparators, root, path),
          caseInsensitive,
        ),
      ),
    );
    const regularFileCounts = new Map<string, number>(
      [...regularFileDestinations].map((path) => [path, 0] as const),
    );
    const duplicateDestination = duplicateArchiveEntryDestination(
      root,
      entries,
      caseInsensitive,
      windowsPathSeparators,
    );
    if (duplicateDestination !== undefined) {
      return yield* Effect.fail(
        restoreError(
          duplicateDestination,
          "archive destination occurs more than once",
        ),
      );
    }
    const nonDirectoryAncestor = nonDirectoryArchiveEntryAncestor(
      root,
      entries,
      caseInsensitive,
      windowsPathSeparators,
    );
    if (nonDirectoryAncestor !== undefined) {
      return yield* Effect.fail(
        restoreError(
          nonDirectoryAncestor.destination,
          `archive ${nonDirectoryAncestor.kind} entry contains another destination`,
        ),
      );
    }
    for (const entry of entries) {
      const destination = joinPathWithSeparators(
        windowsPathSeparators,
        root,
        entry.path,
      );
      const comparableDestination = comparablePath(
        destination,
        caseInsensitive,
      );
      const matchingGroups = matchingAllowedGroups(
        root,
        destination,
        scope.allowedPathGroups,
        entry.kind === "directory",
        windowsPathSeparators,
      );
      if (!isPathContained(root, destination, windowsPathSeparators)) {
        return yield* Effect.fail(
          restoreError(destination, "archive path escapes repository"),
        );
      }
      if (
        scope.excludedDirectories.some((directory) =>
          isPathContained(
            comparablePath(
              joinPathWithSeparators(windowsPathSeparators, root, directory),
              caseInsensitive,
            ),
            comparableDestination,
            windowsPathSeparators,
          ),
        )
      ) {
        return yield* Effect.fail(
          restoreError(
            destination,
            "archive path enters the active cache directory",
          ),
        );
      }
      if (
        !regularFileDestinations.has(comparableDestination) &&
        matchingGroups.length === 0
      ) {
        return yield* Effect.fail(
          restoreError(
            destination,
            "archive path is not a declared task output",
          ),
        );
      }
      if (
        regularFileDestinations.has(comparableDestination) &&
        entry.kind !== undefined &&
        entry.kind !== "file"
      ) {
        return yield* Effect.fail(
          restoreError(destination, "archive task log is not a regular file"),
        );
      }
      if (regularFileDestinations.has(comparableDestination)) {
        const count = (regularFileCounts.get(comparableDestination) ?? 0) + 1;
        if (count > 1) {
          return yield* Effect.fail(
            restoreError(destination, "archive task log occurs more than once"),
          );
        }
        regularFileCounts.set(comparableDestination, count);
      }
      if (entry.kind === "symlink") {
        const target = joinPathWithSeparators(
          windowsPathSeparators,
          parentPath(destination, windowsPathSeparators),
          entry.linkTarget,
        );
        if (!isPathContained(root, target, windowsPathSeparators)) {
          return yield* Effect.fail(
            restoreError(destination, "archive link target escapes repository"),
          );
        }
        if (
          !matchingGroups.some(
            (group) =>
              groupAllowsEntry(
                root,
                target,
                group,
                false,
                windowsPathSeparators,
              ) ||
              groupAllowsEntry(
                root,
                target,
                group,
                true,
                windowsPathSeparators,
              ),
          )
        ) {
          return yield* Effect.fail(
            restoreError(
              destination,
              "archive symlink target is not a declared task output",
            ),
          );
        }
        yield* validateExistingPathComponents(
          root,
          canonicalRoot,
          target,
          windowsPathSeparators,
        );
      }
    }
    for (const [destination, count] of regularFileCounts) {
      if (count !== 1) {
        return yield* Effect.fail(
          restoreError(destination, "archive task log is missing"),
        );
      }
    }
    for (const path of scope.pathsToClear) {
      const destination = joinPathWithSeparators(
        windowsPathSeparators,
        root,
        path,
      );
      if (
        path === "" ||
        path === "." ||
        !isPathContained(root, destination, windowsPathSeparators)
      ) {
        return yield* Effect.fail(
          restoreError(destination, "cache output path escapes repository"),
        );
      }
    }
    for (const path of scope.regularFilePaths) {
      const destination = joinPathWithSeparators(
        windowsPathSeparators,
        root,
        path,
      );
      if (
        path === "" ||
        path === "." ||
        !isPathContained(root, destination, windowsPathSeparators)
      ) {
        return yield* Effect.fail(
          restoreError(
            destination,
            "cache regular-file path escapes repository",
          ),
        );
      }
    }
    return canonicalRoot;
  });

export const restoreArchiveEntries = (
  root: string,
  entries: ReadonlyArray<RestorableArchiveEntry>,
  scope: CacheRestoreScope,
  finalizeRestoration: Effect.Effect<
    void,
    CacheError,
    FileSystemService
  > = Effect.void,
  windowsPathSeparators = true,
): Effect.Effect<void, CacheError | CacheRollbackError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const canonicalRoot = yield* validateArchiveEntriesForRestore(
      root,
      entries,
      scope,
      windowsPathSeparators,
    );
    const restoredPaths: Array<string> = [];
    const restoration = Effect.gen(function* () {
      for (const path of scope.pathsToClear) {
        const destination = joinPathWithSeparators(
          windowsPathSeparators,
          root,
          path,
        );
        yield* fileSystem
          .remove(destination)
          .pipe(
            Effect.mapError((error) =>
              restoreError(destination, error.message),
            ),
          );
      }
      for (const entry of entries) {
        const destination = joinPathWithSeparators(
          windowsPathSeparators,
          root,
          entry.path,
        );
        yield* prepareParentDirectory(
          root,
          canonicalRoot,
          destination,
          restoredPaths,
          windowsPathSeparators,
        );
        let exists = yield* fileSystem
          .exists(destination)
          .pipe(
            Effect.mapError((error) =>
              restoreError(destination, error.message),
            ),
          );
        if (exists) {
          const metadata = yield* fileSystem
            .metadata(destination)
            .pipe(
              Effect.mapError((error) =>
                restoreError(destination, error.message),
              ),
            );
          if (metadata.kind === "symlink" && entry.kind !== "symlink") {
            return yield* Effect.fail(
              restoreError(destination, "archive destination is a symlink"),
            );
          }
          if (entry.kind !== "directory" || metadata.kind !== "directory") {
            yield* fileSystem
              .remove(destination)
              .pipe(
                Effect.mapError((error) =>
                  restoreError(destination, error.message),
                ),
              );
            exists = false;
          }
        }
        if (entry.kind === "directory") {
          if (!exists) {
            yield* fileSystem
              .makeDirectory(destination)
              .pipe(
                Effect.mapError((error) =>
                  restoreError(destination, error.message),
                ),
              );
          }
          restoredPaths.push(entry.path);
          continue;
        }
        if (entry.kind === "symlink") {
          const target = joinPathWithSeparators(
            windowsPathSeparators,
            parentPath(destination, windowsPathSeparators),
            entry.linkTarget,
          );
          if (!isPathContained(root, target, windowsPathSeparators)) {
            return yield* Effect.fail(
              restoreError(
                destination,
                "archive link target escapes repository",
              ),
            );
          }
          yield* validateExistingPathComponents(
            root,
            canonicalRoot,
            target,
            windowsPathSeparators,
          );
          yield* fileSystem
            .createSymlink(entry.linkTarget, destination)
            .pipe(
              Effect.mapError((error) =>
                restoreError(destination, error.message),
              ),
            );
          restoredPaths.push(entry.path);
          continue;
        }
        if (isArchiveFileContentsRange(entry.contents)) {
          restoredPaths.push(entry.path);
          yield* fileSystem
            .copyBytesRange(
              entry.contents.sourcePath,
              entry.contents.offset,
              entry.contents.length,
              destination,
            )
            .pipe(
              Effect.mapError((error) =>
                restoreError(destination, error.message),
              ),
            );
        } else {
          restoredPaths.push(entry.path);
          yield* fileSystem
            .writeBytes(destination, entry.contents)
            .pipe(
              Effect.mapError((error) =>
                restoreError(destination, error.message),
              ),
            );
        }
        yield* fileSystem
          .setFileMetadata(
            destination,
            entry.mode,
            entry.modifiedSeconds * 1_000,
          )
          .pipe(
            Effect.mapError((error) =>
              restoreError(destination, error.message),
            ),
          );
      }
      const directories = entries
        .filter(
          (entry): entry is RestorableArchiveDirectoryEntry =>
            entry.kind === "directory",
        )
        .sort(
          (left, right) =>
            right.path.split("/").length - left.path.split("/").length,
        );
      for (const entry of directories) {
        const destination = joinPathWithSeparators(
          windowsPathSeparators,
          root,
          entry.path,
        );
        yield* fileSystem
          .setFileMetadata(
            destination,
            entry.mode,
            entry.modifiedSeconds * 1_000,
          )
          .pipe(
            Effect.mapError((error) =>
              restoreError(destination, error.message),
            ),
          );
      }
      yield* finalizeRestoration;
    });
    const outcome = yield* Effect.either(restoration);
    if (outcome._tag === "Right") {
      return;
    }
    const rollbackPaths = [
      ...new Set([...scope.pathsToClear, ...restoredPaths]),
    ].sort(
      (left, right) =>
        right.split("/").length - left.split("/").length ||
        right.localeCompare(left),
    );
    const rollback = yield* Effect.either(
      Effect.forEach(
        rollbackPaths,
        (path) => {
          const destination = joinPathWithSeparators(
            windowsPathSeparators,
            root,
            path,
          );
          return fileSystem.remove(destination).pipe(
            Effect.mapError(
              (error) =>
                new CacheRollbackError({
                  path: destination,
                  message: `cache restoration failed: ${outcome.left.message}; rollback failed: ${error.message}`,
                }),
            ),
          );
        },
        { concurrency: 1, discard: true },
      ),
    );
    if (rollback._tag === "Left") {
      return yield* Effect.fail(rollback.left);
    }
    return yield* Effect.fail(outcome.left);
  });
