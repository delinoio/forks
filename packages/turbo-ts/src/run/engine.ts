import { Effect, Fiber, Queue } from "effect";
import {
  type CacheWriteEntry,
  evictLocalCache,
  restoreLocalCache,
  writeLocalCache,
} from "../cache/local-cache.js";
import {
  type RemoteCacheOptions,
  restoreRemoteCache,
  writeRemoteCache,
} from "../cache/remote-cache.js";
import {
  type LoadedRootConfiguration,
  loadRootConfiguration,
} from "../config/runtime.js";
import { matchesGlob, selectByGlobs } from "../core/glob.js";
import {
  isAbsolutePath,
  joinPath,
  normalizePath,
  parentPath,
  relativePath,
} from "../core/path.js";
import { ConfigurationError, RepositoryError } from "../effect/errors.js";
import {
  ClockService,
  CompressionService,
  ConcurrencyService,
  DigestService,
  EnvironmentService,
  FileSystemService,
  HttpService,
  ProcessService,
  RandomnessService,
  RetryScheduleService,
  SigningService,
  TerminalService,
} from "../effect/services.js";
import type { OutputLogs } from "../generated/configuration.js";
import {
  buildTaskGraph,
  selectPackages,
  type TaskGraph,
  type TaskNode,
  topologicalOrder,
} from "../graph/task-graph.js";
import {
  effectiveTaskInputs,
  hashTask,
  type TaskHashResult,
  taskEnvironment,
} from "../hash/task-hash.js";
import { xxhash64Hex } from "../hash/xxhash64.js";
import { renderLogEvent } from "../logging/events.js";
import {
  discoverRepository,
  listRepositoryFiles,
  type RepositoryModel,
} from "../repository/model.js";
import { type ParsedRunOptions, parseConcurrency } from "./options.js";

interface CachePolicy {
  readonly localRead: boolean;
  readonly localWrite: boolean;
  readonly remoteRead: boolean;
  readonly remoteWrite: boolean;
}

export const parseCacheSpecification = (
  specification: string,
  path = "<arguments>",
): CachePolicy => {
  let policy: CachePolicy = {
    localRead: false,
    localWrite: false,
    remoteRead: false,
    remoteWrite: false,
  };
  for (const entry of specification.split(",")) {
    const match = /^(local|remote):(r|w|rw)$/.exec(entry);
    if (match === null) {
      throw new ConfigurationError({
        path,
        message: `invalid cache specification: ${specification}`,
      });
    }
    const [, source, operations] = match;
    const read = operations === "r" || operations === "rw";
    const write = operations === "w" || operations === "rw";
    policy =
      source === "local"
        ? { ...policy, localRead: read, localWrite: write }
        : { ...policy, remoteRead: read, remoteWrite: write };
  }
  return policy;
};

interface ResolvedRunOptions {
  readonly root: string;
  readonly tasks: ReadonlyArray<string>;
  readonly passThroughArguments: ReadonlyArray<string>;
  readonly filters: ReadonlyArray<string>;
  readonly affected: boolean;
  readonly concurrency: number;
  readonly continueMode: "always" | "dependencies-successful" | "never";
  readonly environmentMode: "loose" | "strict";
  readonly cacheDirectory: string;
  readonly cacheMaxAgeMilliseconds?: number;
  readonly cacheMaxSizeBytes?: number;
  readonly cachePolicy: CachePolicy;
  readonly force: boolean;
  readonly frameworkInference: boolean;
  readonly outputLogs?: OutputLogs;
  readonly only: boolean;
  readonly parallel: boolean;
  readonly remote?: RemoteCacheOptions;
  readonly colorEnabled: boolean;
}

interface TaskOutcome {
  readonly id: string;
  readonly exitCode: number;
  readonly hash?: string;
  readonly skipped: boolean;
}

type RunRequirements =
  | ClockService
  | CompressionService
  | ConcurrencyService
  | DigestService
  | EnvironmentService
  | FileSystemService
  | HttpService
  | ProcessService
  | RandomnessService
  | RetryScheduleService
  | SigningService
  | TerminalService;

const environmentBoolean = (value: string | undefined): boolean | undefined =>
  value === undefined
    ? undefined
    : value === "1" || value.toLowerCase() === "true";

const parseQuantity = (
  value: string | null | undefined,
  units: Readonly<Record<string, number>>,
): number | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]+)?$/.exec(value.trim());
  const unit = match?.[2]?.toLowerCase() ?? "";
  const multiplier = units[unit];
  if (match === null || multiplier === undefined) {
    throw new ConfigurationError({
      path: "turbo.json",
      message: `invalid quantity: ${value}`,
    });
  }
  const quantity = Math.floor(Number(match[1]) * multiplier);
  return quantity === 0 ? undefined : quantity;
};

const parseCachePolicy = (
  parsed: ParsedRunOptions,
  environment: Readonly<Record<string, string | undefined>>,
): CachePolicy => {
  let policy: CachePolicy = {
    localRead: true,
    localWrite: true,
    remoteRead: true,
    remoteWrite: true,
  };
  const specification = parsed.cacheSpecification ?? environment.TURBO_CACHE;
  if (specification !== undefined) {
    policy = parseCacheSpecification(
      specification,
      parsed.cacheSpecification === undefined ? "TURBO_CACHE" : "<arguments>",
    );
  }
  if (
    parsed.remoteOnly ||
    environmentBoolean(environment.TURBO_REMOTE_ONLY) === true
  ) {
    policy = { ...policy, localRead: false, localWrite: false };
  }
  if (
    parsed.remoteCacheReadOnly ||
    environmentBoolean(environment.TURBO_REMOTE_CACHE_READ_ONLY) === true
  ) {
    policy = { ...policy, remoteWrite: false };
  }
  if (parsed.noCache) {
    return {
      localRead: false,
      localWrite: false,
      remoteRead: false,
      remoteWrite: false,
    };
  }
  return policy;
};

const repositoryRootMarkers = [
  ".git",
  "aube.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "nub.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "uv.lock",
  "yarn.lock",
] as const;

