import { Effect, HashMap, Ref, Stream } from "effect";
import {
  canMatchGlobsDescendantWithExclusions,
  matchesGlobsWithExclusions,
} from "../core/glob.js";
import {
  baseName,
  isAbsolutePath,
  isPathContained,
  joinPath,
  normalizePath,
  parentPath,
  relativePath,
} from "../core/path.js";
import { ConfigurationError } from "../effect/errors.js";
import {
  ConcurrencyService,
  EnvironmentService,
  FileSystemService,
  FileWatcherService,
  TerminalService,
} from "../effect/services.js";
import {
  type GitIgnoreMatcher,
  loadGitIgnoreMatcher,
} from "../repository/git-ignore.js";
import type { RepositoryModel } from "../repository/model.js";
import {
  canonicalExistingAncestorPath,
  executeRun,
  type RunRequirements,
  resolveOptions,
} from "../run/engine.js";
import { type ParsedRunOptions, parseRunArguments } from "../run/options.js";
import { isDefaultProfileArtifactName } from "../run/profile.js";
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
  return { writeCache, run: parsed };
};

export const resolvedWatchRunOptions = (
  options: WatchOptions,
  repository: RepositoryModel,
  environment: Readonly<Record<string, string | undefined>>,
  availableParallelism: number,
  windowsPathSeparators: boolean,
): ParsedRunOptions => {
  if (options.writeCache) return options.run;
  const policy = resolveOptions(
    options.run,
    repository.root,
    environment,
    repository.rootConfiguration,
    availableParallelism,
    windowsPathSeparators,
  ).cachePolicy;
  const readableSources = [
    ...(policy.localRead ? ["local:r"] : []),
    ...(policy.remoteRead ? ["remote:r"] : []),
  ];
  return {
    ...options.run,
    cacheSpecification:
      readableSources.length === 0 ? undefined : readableSources.join(","),
    noCache: options.run.noCache || readableSources.length === 0,
  };
};

const configuredOutputPath = (
  repository: RepositoryModel,
  path: string,
  entryKind: "directory" | "file" | "symlink" | "other" | undefined,
): boolean => {
  const rootOutputPrefix = "$TURBO_ROOT$/";
  const matchesOutput = (
    directory: string,
    patterns: ReadonlyArray<string>,
  ): boolean => {
    if (!isPathContained(directory, path)) return false;
    const relative = relativePath(directory, path);
    return (
      matchesGlobsWithExclusions([relative], patterns) ||
      (entryKind === "directory" &&
        canMatchGlobsDescendantWithExclusions(relative, patterns))
    );
  };
  return [repository.rootPackage, ...repository.packages].some((packageModel) =>
    Object.values(packageModel.tasks).some((task) => {
      const outputs = task.outputs ?? [];
      const packagePatterns = outputs.filter(
        (pattern) => !pattern.replace(/^!/, "").startsWith(rootOutputPrefix),
      );
      const rootPatterns = outputs.flatMap((pattern) => {
        const negative = pattern.startsWith("!");
        const value = negative ? pattern.slice(1) : pattern;
        return value.startsWith(rootOutputPrefix)
          ? [`${negative ? "!" : ""}${value.slice(rootOutputPrefix.length)}`]
          : [];
      });
      return (
        matchesOutput(packageModel.directory, packagePatterns) ||
        matchesOutput(repository.root, rootPatterns)
      );
    }),
  );
};

