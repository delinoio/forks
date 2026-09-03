import { Effect } from "effect";
import ignore, { type Ignore } from "ignore";
import {
  isPathContained,
  joinPath,
  normalizePath,
  relativePath,
} from "../core/path.js";
import { RepositoryError } from "../effect/errors.js";
import { FileSystemService } from "../effect/services.js";

interface IgnoreRules {
  readonly directory: string;
  readonly matcher: Ignore;
}

export interface GitIgnoreMatcher {
  readonly ignores: (path: string, directory?: boolean) => boolean;
}

const traversalIgnoredDirectories = new Set([
  ".git",
  ".turbo",
  ".venv",
  "node_modules",
]);

const matchesRules = (
  root: string,
  rules: ReadonlyArray<IgnoreRules>,
  path: string,
  directory: boolean,
): boolean => {
  const normalized = normalizePath(path);
  if (!isPathContained(root, normalized)) return false;
  let ignored = false;
  for (const entry of rules) {
    if (!isPathContained(entry.directory, normalized)) continue;
    const relative = relativePath(entry.directory, normalized);
    if (relative === ".") continue;
    const result = entry.matcher.test(
      directory && !relative.endsWith("/") ? `${relative}/` : relative,
    );
    if (result.ignored) ignored = true;
    if (result.unignored) ignored = false;
  }
  return ignored;
};

export const loadGitIgnoreMatcher = (
  root: string,
): Effect.Effect<GitIgnoreMatcher, RepositoryError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const normalizedRoot = normalizePath(root);
    const rules: Array<IgnoreRules> = [];
    const pending = [normalizedRoot];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      const ignorePath = joinPath(directory, ".gitignore");
      const hasIgnoreFile = yield* fileSystem
        .exists(ignorePath)
        .pipe(
          Effect.mapError(
            (error) =>
              new RepositoryError({ path: ignorePath, message: error.message }),
          ),
        );
      if (hasIgnoreFile) {
        const source = yield* fileSystem.readText(ignorePath).pipe(
          Effect.mapError(
            (error) =>
              new RepositoryError({
                path: ignorePath,
                message: error.message,
              }),
          ),
        );
        rules.push({ directory, matcher: ignore().add(source) });
      }
      const entries = yield* fileSystem
        .list(directory)
        .pipe(
          Effect.mapError(
            (error) =>
              new RepositoryError({ path: directory, message: error.message }),
          ),
        );
      for (const entry of entries) {
        if (
          entry.kind !== "directory" ||
          traversalIgnoredDirectories.has(entry.name)
        ) {
          continue;
        }
        const path = joinPath(directory, entry.name);
        if (!matchesRules(normalizedRoot, rules, path, true))
          pending.push(path);
      }
    }
    return {
      ignores: (path, directory = false) =>
        matchesRules(normalizedRoot, rules, path, directory),
    };
  });
