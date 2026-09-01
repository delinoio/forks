import { Effect } from "effect";
import { matchesGlobsWithExclusions } from "../core/glob.js";
import {
  isPathContained,
  joinPath,
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

const comparablePath = (path: string): string =>
  /^[A-Za-z]:/.test(path) || path.startsWith("//") ? path.toLowerCase() : path;

const groupAllowsEntry = (
  root: string,
  destination: string,
  group: CacheRestorePathGroup,
  directoryEntry: boolean,
): boolean => {
  const directory = joinPath(root, group.directory);
  const relative = relativePath(directory, destination);
  const candidates = directoryEntry ? [relative, `${relative}/`] : [relative];
  return (
    isPathContained(root, directory) &&
    isPathContained(directory, destination) &&
    matchesGlobsWithExclusions(candidates, group.patterns)
  );
};

const matchingAllowedGroups = (
  root: string,
  destination: string,
  groups: ReadonlyArray<CacheRestorePathGroup>,
  directoryEntry: boolean,
): ReadonlyArray<CacheRestorePathGroup> =>
  groups.filter((group) =>
    groupAllowsEntry(root, destination, group, directoryEntry),
  );

const prepareParentDirectory = (
  root: string,
  canonicalRoot: string,
  destination: string,
  restoredPaths: Array<string>,
): Effect.Effect<void, CacheError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const relativeParent = relativePath(root, parentPath(destination));
    let current = root;
    for (const segment of relativeParent.split("/").filter(Boolean)) {
      if (segment === ".") continue;
      current = joinPath(current, segment);
      const exists = yield* fileSystem
        .exists(current)
        .pipe(Effect.mapError((error) => restoreError(current, error.message)));
      if (!exists) {
        yield* fileSystem
          .makeDirectory(current)
          .pipe(
            Effect.mapError((error) => restoreError(current, error.message)),
          );
        restoredPaths.push(relativePath(root, current));
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
      if (!isPathContained(canonicalRoot, resolved)) {
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
): Effect.Effect<void, CacheError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const relative = relativePath(root, path);
    let current = root;
    for (const segment of relative.split("/").filter(Boolean)) {
      if (segment === ".") continue;
      current = joinPath(current, segment);
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
      if (!isPathContained(canonicalRoot, resolved)) {
        return yield* Effect.fail(
          restoreError(current, "archive symlink target escapes repository"),
        );
      }
    }
  });

export const restoreArchiveEntries = (
  root: string,
  entries: ReadonlyArray<RestorableArchiveEntry>,
  scope: CacheRestoreScope,
): Effect.Effect<void, CacheError | CacheRollbackError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const canonicalRoot = yield* fileSystem
      .realPath(root)
      .pipe(Effect.mapError((error) => restoreError(root, error.message)));
    const regularFileDestinations = new Set(
      scope.regularFilePaths.map((path) =>
        comparablePath(joinPath(root, path)),
      ),
    );
    const regularFileCounts = new Map<string, number>(
      [...regularFileDestinations].map((path) => [path, 0] as const),
    );
    for (const entry of entries) {
      const destination = joinPath(root, entry.path);
      const comparableDestination = comparablePath(destination);
      const matchingGroups = matchingAllowedGroups(
        root,
        destination,
        scope.allowedPathGroups,
        entry.kind === "directory",
      );
      if (!isPathContained(root, destination)) {
        return yield* Effect.fail(
          restoreError(destination, "archive path escapes repository"),
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
        const target = joinPath(parentPath(destination), entry.linkTarget);
        if (!isPathContained(root, target)) {
          return yield* Effect.fail(
            restoreError(destination, "archive link target escapes repository"),
          );
        }
        if (
          !matchingGroups.some(
            (group) =>
              groupAllowsEntry(root, target, group, false) ||
              groupAllowsEntry(root, target, group, true),
          )
        ) {
          return yield* Effect.fail(
            restoreError(
              destination,
              "archive symlink target is not a declared task output",
            ),
          );
        }
        yield* validateExistingPathComponents(root, canonicalRoot, target);
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
      const destination = joinPath(root, path);
      if (path === "" || path === "." || !isPathContained(root, destination)) {
        return yield* Effect.fail(
          restoreError(destination, "cache output path escapes repository"),
        );
      }
    }
    for (const path of scope.regularFilePaths) {
      const destination = joinPath(root, path);
      if (path === "" || path === "." || !isPathContained(root, destination)) {
        return yield* Effect.fail(
          restoreError(
            destination,
            "cache regular-file path escapes repository",
          ),
        );
      }
    }
    const restoredPaths: Array<string> = [];
    const restoration = Effect.gen(function* () {
      for (const path of scope.pathsToClear) {
        const destination = joinPath(root, path);
        yield* fileSystem
          .remove(destination)
          .pipe(
            Effect.mapError((error) =>
              restoreError(destination, error.message),
            ),
          );
      }
      for (const entry of entries) {
        const destination = joinPath(root, entry.path);
        yield* prepareParentDirectory(
          root,
          canonicalRoot,
          destination,
          restoredPaths,
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
          if (
            entry.kind === "symlink" ||
            (entry.kind === "directory" && metadata.kind !== "directory") ||
            (entry.kind !== "directory" && metadata.kind === "directory")
          ) {
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
          const target = joinPath(parentPath(destination), entry.linkTarget);
          if (!isPathContained(root, target)) {
            return yield* Effect.fail(
              restoreError(
                destination,
                "archive link target escapes repository",
              ),
            );
          }
          yield* validateExistingPathComponents(root, canonicalRoot, target);
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
        const destination = joinPath(root, entry.path);
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
        (path) =>
          fileSystem.remove(joinPath(root, path)).pipe(
            Effect.mapError(
              (error) =>
                new CacheRollbackError({
                  path: joinPath(root, path),
                  message: `cache restoration failed: ${outcome.left.message}; rollback failed: ${error.message}`,
                }),
            ),
          ),
        { concurrency: 1, discard: true },
      ),
    );
    if (rollback._tag === "Left") {
      return yield* Effect.fail(rollback.left);
    }
    return yield* Effect.fail(outcome.left);
  });