export const runOwnedPath = (
  repository: RepositoryModel,
  options: ParsedRunOptions,
  path: string,
  environment: Readonly<Record<string, string | undefined>>,
  availableParallelism: number,
  windowsPathSeparators: boolean,
): Effect.Effect<boolean, ConfigurationError, FileSystemService> =>
  Effect.gen(function* () {
    const resolved = resolveOptions(
      options,
      repository.root,
      environment,
      repository.rootConfiguration,
      availableParallelism,
      windowsPathSeparators,
    );
    const ordinaryRun =
      options.graph === undefined && options.dryRun === undefined;
    const resolveArtifactPath = (requested: string | undefined) =>
      requested === undefined || requested === ""
        ? undefined
        : normalizePath(
            isAbsolutePath(requested, windowsPathSeparators)
              ? requested
              : joinPath(repository.root, requested),
            windowsPathSeparators,
          );
    const exactPaths = [
      options.graph === undefined || options.graph === ""
        ? undefined
        : resolveArtifactPath(options.graph),
      ordinaryRun ? resolveArtifactPath(options.logFile) : undefined,
      ordinaryRun ? resolveArtifactPath(options.profile) : undefined,
      ordinaryRun ? resolveArtifactPath(options.anonymousProfile) : undefined,
      ordinaryRun ? resolveArtifactPath(options.heap) : undefined,
      ordinaryRun ? resolveArtifactPath(options.trace) : undefined,
    ].filter((candidate): candidate is string => candidate !== undefined);
    const normalizedPath = normalizePath(path, windowsPathSeparators);
    const comparablePath = (candidate: string): string => {
      const normalized = normalizePath(candidate, windowsPathSeparators);
      return windowsPathSeparators ? normalized.toLowerCase() : normalized;
    };
    const comparableBaseName = (candidate: string): string => {
      const name = baseName(candidate, windowsPathSeparators);
      return windowsPathSeparators ? name.toLowerCase() : name;
    };
    const pathContains = (root: string, candidate: string): boolean => {
      const rootIdentity = comparablePath(root).replace(/\/$/, "");
      const candidateIdentity = comparablePath(candidate);
      return (
        candidateIdentity === rootIdentity ||
        candidateIdentity.startsWith(`${rootIdentity}/`)
      );
    };
    const matchesArtifactPath = (
      exactPath: string,
      observedPath: string,
    ): boolean => {
      const exactName = comparableBaseName(exactPath);
      const observedName = comparableBaseName(observedPath);
      return (
        comparablePath(exactPath) === comparablePath(observedPath) ||
        (comparablePath(parentPath(exactPath, windowsPathSeparators)) ===
          comparablePath(parentPath(observedPath, windowsPathSeparators)) &&
          observedName.startsWith(`${exactName}.`) &&
          observedName.endsWith(".tmp"))
      );
    };
    if (exactPaths.some((exactPath) => matchesArtifactPath(exactPath, path))) {
      return true;
    }
    if (exactPaths.length > 0) {
      const canonicalObservedPath = yield* canonicalExistingAncestorPath(
        normalizedPath,
        "watch event",
      );
      const canonicalArtifactPaths = yield* Effect.forEach(
        exactPaths,
        (exactPath) => canonicalExistingAncestorPath(exactPath, "run artifact"),
        { concurrency: 8 },
      );
      const observedAlias =
        comparablePath(normalizedPath) !==
        comparablePath(canonicalObservedPath);
      if (
        canonicalArtifactPaths.some(
          (canonicalArtifactPath, index) =>
            matchesArtifactPath(canonicalArtifactPath, canonicalObservedPath) ||
            (observedAlias &&
              pathContains(normalizedPath, exactPaths[index]!) &&
              pathContains(canonicalObservedPath, canonicalArtifactPath)),
        )
      ) {
        return true;
      }
    }
    const writesDefaultProfile =
      ordinaryRun &&
      [options.profile, options.anonymousProfile, options.trace].includes("");
    if (
      writesDefaultProfile &&
      comparablePath(parentPath(normalizedPath, windowsPathSeparators)) ===
        comparablePath(repository.root) &&
      isDefaultProfileArtifactName(comparableBaseName(normalizedPath))
    ) {
      return true;
    }
    if (!ordinaryRun || !resolved.cachePolicy.localWrite) return false;
    const canonicalCacheDirectory = yield* canonicalExistingAncestorPath(
      resolved.cacheDirectory,
    );
    return [resolved.cacheDirectory, canonicalCacheDirectory].some(
      (cacheDirectory) =>
        isPathContained(
          normalizePath(cacheDirectory, windowsPathSeparators),
          normalizedPath,
          windowsPathSeparators,
        ),
    );
  });

interface PendingWatchChange {
  readonly sequence: number;
  readonly path: string;
}

interface PendingWatchInvalidation {
  readonly earliestSequence: number;
  readonly latestSequence: number;
}

