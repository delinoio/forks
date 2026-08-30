import { Effect } from "effect";
import {
  isPathContained,
  joinPath,
  parentPath,
  relativePath,
} from "../core/path.js";
import { CacheError } from "../effect/errors.js";
import { FileSystemService } from "../effect/services.js";
import type { ArchiveEntry } from "./archive.js";

const restoreError = (path: string, cause: unknown): CacheError =>
  new CacheError({ path, message: String(cause), retryable: false });

const prepareParentDirectory = (
  root: string,
  canonicalRoot: string,
  destination: string,
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

export const restoreArchiveEntries = (
  root: string,
  entries: ReadonlyArray<ArchiveEntry>,
  pathsToClear: ReadonlyArray<string> = [],
): Effect.Effect<void, CacheError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const canonicalRoot = yield* fileSystem
      .realPath(root)
      .pipe(Effect.mapError((error) => restoreError(root, error.message)));
    for (const entry of entries) {
      const destination = joinPath(root, entry.path);
      if (!isPathContained(root, destination)) {
        return yield* Effect.fail(
          restoreError(destination, "archive path escapes repository"),
        );
      }
    }
    for (const path of pathsToClear) {
      const destination = joinPath(root, path);
      if (path === "" || path === "." || !isPathContained(root, destination)) {
        return yield* Effect.fail(
          restoreError(destination, "cache output path escapes repository"),
        );
      }
      yield* fileSystem
        .remove(destination)
        .pipe(
          Effect.mapError((error) => restoreError(destination, error.message)),
        );
    }
    for (const entry of entries) {
      const destination = joinPath(root, entry.path);
      yield* prepareParentDirectory(root, canonicalRoot, destination);
      if (
        yield* fileSystem
          .exists(destination)
          .pipe(
            Effect.mapError((error) =>
              restoreError(destination, error.message),
            ),
          )
      ) {
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
        if (entry.kind === "symlink") {
          yield* fileSystem
            .remove(destination)
            .pipe(
              Effect.mapError((error) =>
                restoreError(destination, error.message),
              ),
            );
        }
      }
      if (entry.kind === "symlink") {
        const target = joinPath(parentPath(destination), entry.linkTarget);
        if (!isPathContained(root, target)) {
          return yield* Effect.fail(
            restoreError(destination, "archive link target escapes repository"),
          );
        }
        yield* fileSystem
          .createSymlink(entry.linkTarget, destination)
          .pipe(
            Effect.mapError((error) =>
              restoreError(destination, error.message),
            ),
          );
        continue;
      }
      yield* fileSystem
        .writeBytes(destination, entry.contents)
        .pipe(
          Effect.mapError((error) => restoreError(destination, error.message)),
        );
      yield* fileSystem
        .setFileMetadata(destination, entry.mode, entry.modifiedSeconds * 1_000)
        .pipe(
          Effect.mapError((error) => restoreError(destination, error.message)),
        );
    }
  });