export const discoverRepositoryRoot = (
  start: string,
): Effect.Effect<string, RepositoryError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    let current = normalizePath(start);
    let nearestPackage: string | undefined;
    while (true) {
      const packagePath = joinPath(current, "package.json");
      const hasPackage = yield* fileSystem.exists(packagePath).pipe(
        Effect.mapError(
          (error) =>
            new RepositoryError({
              path: packagePath,
              message: error.message,
            }),
        ),
      );
      if (hasPackage) {
        nearestPackage ??= current;
        const markerResults = yield* Effect.all(
          repositoryRootMarkers.map((marker) =>
            fileSystem.exists(joinPath(current, marker)),
          ),
        ).pipe(
          Effect.mapError(
            (error) =>
              new RepositoryError({ path: current, message: error.message }),
          ),
        );
        const hasMarker = markerResults.some(Boolean);
        let hasWorkspaces = false;
        if (!hasMarker) {
          const source = yield* fileSystem.readText(packagePath).pipe(
            Effect.mapError(
              (error) =>
                new RepositoryError({
                  path: packagePath,
                  message: error.message,
                }),
            ),
          );
          try {
            const manifest = JSON.parse(source) as {
              readonly workspaces?: unknown;
            };
            hasWorkspaces = manifest.workspaces !== undefined;
          } catch {
            // Configuration loading reports malformed root manifests after
            // discovery; a malformed nested manifest is not a root marker.
          }
        }
        if (hasMarker || hasWorkspaces) {
          return current;
        }
      }
      const parent = parentPath(current);
      if (parent === current) {
        return nearestPackage ?? normalizePath(start);
      }
      current = parent;
    }
  });

const resolveOptions = (
  parsed: ParsedRunOptions,
  root: string,
  environment: Readonly<Record<string, string | undefined>>,
  configuration: LoadedRootConfiguration,
  availableParallelism: number,
): ResolvedRunOptions => {
  const value = configuration.value;
  const global = value.global;
  const concurrency =
    parsed.concurrency ??
    environment.TURBO_CONCURRENCY ??
    value.concurrency ??
    global?.concurrency ??
    undefined;
  const environmentModeValue =
    parsed.environmentMode ??
    (environment.TURBO_ENV_MODE === "loose"
      ? "loose"
      : environment.TURBO_ENV_MODE === "strict"
        ? "strict"
        : undefined) ??
    value.envMode ??
    global?.envMode ??
    "strict";
  const cacheDirectoryValue =
    parsed.cacheDirectory ??
    environment.TURBO_CACHE_DIR ??
    value.cacheDir ??
    global?.cacheDir ??
    ".turbo/cache";
  const remoteConfiguration = value.remoteCache ?? global?.remoteCache;
  const apiUrl =
    parsed.apiUrl ??
    environment.TURBO_API ??
    remoteConfiguration?.apiUrl ??
    undefined;
  const token = parsed.token ?? environment.TURBO_TOKEN;
  const signatureKey = environment.TURBO_REMOTE_CACHE_SIGNATURE_KEY;
  const remoteTimeoutSeconds =
    parsed.remoteCacheTimeoutSeconds ??
    Number(
      environment.TURBO_REMOTE_CACHE_TIMEOUT ??
        remoteConfiguration?.timeout ??
        30,
    );
  const remoteUploadTimeoutSeconds =
    parsed.remoteCacheTimeoutSeconds ??
    Number(
      environment.TURBO_REMOTE_CACHE_UPLOAD_TIMEOUT ??
        remoteConfiguration?.uploadTimeout ??
        remoteConfiguration?.timeout ??
        30,
    );
  if (
    value.futureFlags?.longerSignatureKey === true &&
    remoteConfiguration?.signature === true &&
    (signatureKey?.length ?? 0) < 32
  ) {
    throw new ConfigurationError({
      path: configuration.path,
      message:
        "TURBO_REMOTE_CACHE_SIGNATURE_KEY must contain at least 32 characters",
    });
  }
  const remote =
    apiUrl === undefined || remoteConfiguration?.enabled === false
      ? undefined
      : {
          apiUrl,
          token,
          teamId:
            environment.TURBO_TEAMID ??
            remoteConfiguration?.teamId ??
            undefined,
          teamSlug:
            parsed.team ??
            environment.TURBO_TEAM ??
            remoteConfiguration?.teamSlug ??
            undefined,
          timeoutMilliseconds: 1_000 * remoteTimeoutSeconds,
          uploadTimeoutMilliseconds: 1_000 * remoteUploadTimeoutSeconds,
          preflight:
            parsed.preflight || remoteConfiguration?.preflight === true,
          signatureKey,
          requireSignature: remoteConfiguration?.signature === true,
        };
  return {
    root,
    tasks: parsed.tasks,
    passThroughArguments: parsed.passThroughArguments,
    filters: parsed.filters,
    affected: parsed.affected,
    concurrency: parseConcurrency(
      concurrency ?? undefined,
      availableParallelism,
    ),
    continueMode: parsed.continueMode ?? "never",
    environmentMode: environmentModeValue,
    cacheDirectory: isAbsolutePath(cacheDirectoryValue)
      ? cacheDirectoryValue
      : joinPath(root, cacheDirectoryValue),
    cacheMaxAgeMilliseconds: parseQuantity(
      value.cacheMaxAge ?? global?.cacheMaxAge,
      {
        "": 1,
        ms: 1,
        s: 1_000,
        m: 60_000,
        h: 3_600_000,
        d: 86_400_000,
        w: 604_800_000,
      },
    ),
    cacheMaxSizeBytes: parseQuantity(
      value.cacheMaxSize ?? global?.cacheMaxSize,
      {
        "": 1,
        b: 1,
        kb: 1_000,
        mb: 1_000_000,
        gb: 1_000_000_000,
        kib: 1_024,
        mib: 1_048_576,
        gib: 1_073_741_824,
      },
    ),
    cachePolicy: parseCachePolicy(parsed, environment),
    force: parsed.force || environmentBoolean(environment.TURBO_FORCE) === true,
    frameworkInference: parsed.frameworkInference ?? true,
    outputLogs: parsed.outputLogs,
    only: parsed.only,
    parallel: parsed.parallel,
    remote,
    colorEnabled: !parsed.noColor && environment.NO_COLOR === undefined,
  };
};

interface GitRange {
  readonly source: string;
  readonly base: string;
  readonly head: string;
}

interface AffectedPackages {
  readonly packages: ReadonlySet<string>;
  readonly changedFiles: ReadonlyArray<string>;
  readonly rootChanged: boolean;
}

const parseGitRange = (selector: string): GitRange => {
  const separator = selector.indexOf("...");
  const base = separator === -1 ? selector : selector.slice(0, separator);
  const head = separator === -1 ? "HEAD" : selector.slice(separator + 3);
  if (base === "" || head === "") {
    throw new ConfigurationError({
      path: "<arguments>",
      message: `invalid Git range filter: [${selector}]`,
    });
  }
  return { source: selector, base, head };
};

const gitRangeSelector = (rawFilter: string): string | undefined => {
  let filter = rawFilter.startsWith("!") ? rawFilter.slice(1) : rawFilter;
  if (filter.startsWith("...")) {
    filter = filter.slice(3);
  }
  if (filter.endsWith("...")) {
    filter = filter.slice(0, -3);
  }
  return filter.startsWith("[") && filter.endsWith("]")
    ? filter.slice(1, -1)
    : undefined;
};