export interface PendingWatchChanges {
  readonly nextSequence: number;
  readonly changesByPath: HashMap.HashMap<string, PendingWatchChange>;
  readonly invalidation?: PendingWatchInvalidation;
}

export const initialPendingWatchChanges = (): PendingWatchChanges => ({
  nextSequence: 0,
  changesByPath: HashMap.empty(),
});

export const appendPendingWatchChange = (
  pending: PendingWatchChanges,
  path: string,
  invalidateAll: boolean,
): readonly [number, PendingWatchChanges] => {
  const sequence = pending.nextSequence;
  return [
    sequence,
    {
      nextSequence: sequence + 1,
      changesByPath: HashMap.set(pending.changesByPath, path, {
        sequence,
        path,
      }),
      invalidation: invalidateAll
        ? {
            earliestSequence:
              pending.invalidation?.earliestSequence ?? sequence,
            latestSequence: sequence,
          }
        : pending.invalidation,
    },
  ];
};

export const takePendingWatchChanges = (
  pending: PendingWatchChanges,
  throughSequence: number,
): readonly [
  { readonly paths: ReadonlyArray<string>; readonly invalidateAll: boolean },
  PendingWatchChanges,
] => {
  const included: Array<PendingWatchChange> = [];
  let changesByPath = HashMap.empty<string, PendingWatchChange>();
  for (const change of HashMap.values(pending.changesByPath)) {
    if (change.sequence <= throughSequence) {
      included.push(change);
    } else {
      changesByPath = HashMap.set(changesByPath, change.path, change);
    }
  }
  included.sort((left, right) => left.sequence - right.sequence);
  const invalidateAll =
    pending.invalidation !== undefined &&
    pending.invalidation.earliestSequence <= throughSequence;
  const invalidation =
    pending.invalidation === undefined ||
    pending.invalidation.latestSequence <= throughSequence
      ? undefined
      : pending.invalidation.earliestSequence > throughSequence
        ? pending.invalidation
        : {
            earliestSequence: pending.invalidation.latestSequence,
            latestSequence: pending.invalidation.latestSequence,
          };
  return [
    { paths: included.map((change) => change.path), invalidateAll },
    { ...pending, changesByPath, invalidation },
  ];
};

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
    const environmentService = yield* EnvironmentService;
    const concurrencyService = yield* ConcurrencyService;
    const environment = yield* environmentService.entries;
    const platform = yield* environmentService.platform;
    const availableParallelism = yield* concurrencyService.availableParallelism;
    const windowsPathSeparators = platform === "win32";
    const repository = yield* loadWorkflowRepository({
      cwd: options.run.cwd,
      rootTurboJson: options.run.rootTurboJson,
      singlePackage: options.run.singlePackage,
    });
    const repositoryRef = yield* Ref.make(repository);
    const ignoreMatcher = yield* Ref.make<GitIgnoreMatcher>(
      yield* loadGitIgnoreMatcher(repository.root),
    );
    const pendingChanges = yield* Ref.make(initialPendingWatchChanges());
    const activeRuns = yield* Ref.make(0);
    const observedDirectories = yield* Ref.make<ReadonlySet<string>>(new Set());
    const comparableWatchPath = (path: string): string => {
      const normalized = normalizePath(path, windowsPathSeparators);
      return windowsPathSeparators ? normalized.toLowerCase() : normalized;
    };
    const absoluteRootTurboJson =
      options.run.rootTurboJson === undefined
        ? undefined
        : isAbsolutePath(options.run.rootTurboJson)
          ? options.run.rootTurboJson
          : joinPath(repository.root, options.run.rootTurboJson);
    const externalConfigurationChanges =
      absoluteRootTurboJson !== undefined &&
      !isPathContained(repository.root, absoluteRootTurboJson)
        ? watcher.watch(parentPath(absoluteRootTurboJson)).pipe(
            Stream.filter(
              (change) =>
                change.kind === "unknown" ||
                normalizePath(change.path) ===
                  normalizePath(absoluteRootTurboJson),
            ),
            Stream.map((change) =>
              change.kind === "unknown"
                ? { ...change, path: absoluteRootTurboJson }
                : change,
            ),
          )
        : Stream.empty;
    const watchedChanges = Stream.merge(
      watcher.watch(repository.root),
      externalConfigurationChanges,
    );
    const changes = watchedChanges.pipe(
      Stream.filterEffect((change) =>
        Effect.gen(function* () {
          const isExternalRootTurboJsonChange =
            absoluteRootTurboJson !== undefined &&
            normalizePath(change.path) === normalizePath(absoluteRootTurboJson);
          if (
            !isExternalRootTurboJsonChange &&
            isInternalRepositoryPath(repository.root, change.path)
          ) {
            return false;
          }
          if (change.kind === "unknown") {
            const refreshed = yield* Effect.either(
              loadWorkflowRepository({
                cwd: options.run.cwd,
                rootTurboJson: options.run.rootTurboJson,
                singlePackage: options.run.singlePackage,
              }),
            );
            if (refreshed._tag === "Right") {
              yield* Ref.set(repositoryRef, refreshed.right);
            }
            yield* Ref.set(
              ignoreMatcher,
              yield* loadGitIgnoreMatcher(repository.root),
            );
            yield* Ref.set(observedDirectories, new Set());
            return true;
          }
          const currentRepository = yield* Ref.get(repositoryRef);
          const currentIgnoreMatcher = yield* Ref.get(ignoreMatcher);
          const changeIdentity = comparableWatchPath(change.path);
          const wasObservedDirectory = (yield* Ref.get(
            observedDirectories,
          )).has(changeIdentity);
          const entryIsDirectory =
            change.entryKind === "directory" ||
            (change.kind === "remove" &&
              (wasObservedDirectory ||
                currentIgnoreMatcher.wasDirectory(change.path)));
          yield* Ref.update(observedDirectories, (current) => {
            const updated = new Set(current);
            if (
              change.kind === "remove" ||
              (change.entryKind !== undefined &&
                change.entryKind !== "directory")
            ) {
              updated.delete(changeIdentity);
            } else if (change.entryKind === "directory") {
              updated.add(changeIdentity);
            }
            return updated;
          });
          const currentRunOptions = resolvedWatchRunOptions(
            options,
            currentRepository,
            environment,
            availableParallelism,
            windowsPathSeparators,
          );
          const isRunOwnedPath = yield* runOwnedPath(
            currentRepository,
            currentRunOptions,
            change.path,
            environment,
            availableParallelism,
            windowsPathSeparators,
          );
          const isConfiguredOutputPath = configuredOutputPath(
            currentRepository,
            change.path,
            entryIsDirectory ? "directory" : change.entryKind,
          );
          if (isGitIgnorePath(change.path)) {
            yield* Ref.set(
              ignoreMatcher,
              yield* loadGitIgnoreMatcher(repository.root),
            );
            return (
              !isRunOwnedPath &&
              (!isConfiguredOutputPath || (yield* Ref.get(activeRuns)) === 0)
            );
          }
          if (isRunOwnedPath) return false;
          const ignored = currentIgnoreMatcher.ignores(
            change.path,
            entryIsDirectory,
          );
          if (ignored || isConfiguredOutputPath) {
            return false;
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
                singlePackage: options.run.singlePackage,
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
        Ref.modify(pendingChanges, (pending) =>
          appendPendingWatchChange(
            pending,
            change.path,
            change.kind === "unknown",
          ),
        ),
      ),
      Stream.debounce("100 millis"),
      Stream.mapEffect((sequence) =>
        Ref.modify(pendingChanges, (pending) =>
          takePendingWatchChanges(pending, sequence),
        ),
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
              const currentRepository = yield* Ref.get(repositoryRef);
              const currentRunOptions = resolvedWatchRunOptions(
                options,
                currentRepository,
                environment,
                availableParallelism,
                windowsPathSeparators,
              );
              return yield* Effect.acquireUseRelease(
                Ref.update(activeRuns, (count) => count + 1),
                () =>
                  executeRun(
                    currentRunOptions,
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
                  ),
                () => Ref.update(activeRuns, (count) => Math.max(0, count - 1)),
              );
            }),
          ),
        { concurrency: "unbounded", switch: true },
      ),
      Stream.runDrain,
    );
    return 0;
  });
