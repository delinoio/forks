import { Effect, Ref, Stream } from "effect";
import {
  canMatchGlobDescendant,
  matchesGlobsWithExclusions,
} from "../core/glob.js";
import {
  baseName,
  isAbsolutePath,
  isPathContained,
  joinPath,
  normalizePath,
  relativePath,
} from "../core/path.js";
import { FileWatcherService, TerminalService } from "../effect/services.js";
import {
  type GitIgnoreMatcher,
  loadGitIgnoreMatcher,
} from "../repository/git-ignore.js";
import type { RepositoryModel } from "../repository/model.js";
import {
  executeRun,
  parseCacheSpecification,
  type RunRequirements,
} from "../run/engine.js";
import { type ParsedRunOptions, parseRunArguments } from "../run/options.js";
import {
  isInternalRepositoryPath,
  loadWorkflowRepository,
} from "./repository.js";

export interface WatchOptions {
  readonly run: ParsedRunOptions;
  readonly writeCache: boolean;
}

export const parseWatchArguments = (
  arguments_: ReadonlyArray<string>,
): WatchOptions => {
  const delimiter = arguments_.indexOf("--");
  const optionArguments =
    delimiter === -1 ? arguments_ : arguments_.slice(0, delimiter);
  const passThroughArguments =
    delimiter === -1 ? [] : arguments_.slice(delimiter);
  const writeCache = optionArguments.includes("--experimental-write-cache");
  const runArguments = [
    ...optionArguments.filter(
      (argument) => argument !== "--experimental-write-cache",
    ),
    ...passThroughArguments,
  ];
  const parsed = parseRunArguments(["run", ...runArguments]);
  const readOnlyPolicy = parseCacheSpecification(
    parsed.cacheSpecification ?? "local:r,remote:r",
  );
  const readableSources = [
    ...(readOnlyPolicy.localRead ? ["local:r"] : []),
    ...(readOnlyPolicy.remoteRead ? ["remote:r"] : []),
  ];
  return {
    writeCache,
    run: writeCache
      ? parsed
      : {
          ...parsed,
          cacheSpecification:
            readableSources.length === 0
              ? undefined
              : readableSources.join(","),
          noCache: parsed.noCache || readableSources.length === 0,
        },
  };
};

const configuredOutputPath = (
  repository: RepositoryModel,
  path: string,
  entryKind: "directory" | "file" | "symlink" | "other" | undefined,
): boolean =>
  [repository.rootPackage, ...repository.packages].some((packageModel) => {
    if (!isPathContained(packageModel.directory, path)) return false;
    const relative = relativePath(packageModel.directory, path);
    return Object.values(packageModel.tasks).some((task) => {
      const outputs = task.outputs ?? [];
      return (
        matchesGlobsWithExclusions([relative], outputs) ||
        (entryKind === "directory" &&
          outputs.some(
            (output) =>
              !output.startsWith("!") &&
              canMatchGlobDescendant(relative, output),
          ))
      );
    });
  });

interface PendingWatchChange {
  readonly sequence: number;
  readonly path: string;
  readonly invalidateAll: boolean;
}

interface PendingWatchChanges {
  readonly nextSequence: number;
  readonly changes: ReadonlyArray<PendingWatchChange>;
}

const isGitIgnorePath = (path: string): boolean =>
  normalizePath(path).split("/").at(-1) === ".gitignore";

const isTurboConfigurationPath = (
  root: string,
  configuredRootPath: string | undefined,
  path: string,
): boolean => {
  if (["turbo.json", "turbo.jsonc"].includes(baseName(path))) return true;
  if (configuredRootPath === undefined) return false;
  const absoluteConfiguredPath = isAbsolutePath(configuredRootPath)
    ? configuredRootPath
    : joinPath(root, configuredRootPath);
  return normalizePath(path) === normalizePath(absoluteConfiguredPath);
};

const workspaceManifestNames = new Set([
  "Cargo.toml",
  "package.json",
  "pyproject.toml",
]);

const isWorkspaceDiscoveryPath = (root: string, path: string): boolean =>
  workspaceManifestNames.has(baseName(path)) ||
  normalizePath(path) === normalizePath(joinPath(root, "pnpm-workspace.yaml"));