const findAffectedPackages = (
  repository: RepositoryModel,
  environment: Readonly<Record<string, string | undefined>>,
  range?: GitRange,
): Effect.Effect<AffectedPackages, ConfigurationError, ProcessService> =>
  Effect.gen(function* () {
    const processService = yield* ProcessService;
    const explicitBase = environment.TURBO_SCM_BASE;
    const githubBase = environment.GITHUB_BASE_REF;
    const base = range?.base ?? explicitBase ?? githubBase ?? "main";
    const head = range?.head ?? environment.TURBO_SCM_HEAD ?? "HEAD";
    const diff = (baseReference: string) =>
      Effect.either(
        Effect.scoped(
          processService.run({
            command: "git",
            args: [
              "diff",
              "--no-renames",
              "--name-only",
              `${baseReference}...${head}`,
            ],
            cwd: repository.root,
          }),
        ),
      );
    let result = yield* diff(base);
    if (
      (result._tag === "Left" || result.right.exitCode !== 0) &&
      range === undefined &&
      explicitBase === undefined &&
      githubBase !== undefined &&
      repository.rootConfiguration.value.futureFlags
        ?.githubActionsRemoteBaseRefFallback === true
    ) {
      result = yield* diff(`origin/${githubBase}`);
    }
    if (result._tag === "Left" || result.right.exitCode !== 0) {
      if (range !== undefined) {
        const detail =
          result._tag === "Left"
            ? result.left.message
            : result.right.stderr.trim();
        return yield* Effect.fail(
          new ConfigurationError({
            path: "<arguments>",
            message: `invalid Git range filter: [${range.source}]${
              detail === "" ? "" : `: ${detail}`
            }`,
          }),
        );
      }
      return {
        packages: new Set(
          repository.packages.map((packageModel) => packageModel.name),
        ),
        changedFiles: [],
        rootChanged: true,
      };
    }
    const changedFiles = result.right.stdout.split(/\r?\n/).filter(Boolean);
    const globalDependencyPatterns =
      repository.rootConfiguration.value.futureFlags?.globalConfiguration ===
      true
        ? []
        : (repository.rootConfiguration.value.globalDependencies ?? []);
    const rootChanged =
      selectByGlobs(changedFiles, globalDependencyPatterns).length > 0 ||
      changedFiles.some(
        (path) =>
          !repository.packages.some((packageModel) =>
            path.startsWith(`${packageModel.relativeDirectory}/`),
          ),
      );
    return {
      packages: rootChanged
        ? new Set(repository.packages.map((packageModel) => packageModel.name))
        : new Set(
            repository.packages
              .filter((packageModel) =>
                changedFiles.some((path) =>
                  path.startsWith(`${packageModel.relativeDirectory}/`),
                ),
              )
              .map((packageModel) => packageModel.name),
          ),
      changedFiles,
      rootChanged,
    };
  });

const defaultAffectedSelector = "$TURBO_DEFAULT_AFFECTED$";

const resolveAffectedPackages = (
  repository: RepositoryModel,
  options: ResolvedRunOptions,
  environment: Readonly<Record<string, string | undefined>>,
): Effect.Effect<
  {
    readonly filters: ReadonlyArray<string>;
    readonly ranges: ReadonlyMap<string, ReadonlySet<string>>;
    readonly affectedBySelector: ReadonlyMap<string, AffectedPackages>;
    readonly hasGitRangeFilter: boolean;
  },
  ConfigurationError,
  ProcessService
> =>
  Effect.gen(function* () {
    const ranges = new Map<string, ReadonlySet<string>>();
    const affectedBySelector = new Map<string, AffectedPackages>();
    const selectors = [
      ...new Set(
        options.filters.flatMap((filter) => {
          const selector = gitRangeSelector(filter);
          return selector === undefined ? [] : [selector];
        }),
      ),
    ];
    for (const selector of selectors) {
      const affected = yield* findAffectedPackages(
        repository,
        environment,
        parseGitRange(selector),
      );
      ranges.set(selector, affected.packages);
      affectedBySelector.set(selector, affected);
    }
    if (options.affected) {
      const affected = yield* findAffectedPackages(repository, environment);
      ranges.set(defaultAffectedSelector, affected.packages);
      affectedBySelector.set(defaultAffectedSelector, affected);
    }
    return {
      filters: options.affected
        ? [...options.filters, `...[${defaultAffectedSelector}]`]
        : options.filters,
      ranges,
      affectedBySelector,
      hasGitRangeFilter: selectors.length > 0,
    };
  });

const taskMatchesChangedFiles = (
  repository: RepositoryModel,
  node: TaskNode,
  changedFiles: ReadonlyArray<string>,
): boolean => {
  const rootRelativeInputPrefix = "$TURBO_ROOT$/";
  const isRootPackage = node.package.relativeDirectory === ".";
  const packagePrefix = isRootPackage
    ? ""
    : `${node.package.relativeDirectory}/`;
  const inputs = effectiveTaskInputs(repository, node);
  return changedFiles.some((repositoryRelativeFile) => {
    const packageRelativeFile = isRootPackage
      ? repositoryRelativeFile
      : repositoryRelativeFile.startsWith(packagePrefix)
        ? repositoryRelativeFile.slice(packagePrefix.length)
        : undefined;
    const matchesInput = (pattern: string): boolean => {
      const rootRelative = pattern.startsWith(rootRelativeInputPrefix);
      const file = rootRelative ? repositoryRelativeFile : packageRelativeFile;
      return (
        file !== undefined &&
        matchesGlob(
          file,
          rootRelative
            ? pattern.slice(rootRelativeInputPrefix.length)
            : pattern,
        )
      );
    };
    let selected = false;
    for (const input of inputs) {
      if (typeof input !== "string") {
        if (input.withDefaults !== false && packageRelativeFile !== undefined) {
          selected = true;
        }
        if ((input.globs ?? []).some(matchesInput)) {
          selected = true;
        }
      } else if (input === "$TURBO_DEFAULT$") {
        if (packageRelativeFile !== undefined) selected = true;
      } else if (input.startsWith("!")) {
        if (matchesInput(input.slice(1))) selected = false;
      } else if (matchesInput(input)) {
        selected = true;
      }
    }
    return selected;
  });
};

const affectedTaskEntrypoints = (
  repository: RepositoryModel,
  graph: TaskGraph,
  changedFiles: ReadonlyArray<string>,
  rootChanged: boolean,
): ReadonlySet<string> => {
  if (rootChanged) return new Set(graph.entrypoints);
  const entrypointUsesChangedInput = (id: string): boolean => {
    const visited = new Set<string>();
    const pending = [id];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const node = graph.nodes.get(current);
      if (node === undefined) continue;
      if (taskMatchesChangedFiles(repository, node, changedFiles)) return true;
      pending.push(...node.dependencies, ...node.with);
    }
    return false;
  };
  return new Set(graph.entrypoints.filter(entrypointUsesChangedInput));
};