export const executeWatch = (
  options: WatchOptions,
): Effect.Effect<number, unknown, FileWatcherService | RunRequirements> =>
  Effect.gen(function* () {
    const watcher = yield* FileWatcherService;
    const terminal = yield* TerminalService;
    const repository = yield* loadWorkflowRepository({
      cwd: options.run.cwd,
      rootTurboJson: options.run.rootTurboJson,
    });
    const repositoryRef = yield* Ref.make(repository);
    const ignoreMatcher = yield* Ref.make<GitIgnoreMatcher>(
      yield* loadGitIgnoreMatcher(repository.root),
    );
    const pendingChanges = yield* Ref.make<PendingWatchChanges>({
      nextSequence: 0,
      changes: [],
    });
    const changes = watcher.watch(repository.root).pipe(
      Stream.filterEffect((change) =>
        Effect.gen(function* () {
          if (isInternalRepositoryPath(repository.root, change.path)) {
            return false;
          }
          if (change.kind === "unknown") {
            const refreshed = yield* Effect.either(
              loadWorkflowRepository({
                cwd: options.run.cwd,
                rootTurboJson: options.run.rootTurboJson,
              }),
            );
            if (refreshed._tag === "Right") {
              yield* Ref.set(repositoryRef, refreshed.right);
            }
            yield* Ref.set(
              ignoreMatcher,
              yield* loadGitIgnoreMatcher(repository.root),
            );
            return true;
          }
          const currentRepository = yield* Ref.get(repositoryRef);
          const ignored = (yield* Ref.get(ignoreMatcher)).ignores(
            change.path,
            change.entryKind === "directory",
          );
          if (
            ignored ||
            configuredOutputPath(
              currentRepository,
              change.path,
              change.entryKind,
            )
          ) {
            return false;
          }
          if (isGitIgnorePath(change.path)) {
            yield* Ref.set(
              ignoreMatcher,
              yield* loadGitIgnoreMatcher(repository.root),
            );
            return true;
          }
          if (
            isWorkspaceDiscoveryPath(repository.root, change.path) ||
            isTurboConfigurationPath(
              repository.root,
              options.run.rootTurboJson,
              change.path,
            )
          ) {
            const refreshed = yield* Effect.either(
              loadWorkflowRepository({
                cwd: options.run.cwd,
                rootTurboJson: options.run.rootTurboJson,
              }),
            );
            if (refreshed._tag === "Right") {
              yield* Ref.set(repositoryRef, refreshed.right);
            }
            return true;
          }
          return true;
        }),
      ),
      Stream.mapEffect((change) =>
        Ref.modify(pendingChanges, (pending) => {
          const sequence = pending.nextSequence;
          return [
            sequence,
            {
              nextSequence: sequence + 1,
              changes: [
                ...pending.changes,
                {
                  sequence,
                  path: change.path,
                  invalidateAll: change.kind === "unknown",
                },
              ],
            },
          ] as const;
        }),
      ),
      Stream.debounce("100 millis"),
      Stream.mapEffect((sequence) =>
        Ref.modify(pendingChanges, (pending) => {
          const included = pending.changes.filter(
            (change) => change.sequence <= sequence,
          );
          return [
            {
              paths: [...new Set(included.map((change) => change.path))],
              invalidateAll: included.some((change) => change.invalidateAll),
            },
            {
              ...pending,
              changes: pending.changes.filter(
                (change) => change.sequence > sequence,
              ),
            },
          ] as const;
        }),
      ),
    );
    const triggers = Stream.concat(
      Stream.succeed({
        paths: [] satisfies ReadonlyArray<string>,
        invalidateAll: false,
      }),
      changes,
    );
    yield* triggers.pipe(
      Stream.flatMap(
        ({ paths, invalidateAll }) =>
          Stream.fromEffect(
            Effect.gen(function* () {
              if (invalidateAll) {
                yield* terminal.writeStdout(
                  "\n• change detected: repository-wide invalidation\n",
                );
              } else if (paths.length > 0) {
                yield* terminal.writeStdout(
                  `\n• change detected: ${paths.join(", ")}\n`,
                );
              }
              return yield* executeRun(
                options.run,
                paths.length === 0 || invalidateAll
                  ? {}
                  : { changedPaths: paths },
              ).pipe(
                Effect.catchAll((cause) =>
                  terminal
                    .writeStderr(
                      `turbo-ts: watch run failed: ${String(cause)}\n`,
                    )
                    .pipe(Effect.as(1)),
                ),
              );
            }),
          ),
        { concurrency: "unbounded", switch: true },
      ),
      Stream.runDrain,
    );
    return 0;
  });