const retainTaskEntrypoints = (
  graph: TaskGraph,
  entrypoints: ReadonlySet<string>,
): TaskGraph => {
  const retained = new Set(entrypoints);
  const pending = [...retained];
  while (pending.length > 0) {
    const node = graph.nodes.get(pending.pop()!);
    for (const adjacent of [
      ...(node?.dependencies ?? []),
      ...(node?.with ?? []),
    ]) {
      if (!retained.has(adjacent)) {
        retained.add(adjacent);
        pending.push(adjacent);
      }
    }
  }
  return {
    entrypoints: graph.entrypoints.filter((id) => entrypoints.has(id)),
    nodes: new Map([...graph.nodes].filter(([id]) => retained.has(id))),
  };
};

const selectAffectedTasks = (
  repository: RepositoryModel,
  graph: TaskGraph,
  filters: ReadonlyArray<string>,
  affectedBySelector: ReadonlyMap<string, AffectedPackages>,
): TaskGraph => {
  const rangeFilters = filters.flatMap((filter) => {
    const selector = gitRangeSelector(filter);
    const affected =
      selector === undefined ? undefined : affectedBySelector.get(selector);
    return selector === undefined || affected === undefined
      ? []
      : [{ filter, affected }];
  });
  const positiveFilters = rangeFilters.filter(
    ({ filter }) => !filter.startsWith("!"),
  );
  const retainedEntrypoints = new Set(
    positiveFilters.length === 0 ? graph.entrypoints : [],
  );
  for (const { affected } of positiveFilters) {
    for (const id of affectedTaskEntrypoints(
      repository,
      graph,
      affected.changedFiles,
      affected.rootChanged,
    )) {
      retainedEntrypoints.add(id);
    }
  }
  for (const { affected } of rangeFilters.filter(({ filter }) =>
    filter.startsWith("!"),
  )) {
    for (const id of affectedTaskEntrypoints(
      repository,
      graph,
      affected.changedFiles,
      affected.rootChanged,
    )) {
      retainedEntrypoints.delete(id);
    }
  }
  return retainTaskEntrypoints(graph, retainedEntrypoints);
};

export type TaskCommandScope =
  | { readonly kind: "package" }
  | {
      readonly kind: "cargo-workspace";
      readonly directory: string;
      readonly members: ReadonlyArray<TaskNode>;
    };

const packageTaskCommandScope = { kind: "package" } as const;

export const packageManagerCommand = (
  node: TaskNode,
  passThroughArguments: ReadonlyArray<string>,
  scope: TaskCommandScope = packageTaskCommandScope,
): {
  readonly command: string;
  readonly arguments: ReadonlyArray<string>;
  readonly cwd: string;
} => {
  switch (node.package.manager) {
    case "yarn":
    case "bun":
    case "aube":
    case "nub":
      return {
        command: node.package.manager,
        arguments: ["run", node.task, ...passThroughArguments],
        cwd: node.package.directory,
      };
    case "cargo": {
      const cargoTask =
        node.task === "lint"
          ? "clippy"
          : node.task === "format"
            ? "fmt"
            : node.task === "dev"
              ? "run"
              : node.task;
      const locked = cargoTask === "fmt" ? [] : ["--locked"];
      const target =
        scope.kind === "cargo-workspace"
          ? cargoTask === "fmt"
            ? ["--all"]
            : ["--workspace"]
          : [`--package=${node.package.name}`];
      return {
        command: "cargo",
        arguments: [cargoTask, ...target, ...locked, ...passThroughArguments],
        cwd:
          scope.kind === "cargo-workspace"
            ? scope.directory
            : node.package.directory,
      };
    }
    case "uv":
      if (node.task === "build") {
        return {
          command: "uv",
          arguments: [
            "build",
            `--package=${node.package.name}`,
            ...passThroughArguments,
          ],
          cwd: node.package.directory,
        };
      }
      if (node.task === "format") {
        return {
          command: "uv",
          arguments: ["format", ...passThroughArguments, "--", "."],
          cwd: node.package.directory,
        };
      }
      if (node.task === "check") {
        return {
          command: "uv",
          arguments: [
            "check",
            "--frozen",
            `--package=${node.package.name}`,
            ...passThroughArguments,
          ],
          cwd: node.package.directory,
        };
      }
      return {
        command: "uv",
        arguments: [
          "run",
          "--frozen",
          "--package",
          node.package.name,
          "pytest",
          ...passThroughArguments,
          ".",
        ],
        cwd: node.package.directory,
      };
    case "npm":
    case "pnpm":
      return {
        command: node.package.manager,
        arguments:
          passThroughArguments.length === 0
            ? ["run", node.task]
            : ["run", node.task, "--", ...passThroughArguments],
        cwd: node.package.directory,
      };
  }
};

const collectOutputPaths = (
  repository: RepositoryModel,
  nodes: ReadonlyArray<TaskNode>,
): Effect.Effect<ReadonlyArray<string>, RepositoryError, FileSystemService> =>
  Effect.gen(function* () {
    const selected = new Set<string>();
    const rootOutputPrefix = "$TURBO_ROOT$/";
    const collectOutputs = (
      directory: string,
      patterns: ReadonlyArray<string>,
    ): Effect.Effect<void, RepositoryError, FileSystemService> =>
      Effect.gen(function* () {
        const files = yield* listRepositoryFiles(directory, {
          ignoredDirectories: new Set([".git", ".turbo", "node_modules"]),
        });
        for (const path of files) {
          const relative = relativePath(directory, path);
          if (
            patterns.some(
              (pattern) =>
                !pattern.startsWith("!") && matchesGlob(relative, pattern),
            ) &&
            !patterns.some(
              (pattern) =>
                pattern.startsWith("!") &&
                matchesGlob(relative, pattern.slice(1)),
            )
          ) {
            selected.add(path);
          }
        }
      });
    for (const node of nodes) {
      const outputPatterns = node.definition.outputs ?? [];
      const packagePatterns = outputPatterns.filter(
        (pattern) => !pattern.replace(/^!/, "").startsWith(rootOutputPrefix),
      );
      const rootPatterns = outputPatterns.flatMap((pattern) => {
        const negative = pattern.startsWith("!");
        const value = negative ? pattern.slice(1) : pattern;
        return value.startsWith(rootOutputPrefix)
          ? [`${negative ? "!" : ""}${value.slice(rootOutputPrefix.length)}`]
          : [];
      });
      if (packagePatterns.length > 0) {
        yield* collectOutputs(node.package.directory, packagePatterns);
      }
      if (rootPatterns.length > 0) {
        yield* collectOutputs(repository.root, rootPatterns);
      }
    }
    return [...selected].sort();
  });

const collectCacheEntries = (
  repository: RepositoryModel,
  nodes: ReadonlyArray<TaskNode>,
  logPath: string,
): Effect.Effect<
  ReadonlyArray<CacheWriteEntry>,
  RepositoryError,
  FileSystemService
> =>
  Effect.gen(function* () {
    const selected = [
      ...new Set([logPath, ...(yield* collectOutputPaths(repository, nodes))]),
    ].sort();
    const fileSystem = yield* FileSystemService;
    return yield* Effect.forEach(
      selected,
      (path) =>
        Effect.gen(function* () {
          const metadata = yield* fileSystem
            .metadata(path)
            .pipe(
              Effect.mapError(
                (error) =>
                  new RepositoryError({ path, message: error.message }),
              ),
            );
          const common = {
            path: relativePath(repository.root, path),
            mode: metadata.mode,
            modifiedSeconds: metadata.modifiedMilliseconds / 1_000,
          };
          if (metadata.kind === "symlink") {
            const linkTarget = yield* fileSystem
              .readLink(path)
              .pipe(
                Effect.mapError(
                  (error) =>
                    new RepositoryError({ path, message: error.message }),
                ),
              );
            return {
              ...common,
              kind: "symlink" as const,
              linkTarget,
              contents: new Uint8Array(),
            };
          }
          const contents = yield* fileSystem
            .readBytes(path)
            .pipe(
              Effect.mapError(
                (error) =>
                  new RepositoryError({ path, message: error.message }),
              ),
            );
          return { ...common, contents };
        }),
      { concurrency: 8 },
    );
  });

const shouldReplayOutput = (
  mode: OutputLogs | undefined,
  cacheHit: boolean,
): boolean =>
  mode === undefined || mode === "full" || (mode === "new-only" && !cacheHit);

type TaskOutputQueueEvent =
  | { readonly kind: "chunk"; readonly output: string }
  | { readonly kind: "end" };

const cargoAlternateOutputFlags = [
  "--artifact-dir",
  "--out-dir",
  "--profile",
  "--target",
  "--target-dir",
] as const;

const usesAlternateCargoBuildOutputs = (
  node: TaskNode,
  passThroughArguments: ReadonlyArray<string>,
): boolean =>
  node.package.manager === "cargo" &&
  node.task === "build" &&
  passThroughArguments.some(
    (argument) =>
      argument === "--release" ||
      argument === "-r" ||
      cargoAlternateOutputFlags.some(
        (flag) => argument === flag || argument.startsWith(`${flag}=`),
      ),
  );

export const isTaskScopeCacheable = (
  node: TaskNode,
  passThroughArguments: ReadonlyArray<string>,
  scope: TaskCommandScope = packageTaskCommandScope,
): boolean =>
  (scope.kind === "cargo-workspace" ? scope.members : [node]).every(
    (member) => member.definition.cache !== false,
  ) && !usesAlternateCargoBuildOutputs(node, passThroughArguments);

const executeTask = (
  repository: RepositoryModel,
  node: TaskNode,
  options: ResolvedRunOptions,
  hash: TaskHashResult,
  sourceEnvironment: Readonly<Record<string, string | undefined>>,
  scope: TaskCommandScope = packageTaskCommandScope,
): Effect.Effect<TaskOutcome, unknown, RunRequirements> =>
  Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const fileSystem = yield* FileSystemService;
    const clock = yield* ClockService;
    const color =
      options.outputLogs === "none" || !options.colorEnabled
        ? false
        : yield* terminal.stdoutColorEnabled;
    const warningColor = options.colorEnabled
      ? yield* terminal.stderrColorEnabled
      : false;
    if (node.command === undefined) {
      return { id: node.id, exitCode: 0, hash: hash.hash, skipped: false };
    }
    const taskLabel = `${node.package.name}:${node.task}`;
    const outputMode =
      options.outputLogs ?? node.definition.outputLogs ?? undefined;
    const showHashEvent =
      outputMode !== "errors-only" ||
      repository.rootConfiguration.value.futureFlags?.errorsOnlyShowHash ===
        true;
    const cacheNodes =
      scope.kind === "cargo-workspace" ? scope.members : [node];
    const cacheable = isTaskScopeCacheable(
      node,
      options.passThroughArguments,
      scope,
    );
    const localOptions = {
      directory: options.cacheDirectory,
      maxAgeMilliseconds: options.cacheMaxAgeMilliseconds,
      maxSizeBytes: options.cacheMaxSizeBytes,
    };
    const pathsToClear =
      cacheable &&
      !options.force &&
      (options.cachePolicy.localRead || options.cachePolicy.remoteRead)
        ? (yield* collectOutputPaths(repository, cacheNodes)).map((path) =>
            relativePath(repository.root, path),
          )
        : [];
    let cacheHit = false;
    if (cacheable && !options.force && options.cachePolicy.localRead) {
      cacheHit = yield* restoreLocalCache(
        repository.root,
        localOptions,
        hash.hash,
        pathsToClear,
      );
    }
    if (
      !cacheHit &&
      cacheable &&
      !options.force &&
      options.cachePolicy.remoteRead &&
      options.remote !== undefined
    ) {
      cacheHit = yield* restoreRemoteCache(
        repository.root,
        options.remote,
        hash.hash,
        pathsToClear,
      ).pipe(
        Effect.catchAll((error) =>
          terminal
            .writeStderr(
              renderLogEvent(
                {
                  kind: "warning",
                  message: `remote cache restore failed for ${taskLabel}; executing task locally: ${error.message}`,
                },
                warningColor,
              ),
            )
            .pipe(Effect.ignore, Effect.as(false)),
        ),
      );
    }
    const executionDirectory =
      scope.kind === "cargo-workspace"
        ? scope.directory
        : node.package.directory;
    const logPath = joinPath(
      executionDirectory,
      ".turbo",
      `turbo-${node.task}.log`,
    );
    if (cacheHit) {
      if (outputMode !== "none" && showHashEvent) {
        yield* terminal.writeStdout(
          renderLogEvent(
            { kind: "cache-hit", task: taskLabel, hash: hash.hash },
            color,
          ),
        );
      }
      if (
        shouldReplayOutput(
          options.outputLogs ?? node.definition.outputLogs ?? undefined,
          true,
        )
      ) {
        const hasLog = yield* fileSystem.exists(logPath);
        if (hasLog) {
          yield* terminal.writeStdout(
            renderLogEvent(
              {
                kind: "task-output",
                task: taskLabel,
                output: yield* fileSystem.readText(logPath),
              },
              color,
            ),
          );
        }
      }
      return { id: node.id, exitCode: 0, hash: hash.hash, skipped: false };
    }
    if (outputMode !== "none" && showHashEvent) {
      yield* terminal.writeStdout(
        renderLogEvent(
          { kind: "cache-miss", task: taskLabel, hash: hash.hash },
          color,
        ),
      );
    }
    const started = yield* clock.now;
    const invocation = packageManagerCommand(
      node,
      options.passThroughArguments,
      scope,
    );
    const processService = yield* ProcessService;
    const startProcess = (onOutputChunk?: (chunk: string) => void) =>
      processService.run({
        command: invocation.command,
        args: invocation.arguments,
        cwd: invocation.cwd,
        inheritEnvironment: false,
        stdio: node.definition.interactive === true ? "inherit" : "capture",
        onOutputChunk,
        env: {
          ...taskEnvironment(
            repository,
            node,
            sourceEnvironment,
            options.environmentMode,
            options.frameworkInference,
          ),
          TURBO_HASH: hash.hash,
        },
      });
    const streamsPersistentOutput =
      node.definition.persistent === true &&
      node.definition.interactive !== true;
    const displaysPersistentOutput =
      streamsPersistentOutput && shouldReplayOutput(outputMode, false);
    const result = streamsPersistentOutput
      ? yield* Effect.scoped(
          Effect.gen(function* () {
            yield* fileSystem.makeDirectory(
              joinPath(executionDirectory, ".turbo"),
            );
            yield* fileSystem.writeText(logPath, "");
            const outputQueue = yield* Queue.unbounded<TaskOutputQueueEvent>();
            yield* Effect.addFinalizer(() => Queue.shutdown(outputQueue));
            const outputFiber = yield* Effect.forkScoped(
              Effect.gen(function* () {
                let pendingDisplay = "";
                while (true) {
                  const event = yield* Queue.take(outputQueue);
                  if (event.kind === "end") {
                    if (displaysPersistentOutput && pendingDisplay !== "") {
                      yield* terminal.writeStdout(
                        renderLogEvent(
                          {
                            kind: "task-output",
                            task: taskLabel,
                            output: pendingDisplay,
                          },
                          color,
                        ),
                      );
                    }
                    return;
                  }
                  yield* fileSystem.appendText(logPath, event.output);
                  if (!displaysPersistentOutput) continue;
                  pendingDisplay += event.output;
                  const lastLineBreak = pendingDisplay.lastIndexOf("\n");
                  if (lastLineBreak === -1) continue;
                  const completeLines = pendingDisplay.slice(
                    0,
                    lastLineBreak + 1,
                  );
                  pendingDisplay = pendingDisplay.slice(lastLineBreak + 1);
                  yield* terminal.writeStdout(
                    renderLogEvent(
                      {
                        kind: "task-output",
                        task: taskLabel,
                        output: completeLines,
                      },
                      color,
                    ),
                  );
                }
              }),
            );
            const processResult = yield* Effect.raceFirst(
              startProcess((output) => {
                Queue.unsafeOffer(outputQueue, { kind: "chunk", output });
              }),
              Fiber.join(outputFiber).pipe(Effect.flatMap(() => Effect.never)),
            );
            yield* Queue.offer(outputQueue, { kind: "end" });
            yield* Fiber.join(outputFiber);
            return processResult;
          }),
        )
      : yield* Effect.scoped(startProcess());
    const output = result.combinedOutput;
    if (!streamsPersistentOutput) {
      yield* fileSystem.makeDirectory(joinPath(executionDirectory, ".turbo"));
      yield* fileSystem.writeText(logPath, output);
    }
    if (
      (!displaysPersistentOutput && shouldReplayOutput(outputMode, false)) ||
      (outputMode === "errors-only" && result.exitCode !== 0)
    ) {
      yield* terminal.writeStdout(
        renderLogEvent({ kind: "task-output", task: taskLabel, output }, color),
      );
    }
    if (result.exitCode !== 0) {
      return {
        id: node.id,
        exitCode: result.exitCode,
        hash: hash.hash,
        skipped: false,
      };
    }
    if (
      cacheable &&
      (options.cachePolicy.localWrite || options.cachePolicy.remoteWrite)
    ) {
      const entries = yield* collectCacheEntries(
        repository,
        cacheNodes,
        logPath,
      );
      const duration = (yield* clock.now) - started;
      if (options.cachePolicy.localWrite) {
        yield* writeLocalCache(localOptions, hash.hash, entries, duration);
      }
      if (options.cachePolicy.remoteWrite && options.remote !== undefined) {
        yield* writeRemoteCache(options.remote, hash.hash, entries, duration);
      }
    }
    return { id: node.id, exitCode: 0, hash: hash.hash, skipped: false };
  });

const computeTaskHashes = (
  repository: RepositoryModel,
  graph: TaskGraph,
  options: ResolvedRunOptions,
): Effect.Effect<
  ReadonlyMap<string, TaskHashResult>,
  RepositoryError,
  FileSystemService | EnvironmentService | DigestService | ProcessService
> =>
  Effect.gen(function* () {
    const hashes = new Map<string, TaskHashResult>();
    const hashGraph: TaskGraph = {
      ...graph,
      nodes: new Map(
        [...graph.nodes].map(([id, node]) => [
          id,
          {
            ...node,
            dependencies: [...new Set([...node.dependencies, ...node.with])],
          },
        ]),
      ),
    };
    for (const id of topologicalOrder(hashGraph)) {
      const node = graph.nodes.get(id)!;
      const upstreamIds = [
        ...new Set([...node.dependencies, ...node.with]),
      ].sort();
      const result = yield* hashTask(
        repository,
        node,
        upstreamIds.map((upstream) => hashes.get(upstream)!.hash),
        options.frameworkInference,
        options.passThroughArguments,
        options.cacheDirectory,
      );
      hashes.set(id, result);
    }
    return hashes;
  });

const cargoWorkspaceVerificationTasks = new Set([
  "check",
  "format",
  "lint",
  "test",
]);

export interface CargoWorkspaceTaskPlan {
  readonly graph: TaskGraph;
  readonly scopes: ReadonlyMap<string, TaskCommandScope>;
}

export const planCargoWorkspaceTasks = (
  graph: TaskGraph,
  requestedTasks: ReadonlyArray<string>,
  unfiltered: boolean,
): CargoWorkspaceTaskPlan => {
  const eligibleTasks = new Set(
    requestedTasks.filter(
      (task) =>
        !task.includes("#") && cargoWorkspaceVerificationTasks.has(task),
    ),
  );
  if (!unfiltered || eligibleTasks.size === 0) {
    return { graph, scopes: new Map() };
  }
  const grouped = new Map<string, Array<TaskNode>>();
  for (const id of graph.entrypoints) {
    const node = graph.nodes.get(id)!;
    if (node.package.manager !== "cargo" || !eligibleTasks.has(node.task)) {
      continue;
    }
    const workspaceDirectory =
      node.package.workspaceDirectory ?? node.package.directory;
    const key = `${workspaceDirectory}\0${node.task}`;
    const members = grouped.get(key) ?? [];
    members.push(node);
    grouped.set(key, members);
  }
  const aliases = new Map<string, string>();
  const scopes = new Map<string, TaskCommandScope>();
  for (const members of grouped.values()) {
    members.sort((left, right) => left.id.localeCompare(right.id));
    const representative = members[0]!;
    for (const member of members) aliases.set(member.id, representative.id);
    scopes.set(representative.id, {
      kind: "cargo-workspace",
      directory:
        representative.package.workspaceDirectory ??
        representative.package.directory,
      members,
    });
  }
  const nodes = new Map<string, TaskNode>();
  for (const [id, node] of graph.nodes) {
    const canonicalId = aliases.get(id) ?? id;
    if (canonicalId !== id) continue;
    const scope = scopes.get(id);
    const sourceNodes =
      scope?.kind === "cargo-workspace" ? scope.members : [node];
    const adjacent = (select: (source: TaskNode) => ReadonlyArray<string>) =>
      [
        ...new Set(
          sourceNodes
            .flatMap(select)
            .map((target) => aliases.get(target) ?? target)
            .filter((target) => target !== id),
        ),
      ].sort();
    nodes.set(id, {
      ...node,
      dependencies: adjacent((source) => source.dependencies),
      with: adjacent((source) => source.with),
    });
  }
  return {
    graph: {
      nodes,
      entrypoints: [
        ...new Set(
          graph.entrypoints.map(
            (entrypoint) => aliases.get(entrypoint) ?? entrypoint,
          ),
        ),
      ].sort(),
    },
    scopes,
  };
};

const applyCargoWorkspaceHashes = (
  hashes: ReadonlyMap<string, TaskHashResult>,
  scopes: ReadonlyMap<string, TaskCommandScope>,
): ReadonlyMap<string, TaskHashResult> => {
  const combined = new Map(hashes);
  for (const [id, scope] of scopes) {
    if (scope.kind !== "cargo-workspace") continue;
    const representative = hashes.get(id)!;
    const members = scope.members.map((member) => {
      const result = hashes.get(member.id)!;
      return [member.id, result.hash] as const;
    });
    combined.set(id, {
      ...representative,
      hash: cargoWorkspaceHash(members),
      inputFiles: [
        ...new Set(
          scope.members.flatMap(
            (member) => hashes.get(member.id)?.inputFiles ?? [],
          ),
        ),
      ].sort(),
    });
  }
  return combined;
};

export const cargoWorkspaceHash = (
  members: ReadonlyArray<readonly [string, string]>,
): string =>
  xxhash64Hex(
    JSON.stringify({
      scope: "cargo-workspace",
      members: [...members].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    }),
  );

const taskGroups = (graph: TaskGraph): ReadonlyArray<ReadonlyArray<string>> => {
  const reverseWith = new Map<string, Array<string>>();
  for (const node of graph.nodes.values()) {
    for (const companion of node.with) {
      const owners = reverseWith.get(companion) ?? [];
      owners.push(node.id);
      reverseWith.set(companion, owners);
    }
  }
  const groups: Array<ReadonlyArray<string>> = [];
  const visited = new Set<string>();
  for (const start of [...graph.nodes.keys()].sort()) {
    if (visited.has(start)) continue;
    const members = new Set<string>();
    const pending = [start];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (members.has(id)) continue;
      members.add(id);
      visited.add(id);
      const node = graph.nodes.get(id);
      pending.push(...(node?.with ?? []), ...(reverseWith.get(id) ?? []));
    }
    groups.push([...members].sort());
  }
  return groups;
};

export const executeRun = (
  parsed: ParsedRunOptions,
): Effect.Effect<number, unknown, RunRequirements> =>
  Effect.gen(function* () {
    const environmentService = yield* EnvironmentService;
    const concurrencyService = yield* ConcurrencyService;
    const processCwd = yield* environmentService.cwd;
    const environment = yield* environmentService.entries;
    const requestedRoot =
      parsed.cwd === undefined
        ? undefined
        : isAbsolutePath(parsed.cwd)
          ? parsed.cwd
          : joinPath(processCwd, parsed.cwd);
    const preliminaryRoot = yield* discoverRepositoryRoot(
      requestedRoot ?? processCwd,
    );
    const configuration = yield* loadRootConfiguration(
      preliminaryRoot,
      parsed.rootTurboJson === undefined
        ? undefined
        : isAbsolutePath(parsed.rootTurboJson)
          ? parsed.rootTurboJson
          : joinPath(preliminaryRoot, parsed.rootTurboJson),
    );
    const availableParallelism = yield* concurrencyService.availableParallelism;
    const options = resolveOptions(
      parsed,
      preliminaryRoot,
      environment,
      configuration,
      availableParallelism,
    );
    yield* evictLocalCache({
      directory: options.cacheDirectory,
      maxAgeMilliseconds: options.cacheMaxAgeMilliseconds,
      maxSizeBytes: options.cacheMaxSizeBytes,
    });
    const repository = yield* discoverRepository(options.root, configuration);
    const packageManagerCheckDisabled =
      parsed.dangerouslyDisablePackageManagerCheck ||
      environmentBoolean(
        environment.TURBO_DANGEROUSLY_DISABLE_PACKAGE_MANAGER_CHECK,
      ) === true ||
      configuration.value.dangerouslyDisablePackageManagerCheck === true ||
      configuration.value.global?.dangerouslyDisablePackageManagerCheck ===
        true;
    if (
      repository.rootManifest.packageManager === undefined &&
      repository.rootManifest.devEngines?.packageManager?.name === undefined &&
      !packageManagerCheckDisabled
    ) {
      return yield* Effect.fail(
        new ConfigurationError({
          path: joinPath(options.root, "package.json"),
          message:
            "packageManager must be declared unless the package-manager check is disabled",
        }),
      );
    }
    const affected = yield* resolveAffectedPackages(
      repository,
      options,
      environment,
    );
    const flags = repository.rootConfiguration.value.futureFlags;
    const useTaskInputs =
      (options.affected && flags?.affectedUsingTaskInputs === true) ||
      (affected.hasGitRangeFilter && flags?.filterUsingTasks === true);
    const packageFilters = useTaskInputs
      ? affected.filters.filter(
          (filter) => gitRangeSelector(filter) === undefined,
        )
      : affected.filters;
    const packages = selectPackages(
      repository,
      packageFilters,
      affected.ranges,
    );
    const unfilteredGraph = buildTaskGraph(
      repository,
      packages,
      options.tasks,
      options.only,
      flags?.strictTaskEntrypointSelection === true,
    );
    const entrypointIds = new Set(unfilteredGraph.entrypoints);
    const entrypointTasks = new Set(
      unfilteredGraph.entrypoints.map(
        (entrypoint) => unfilteredGraph.nodes.get(entrypoint)!.task,
      ),
    );
    const unresolvedTasks = [
      ...new Set(
        options.tasks.filter((task) =>
          task.startsWith("//#") || task.includes("#")
            ? !entrypointIds.has(task)
            : !entrypointTasks.has(task),
        ),
      ),
    ];
    if (unresolvedTasks.length > 0) {
      return yield* Effect.fail(
        new RepositoryError({
          path: options.root,
          message: `task not found: ${unresolvedTasks.join(", ")}`,
        }),
      );
    }
    const selectedGraph = useTaskInputs
      ? selectAffectedTasks(
          repository,
          unfilteredGraph,
          affected.filters,
          affected.affectedBySelector,
        )
      : unfilteredGraph;
    const cargoWorkspacePlan = planCargoWorkspaceTasks(
      selectedGraph,
      options.tasks,
      affected.filters.length === 0,
    );
    const graph = cargoWorkspacePlan.graph;
    const hashes = applyCargoWorkspaceHashes(
      yield* computeTaskHashes(repository, selectedGraph, options),
      cargoWorkspacePlan.scopes,
    );
    const groups = taskGroups(graph);
    const pending = new Map(groups.map((members) => [members[0]!, members]));
    const outcomes = new Map<string, TaskOutcome>();
    while (pending.size > 0) {
      const ready = [...pending.entries()]
        .filter(([, members]) => {
          const memberSet = new Set(members);
          return (
            options.parallel ||
            members.every((id) =>
              graph.nodes
                .get(id)!
                .dependencies.filter((dependency) => !memberSet.has(dependency))
                .every((dependency) => outcomes.has(dependency)),
            )
          );
        })
        .sort(([left], [right]) => left.localeCompare(right));
      if (ready.length === 0) {
        throw new RepositoryError({
          path: options.root,
          message: "scheduler deadlock",
        });
      }
      const batch = ready.slice(0, options.concurrency);
      const groupedResults = yield* Effect.forEach(
        batch,
        ([, members]): Effect.Effect<
          ReadonlyArray<TaskOutcome>,
          never,
          RunRequirements
        > => {
          const memberSet = new Set(members);
          const groupOutcomes = new Map<string, TaskOutcome>();
          const runNode = (
            id: string,
          ): Effect.Effect<TaskOutcome, never, RunRequirements> => {
            const node = graph.nodes.get(id)!;
            const dependencyFailed = node.dependencies.some((dependency) => {
              const outcome =
                groupOutcomes.get(dependency) ?? outcomes.get(dependency);
              return (
                outcome !== undefined &&
                (outcome.exitCode !== 0 || outcome.skipped)
              );
            });
            if (
              !options.parallel &&
              dependencyFailed &&
              options.continueMode !== "always"
            ) {
              return Effect.succeed({
                id,
                exitCode: 1,
                skipped: true,
              });
            }
            return executeTask(
              repository,
              node,
              options,
              hashes.get(id)!,
              environment,
              cargoWorkspacePlan.scopes.get(id),
            ).pipe(
              Effect.catchAll((cause) =>
                Effect.gen(function* () {
                  const terminal = yield* TerminalService;
                  yield* terminal
                    .writeStderr(`turbo-ts: ${String(cause)}\n`)
                    .pipe(Effect.ignore);
                  return {
                    id,
                    exitCode: 1,
                    skipped: false,
                  } satisfies TaskOutcome;
                }),
              ),
            );
          };
          const targets = new Set(
            members.flatMap((id) => graph.nodes.get(id)!.with),
          );
          const background = members.filter(
            (id) =>
              targets.has(id) &&
              graph.nodes.get(id)!.definition.persistent === true,
          );
          const foreground = members.filter((id) => !background.includes(id));
          return Effect.scoped(
            Effect.gen(function* () {
              const backgroundFibers = yield* Effect.forEach(background, (id) =>
                Effect.forkScoped(runNode(id)),
              );
              if (background.length > 0) yield* Effect.yieldNow();
              const foregroundCompletion = Effect.gen(function* () {
                const remaining = new Set(foreground);
                const results: Array<TaskOutcome> = [];
                while (remaining.size > 0) {
                  const readyForeground = [...remaining].filter(
                    (id) =>
                      options.parallel ||
                      graph.nodes
                        .get(id)!
                        .dependencies.filter((dependency) =>
                          memberSet.has(dependency),
                        )
                        .every((dependency) => groupOutcomes.has(dependency)),
                  );
                  if (readyForeground.length === 0) {
                    throw new RepositoryError({
                      path: options.root,
                      message: "scheduler deadlock inside with group",
                    });
                  }
                  const completed = yield* Effect.forEach(
                    readyForeground,
                    runNode,
                    { concurrency: "unbounded" },
                  );
                  for (const outcome of completed) {
                    remaining.delete(outcome.id);
                    groupOutcomes.set(outcome.id, outcome);
                    results.push(outcome);
                  }
                }
                return results;
              }).pipe(
                Effect.map((results) => ({
                  _tag: "ForegroundComplete" as const,
                  results,
                })),
              );
              if (backgroundFibers.length === 0) {
                return (yield* foregroundCompletion).results;
              }
              const backgroundFailures = backgroundFibers.map((fiber) =>
                Fiber.join(fiber).pipe(
                  Effect.map((outcome) => ({
                    _tag: "BackgroundFailed" as const,
                    outcome:
                      outcome.exitCode === 0
                        ? { ...outcome, exitCode: 1 }
                        : outcome,
                  })),
                ),
              );
              const firstBackgroundFailure = backgroundFailures
                .slice(1)
                .reduce(
                  (left, right) => Effect.race(left, right),
                  backgroundFailures[0]!,
                );
              const completion = yield* Effect.race(
                foregroundCompletion,
                firstBackgroundFailure,
              );
              if (completion._tag === "BackgroundFailed") {
                return members.map((id) =>
                  id === completion.outcome.id
                    ? completion.outcome
                    : {
                        id,
                        exitCode: 1,
                        skipped: true,
                      },
                );
              }
              return [
                ...completion.results,
                ...background.map((id) => ({
                  id,
                  exitCode: 0,
                  hash: hashes.get(id)!.hash,
                  skipped: false,
                })),
              ];
            }),
          );
        },
        { concurrency: options.concurrency },
      );
      const results = groupedResults.flat();
      for (const [groupId] of batch) pending.delete(groupId);
      for (const result of results) {
        outcomes.set(result.id, result);
      }
      if (
        options.continueMode === "never" &&
        results.some((result) => result.exitCode !== 0)
      ) {
        break;
      }
    }
    return [...outcomes.values()].some((outcome) => outcome.exitCode !== 0)
      ? 1
      : 0;
  });
