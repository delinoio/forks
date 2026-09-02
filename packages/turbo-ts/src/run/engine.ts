import { Effect, Fiber, Queue, Stream } from "effect";
import { maximumCacheArchiveInputBytes } from "../cache/archive.js";
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
  type CacheRestoreScope,
  validateArchiveEntriesForRestore,
} from "../cache/restore.js";
import {
  type LoadedRootConfiguration,
  loadRootConfiguration,
} from "../config/runtime.js";
import {
  canMatchGlobDescendant,
  matchesGlob,
  matchesGlobsWithExclusions,
  selectByGlobs,
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
  decodeNullDelimitedGitOutput,
  effectiveTaskInputs,
  hashTask,
  implicitTaskInputCandidates,
  type TaskHashResult,
  taskEnvironment,
} from "../hash/task-hash.js";
import { xxhash64Hex } from "../hash/xxhash64.js";
import {
  finishTaskOutput,
  initialTaskOutputRenderState,
  renderLogEvent,
  renderTaskOutputChunk,
} from "../logging/events.js";
import {
  cargoHomeConfigurationPresent,
  discoverRepository,
  listRepositoryFiles,
  type RepositoryModel,
  type RepositoryPackage,
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
  readonly cacheExclusionDirectory: string;
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
  "nub.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
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
  const cacheDirectory = isAbsolutePath(cacheDirectoryValue)
    ? cacheDirectoryValue
    : joinPath(root, cacheDirectoryValue);
  const remoteConfiguration = value.remoteCache ?? global?.remoteCache;
  const apiUrl =
    parsed.apiUrl ??
    environment.TURBO_API ??
    remoteConfiguration?.apiUrl ??
    undefined;
  const token = parsed.token ?? environment.TURBO_TOKEN;
  const signatureKey = environment.TURBO_REMOTE_CACHE_SIGNATURE_KEY;
  const remoteTimeoutValue =
    parsed.remoteCacheTimeoutSeconds ??
    environment.TURBO_REMOTE_CACHE_TIMEOUT ??
    remoteConfiguration?.timeout ??
    30;
  const remoteTimeoutPath =
    parsed.remoteCacheTimeoutSeconds !== undefined
      ? "<arguments>"
      : environment.TURBO_REMOTE_CACHE_TIMEOUT !== undefined
        ? "TURBO_REMOTE_CACHE_TIMEOUT"
        : configuration.path;
  const remoteUploadTimeoutValue =
    parsed.remoteCacheTimeoutSeconds ??
    environment.TURBO_REMOTE_CACHE_UPLOAD_TIMEOUT ??
    remoteConfiguration?.uploadTimeout ??
    remoteConfiguration?.timeout ??
    30;
  const remoteUploadTimeoutPath =
    parsed.remoteCacheTimeoutSeconds !== undefined
      ? "<arguments>"
      : environment.TURBO_REMOTE_CACHE_UPLOAD_TIMEOUT !== undefined
        ? "TURBO_REMOTE_CACHE_UPLOAD_TIMEOUT"
        : configuration.path;
  const remote = (() => {
    if (apiUrl === undefined || remoteConfiguration?.enabled === false) {
      return undefined;
    }
    if (remoteConfiguration?.signature === true) {
      if (signatureKey === undefined || signatureKey.length === 0) {
        throw new ConfigurationError({
          path: configuration.path,
          message:
            "TURBO_REMOTE_CACHE_SIGNATURE_KEY is required when remote cache signatures are enabled",
        });
      }
      if (
        value.futureFlags?.longerSignatureKey === true &&
        signatureKey.length < 32
      ) {
        throw new ConfigurationError({
          path: configuration.path,
          message:
            "TURBO_REMOTE_CACHE_SIGNATURE_KEY must contain at least 32 characters",
        });
      }
    }
    const apiUrlPath =
      parsed.apiUrl !== undefined
        ? "<arguments>"
        : environment.TURBO_API !== undefined
          ? "TURBO_API"
          : configuration.path;
    try {
      const parsedApiUrl = new URL(apiUrl);
      if (
        parsedApiUrl.protocol !== "http:" &&
        parsedApiUrl.protocol !== "https:"
      ) {
        throw new TypeError("unsupported remote cache URL protocol");
      }
    } catch {
      throw new ConfigurationError({
        path: apiUrlPath,
        message: "invalid remote cache URL",
      });
    }
    const parseTimeout = (
      input: string | number,
      path: string,
      label: string,
    ): number => {
      const seconds = Number(input);
      if (
        (typeof input === "string" && input.trim() === "") ||
        !Number.isFinite(seconds) ||
        seconds < 0
      ) {
        throw new ConfigurationError({
          path,
          message: `invalid ${label}: ${String(input)}`,
        });
      }
      return seconds;
    };
    const remoteTimeoutSeconds = parseTimeout(
      remoteTimeoutValue,
      remoteTimeoutPath,
      "remote cache timeout",
    );
    const remoteUploadTimeoutSeconds = parseTimeout(
      remoteUploadTimeoutValue,
      remoteUploadTimeoutPath,
      "remote cache upload timeout",
    );
    return {
      apiUrl,
      token,
      teamId:
        environment.TURBO_TEAMID ?? remoteConfiguration?.teamId ?? undefined,
      teamSlug:
        parsed.team ??
        environment.TURBO_TEAM ??
        remoteConfiguration?.teamSlug ??
        undefined,
      timeoutMilliseconds: 1_000 * remoteTimeoutSeconds,
      uploadTimeoutMilliseconds: 1_000 * remoteUploadTimeoutSeconds,
      preflight: parsed.preflight || remoteConfiguration?.preflight === true,
      signatureKey,
      requireSignature: remoteConfiguration?.signature === true,
    };
  })();
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
    cacheDirectory,
    cacheExclusionDirectory: cacheDirectory,
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

const packageRelativeChangedFile = (
  packageModel: RepositoryPackage,
  repositoryRelativeFile: string,
): string | undefined => {
  if (packageModel.relativeDirectory === ".") {
    return repositoryRelativeFile;
  }
  for (const directory of new Set([
    packageModel.relativeDirectory,
    packageModel.canonicalRelativeDirectory,
  ])) {
    if (repositoryRelativeFile === directory) return ".";
    const prefix = `${directory}/`;
    if (repositoryRelativeFile.startsWith(prefix)) {
      return repositoryRelativeFile.slice(prefix.length);
    }
  }
  return undefined;
};

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

const filterTraversal = (
  rawFilter: string,
): { readonly dependencies: boolean; readonly dependents: boolean } => {
  const filter = rawFilter.startsWith("!") ? rawFilter.slice(1) : rawFilter;
  return {
    dependents: filter.startsWith("..."),
    dependencies: filter.endsWith("..."),
  };
};

const findAffectedPackages = (
  repository: RepositoryModel,
  environment: Readonly<Record<string, string | undefined>>,
  range?: GitRange,
  globalInputsAreTaskAware = false,
  windowsPathSeparators = false,
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
          processService.runBytes({
            command: "git",
            args: [
              "diff",
              "--no-renames",
              "--name-only",
              "-z",
              "--end-of-options",
              `${baseReference}...${head}`,
              "--",
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
            : new TextDecoder().decode(result.right.stderr).trim();
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
    const changedFiles = yield* Effect.try({
      try: () =>
        decodeNullDelimitedGitOutput(result.right.stdout, repository.root),
      catch: (cause) =>
        new ConfigurationError({
          path: repository.root,
          message:
            cause instanceof RepositoryError ? cause.message : String(cause),
        }),
    });
    const globalDependencyPatterns =
      repository.rootConfiguration.value.futureFlags?.globalConfiguration ===
      true
        ? globalInputsAreTaskAware
          ? []
          : (repository.rootConfiguration.value.global?.inputs ?? [])
        : (repository.rootConfiguration.value.globalDependencies ?? []);
    const globalDependencyChanged =
      selectByGlobs(
        changedFiles,
        globalDependencyPatterns,
        windowsPathSeparators,
      ).length > 0;
    const ordinaryRootChanged = changedFiles.some(
      (path) =>
        !repository.packages.some(
          (packageModel) =>
            packageModel.relativeDirectory !== "." &&
            packageRelativeChangedFile(packageModel, path) !== undefined,
        ),
    );
    const rootConfigurationChanged = changedFiles.includes(
      relativePath(repository.root, repository.rootConfiguration.path),
    );
    const rootChanged =
      globalDependencyChanged ||
      rootConfigurationChanged ||
      (!globalInputsAreTaskAware && ordinaryRootChanged);
    return {
      packages: rootChanged
        ? new Set(repository.packages.map((packageModel) => packageModel.name))
        : new Set(
            repository.packages
              .filter((packageModel) =>
                changedFiles.some(
                  (path) =>
                    packageRelativeChangedFile(packageModel, path) !==
                    undefined,
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
  windowsPathSeparators: boolean,
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
    const flags = repository.rootConfiguration.value.futureFlags;
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
        flags?.filterUsingTasks === true,
        windowsPathSeparators,
      );
      ranges.set(selector, affected.packages);
      affectedBySelector.set(selector, affected);
    }
    if (options.affected) {
      const affected = yield* findAffectedPackages(
        repository,
        environment,
        undefined,
        flags?.affectedUsingTaskInputs === true,
        windowsPathSeparators,
      );
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
  windowsPathSeparators: boolean,
): boolean => {
  const rootRelativeInputPrefix = "$TURBO_ROOT$/";
  const isRootPackage = node.package.relativeDirectory === ".";
  const inputs = effectiveTaskInputs(repository, node);
  const implicitInputs = new Set(
    implicitTaskInputCandidates(repository, node).map((path) =>
      relativePath(repository.root, path),
    ),
  );
  return changedFiles.some((repositoryRelativeFile) => {
    const packageRelativeFile = packageRelativeChangedFile(
      node.package,
      repositoryRelativeFile,
    );
    const logicalRepositoryRelativeFile =
      isRootPackage || packageRelativeFile === undefined
        ? repositoryRelativeFile
        : packageRelativeFile === "."
          ? node.package.relativeDirectory
          : joinPath(node.package.relativeDirectory, packageRelativeFile);
    if (
      implicitInputs.has(repositoryRelativeFile) ||
      implicitInputs.has(logicalRepositoryRelativeFile)
    ) {
      return true;
    }
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
          windowsPathSeparators,
        )
      );
    };
    let selected = false;
    for (const input of inputs) {
      if (typeof input !== "string") {
        if (input.withDefaults !== false && packageRelativeFile !== undefined) {
          selected = true;
        }
        for (const glob of input.globs ?? []) {
          if (glob.startsWith("!")) {
            if (matchesInput(glob.slice(1))) selected = false;
          } else if (matchesInput(glob)) {
            selected = true;
          }
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
  filter: string,
  windowsPathSeparators: boolean,
): ReadonlySet<string> => {
  if (rootChanged) return new Set(graph.entrypoints);
  const matchingNodes = new Set(
    [...graph.nodes]
      .filter(([, node]) =>
        taskMatchesChangedFiles(
          repository,
          node,
          changedFiles,
          windowsPathSeparators,
        ),
      )
      .map(([id]) => id),
  );
  const traversal = filterTraversal(filter);
  const selectedNodes = new Set(matchingNodes);
  const expandNodes = (
    initial: ReadonlySet<string>,
    adjacent: (id: string) => ReadonlyArray<string>,
  ): void => {
    const pending = [...initial];
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const id of adjacent(current)) {
        if (!selectedNodes.has(id)) {
          selectedNodes.add(id);
          pending.push(id);
        }
      }
    }
  };
  if (traversal.dependencies) {
    expandNodes(matchingNodes, (id) => [
      ...(graph.nodes.get(id)?.dependencies ?? []),
      ...(graph.nodes.get(id)?.with ?? []),
    ]);
  }
  if (traversal.dependents) {
    const reverseEdges = new Map<string, Array<string>>();
    for (const node of graph.nodes.values()) {
      for (const adjacent of [...node.dependencies, ...node.with]) {
        const dependents = reverseEdges.get(adjacent) ?? [];
        dependents.push(node.id);
        reverseEdges.set(adjacent, dependents);
      }
    }
    expandNodes(matchingNodes, (id) => reverseEdges.get(id) ?? []);
  }
  const selectedEntrypoints = new Set(
    graph.entrypoints.filter((id) => selectedNodes.has(id)),
  );
  if (traversal.dependencies || traversal.dependents) {
    const matchingPackageNames = new Set(
      [...matchingNodes].flatMap((id) => {
        const name = graph.nodes.get(id)?.package.name;
        return name === undefined || name === "//" ? [] : [name];
      }),
    );
    const prefix = traversal.dependents ? "..." : "";
    const suffix = traversal.dependencies ? "..." : "";
    const expandedPackageNames = new Set(
      matchingPackageNames.size === 0
        ? []
        : selectPackages(
            repository,
            [...matchingPackageNames].map(
              (name) => `${prefix}${name}${suffix}`,
            ),
          ).map((packageModel) => packageModel.name),
    );
    for (const name of matchingPackageNames) expandedPackageNames.delete(name);
    for (const id of graph.entrypoints) {
      const node = graph.nodes.get(id)!;
      if (
        node.command !== undefined &&
        expandedPackageNames.has(node.package.name)
      ) {
        selectedEntrypoints.add(id);
      }
    }
  }
  return selectedEntrypoints;
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
  retainedPackageNames: ReadonlySet<string> = new Set(),
  windowsPathSeparators = false,
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
    positiveFilters.length === 0
      ? graph.entrypoints
      : graph.entrypoints.filter((id) =>
          retainedPackageNames.has(graph.nodes.get(id)!.package.name),
        ),
  );
  for (const { filter, affected } of positiveFilters) {
    for (const id of affectedTaskEntrypoints(
      repository,
      graph,
      affected.changedFiles,
      affected.rootChanged,
      filter,
      windowsPathSeparators,
    )) {
      retainedEntrypoints.add(id);
    }
  }
  for (const { filter, affected } of rangeFilters.filter(({ filter }) =>
    filter.startsWith("!"),
  )) {
    for (const id of affectedTaskEntrypoints(
      repository,
      graph,
      affected.changedFiles,
      affected.rootChanged,
      filter,
      windowsPathSeparators,
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

export const taskScopeEnvironment = (
  repository: RepositoryModel,
  node: TaskNode,
  source: Readonly<Record<string, string | undefined>>,
  mode: "loose" | "strict",
  frameworkInference: boolean,
  scope: TaskCommandScope = packageTaskCommandScope,
  caseInsensitiveEnvironmentNames = false,
): Readonly<Record<string, string | undefined>> =>
  Object.assign(
    {},
    ...(scope.kind === "cargo-workspace" ? scope.members : [node]).map(
      (member) =>
        taskEnvironment(
          repository,
          member,
          source,
          mode,
          frameworkInference,
          caseInsensitiveEnvironmentNames,
        ),
    ),
  );

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
      return {
        command: "uv",
        arguments: [
          "run",
          "--frozen",
          "--package",
          node.package.name,
          "pytest",
          ...passThroughArguments,
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
  cacheDirectory: string,
  windowsPathSeparators: boolean,
): Effect.Effect<ReadonlyArray<string>, RepositoryError, FileSystemService> =>
  Effect.gen(function* () {
    const selected = new Set<string>();
    const rootOutputPrefix = "$TURBO_ROOT$/";
    const collectOutputs = (
      directory: string,
      patterns: ReadonlyArray<string>,
    ): Effect.Effect<void, RepositoryError, FileSystemService> =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystemService;
        const positivePatterns = patterns.filter(
          (pattern) => !pattern.startsWith("!"),
        );
        const files = yield* listRepositoryFiles(directory, {
          ignoredDirectories: new Set([".git", ".turbo"]),
          includeDirectories: true,
          shouldTraverseDirectory: (relativeDirectory) =>
            positivePatterns.some((pattern) =>
              canMatchGlobDescendant(
                relativeDirectory,
                pattern,
                windowsPathSeparators,
              ),
            ),
          windowsPathSeparators,
        });
        for (const path of files) {
          if (isPathContained(cacheDirectory, path, windowsPathSeparators)) {
            continue;
          }
          const relative = relativePath(directory, path, windowsPathSeparators);
          const metadata = yield* fileSystem
            .metadata(path)
            .pipe(
              Effect.mapError(
                (error) =>
                  new RepositoryError({ path, message: error.message }),
              ),
            );
          const candidates =
            metadata.kind === "directory"
              ? [relative, `${relative}/`]
              : [relative];
          if (
            matchesGlobsWithExclusions(
              candidates,
              patterns,
              windowsPathSeparators,
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
  cacheDirectory: string,
  restoreScope: CacheRestoreScope,
  windowsPathSeparators: boolean,
): Effect.Effect<
  | {
      readonly kind: "ready";
      readonly entries: ReadonlyArray<CacheWriteEntry>;
    }
  | { readonly kind: "too-large"; readonly inputBytes: number },
  RepositoryError,
  FileSystemService
> =>
  Effect.gen(function* () {
    const selected = [
      ...new Set([
        logPath,
        ...(yield* collectOutputPaths(
          repository,
          nodes,
          cacheDirectory,
          windowsPathSeparators,
        )),
      ]),
    ].sort();
    const fileSystem = yield* FileSystemService;
    const selectedMetadata = yield* Effect.forEach(
      selected,
      (path) =>
        fileSystem.metadata(path).pipe(
          Effect.mapError(
            (error) => new RepositoryError({ path, message: error.message }),
          ),
          Effect.map((metadata) => ({ path, metadata })),
        ),
      { concurrency: 8 },
    );
    const metadataInputBytes = selectedMetadata.reduce(
      (total, { metadata }) =>
        total +
        (metadata.kind === "directory" || metadata.kind === "symlink"
          ? 0
          : metadata.size),
      0,
    );
    if (metadataInputBytes > maximumCacheArchiveInputBytes) {
      return { kind: "too-large", inputBytes: metadataInputBytes } as const;
    }
    const entries: Array<CacheWriteEntry> = [];
    let inputBytes = 0;
    for (const { path, metadata } of selectedMetadata) {
      const common = {
        path: relativePath(repository.root, path, windowsPathSeparators),
        mode: metadata.mode,
        modifiedSeconds: metadata.modifiedMilliseconds / 1_000,
      };
      if (metadata.kind === "directory") {
        entries.push({ ...common, kind: "directory" });
        continue;
      }
      if (metadata.kind === "symlink") {
        const linkTarget = yield* fileSystem
          .readLink(path)
          .pipe(
            Effect.mapError(
              (error) => new RepositoryError({ path, message: error.message }),
            ),
          );
        entries.push({
          ...common,
          kind: "symlink",
          linkTarget,
          contents: new Uint8Array(),
        });
        continue;
      }
      const remainingBytes = maximumCacheArchiveInputBytes - inputBytes;
      const contents = yield* fileSystem
        .readBytesRange(path, 0, remainingBytes + 1)
        .pipe(
          Effect.mapError(
            (error) => new RepositoryError({ path, message: error.message }),
          ),
        );
      inputBytes += contents.length;
      if (inputBytes > maximumCacheArchiveInputBytes) {
        return { kind: "too-large", inputBytes } as const;
      }
      entries.push({ ...common, contents });
    }
    yield* validateArchiveEntriesForRestore(
      repository.root,
      entries,
      restoreScope,
    ).pipe(
      Effect.mapError(
        (error) =>
          new RepositoryError({ path: error.path, message: error.message }),
      ),
    );
    return { kind: "ready", entries } as const;
  });

const cacheRestoreScope = (
  repository: RepositoryModel,
  nodes: ReadonlyArray<TaskNode>,
  logPath: string,
  pathsToClear: ReadonlyArray<string>,
  cacheExclusionDirectory: string,
): CacheRestoreScope => {
  const rootOutputPrefix = "$TURBO_ROOT$/";
  const allowedPathGroups = nodes.flatMap((node) => {
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
    return [
      ...(packagePatterns.length === 0
        ? []
        : [
            {
              directory: relativePath(repository.root, node.package.directory),
              patterns: packagePatterns,
            },
          ]),
      ...(rootPatterns.length === 0
        ? []
        : [{ directory: ".", patterns: rootPatterns }]),
    ];
  });
  return {
    pathsToClear,
    allowedPathGroups,
    regularFilePaths: [relativePath(repository.root, logPath)],
    excludedDirectories: isPathContained(
      repository.root,
      cacheExclusionDirectory,
    )
      ? [relativePath(repository.root, cacheExclusionDirectory)]
      : [],
  };
};

const shouldReplayOutput = (
  mode: OutputLogs | undefined,
  cacheHit: boolean,
): boolean =>
  mode === undefined || mode === "full" || (mode === "new-only" && !cacheHit);

type TaskOutputQueueEvent =
  | { readonly kind: "chunk"; readonly output: string }
  | { readonly kind: "end" };

const persistentOutputCaptureCharacters = 64 * 1024;
const persistentOutputQueueCapacity = 16;

const cargoAlternateOutputFlags = [
  "--artifact-dir",
  "--manifest-path",
  "--out-dir",
  "--profile",
  "--target",
  "--target-dir",
] as const;

const cargoUnmodeledTargetFlags = [
  "--all",
  "--all-targets",
  "--bench",
  "--benches",
  "--bin",
  "--bins",
  "--example",
  "--examples",
  "--lib",
  "--package",
  "--test",
  "--tests",
  "--workspace",
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
      argument.startsWith("-p") ||
      [...cargoAlternateOutputFlags, ...cargoUnmodeledTargetFlags].some(
        (flag) => argument === flag || argument.startsWith(`${flag}=`),
      ),
  );

const usesAlternateUvBuildOutputs = (
  node: TaskNode,
  passThroughArguments: ReadonlyArray<string>,
): boolean =>
  node.package.manager === "uv" &&
  node.task === "build" &&
  passThroughArguments.some(
    (argument) =>
      argument === "-o" ||
      argument === "--out-dir" ||
      argument.startsWith("--out-dir="),
  );

const usesEnvironmentCargoBuildTarget = (
  environment: Readonly<Record<string, string | undefined>>,
  caseInsensitiveEnvironmentNames: boolean,
): boolean =>
  Object.entries(environment).some(
    ([name, value]) =>
      value !== undefined &&
      (caseInsensitiveEnvironmentNames
        ? name.toLowerCase() === "cargo_build_target"
        : name === "CARGO_BUILD_TARGET"),
  );

const environmentValue = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  caseInsensitiveNames: boolean,
): string | undefined => {
  const normalizedName = caseInsensitiveNames ? name.toLowerCase() : name;
  let selected: string | undefined;
  for (const [candidate, value] of Object.entries(environment)) {
    if (
      (caseInsensitiveNames ? candidate.toLowerCase() : candidate) ===
      normalizedName
    ) {
      selected = value;
    }
  }
  return selected;
};

const usesMismatchedCargoTargetDirectory = (
  node: TaskNode,
  sourceEnvironment: Readonly<Record<string, string | undefined>>,
  executionEnvironment: Readonly<Record<string, string | undefined>>,
  caseInsensitiveEnvironmentNames: boolean,
): boolean =>
  node.package.manager === "cargo" &&
  node.task === "build" &&
  environmentValue(
    sourceEnvironment,
    "CARGO_TARGET_DIR",
    caseInsensitiveEnvironmentNames,
  ) !==
    environmentValue(
      executionEnvironment,
      "CARGO_TARGET_DIR",
      caseInsensitiveEnvironmentNames,
    );

const encodeTaskLogIdentifier = (task: string): string => {
  const tokens: Array<string> = [];
  for (let index = 0; index < task.length; index += 1) {
    const code = task.charCodeAt(index);
    const character = task[index]!;
    const portable =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x61 && code <= 0x7a) ||
      character === "." ||
      character === "_" ||
      character === "-";
    tokens.push(
      portable
        ? character
        : `%${code.toString(16).toUpperCase().padStart(4, "0")}`,
    );
  }
  const maximumIdentifierBytes = 255 - "turbo-".length - ".log".length;
  const encoded = tokens.join("");
  if (encoded.length <= maximumIdentifierBytes) {
    return encoded;
  }
  const suffix = `-${xxhash64Hex(task)}`;
  const maximumPrefixBytes = maximumIdentifierBytes - suffix.length;
  let prefix = "";
  for (const token of tokens) {
    if (prefix.length + token.length > maximumPrefixBytes) {
      break;
    }
    prefix += token;
  }
  return `${prefix}${suffix}`;
};

const taskExecutionDirectory = (
  node: TaskNode,
  scope: TaskCommandScope | undefined,
): string =>
  scope?.kind === "cargo-workspace" ? scope.directory : node.package.directory;

const taskLogIdentifiers = (
  graph: TaskGraph,
  scopes: ReadonlyMap<string, TaskCommandScope> = new Map(),
  caseInsensitivePaths = false,
): ReadonlyMap<string, string> => {
  const nodesByLogPath = new Map<string, Array<TaskNode>>();
  for (const node of graph.nodes.values()) {
    const directory = normalizePath(
      taskExecutionDirectory(node, scopes.get(node.id)),
    );
    const comparableDirectory = caseInsensitivePaths
      ? directory.toLowerCase()
      : directory;
    const key = `${comparableDirectory}\0${encodeTaskLogIdentifier(node.task)}`;
    const nodes = nodesByLogPath.get(key) ?? [];
    nodes.push(node);
    nodesByLogPath.set(key, nodes);
  }
  return new Map(
    [...nodesByLogPath.values()].flatMap((nodes) =>
      nodes.map(
        (node) => [node.id, nodes.length > 1 ? node.id : node.task] as const,
      ),
    ),
  );
};

const cargoCompilationTaskNames = [
  "build",
  "check",
  "dev",
  "lint",
  "run",
  "test",
] as const;

type CargoCompilationTaskName = (typeof cargoCompilationTaskNames)[number];

const cargoCompilationTasks = new Set<CargoCompilationTaskName>(
  cargoCompilationTaskNames,
);

const isCargoCompilationTask = (node: TaskNode): boolean =>
  node.package.manager === "cargo" &&
  cargoCompilationTasks.has(node.task as CargoCompilationTaskName);

const usesCargoConfigurationOverride = (
  node: TaskNode,
  passThroughArguments: ReadonlyArray<string>,
): boolean =>
  isCargoCompilationTask(node) &&
  passThroughArguments.some(
    (argument) => argument === "--config" || argument.startsWith("--config="),
  );

export const isTaskScopeCacheable = (
  node: TaskNode,
  passThroughArguments: ReadonlyArray<string>,
  scope: TaskCommandScope = packageTaskCommandScope,
  environment: Readonly<Record<string, string | undefined>> = {},
  caseInsensitiveEnvironmentNames = false,
  sourceEnvironment: Readonly<Record<string, string | undefined>> = environment,
  cargoHomeHasConfiguration = false,
): boolean =>
  (scope.kind === "cargo-workspace" ? scope.members : [node]).every(
    (member) =>
      member.package.cachePathRestorable &&
      member.package.cacheInputsComplete &&
      member.definition.cache !== false &&
      member.definition.persistent !== true,
  ) &&
  !usesAlternateCargoBuildOutputs(node, passThroughArguments) &&
  !usesCargoConfigurationOverride(node, passThroughArguments) &&
  !usesAlternateUvBuildOutputs(node, passThroughArguments) &&
  !(
    isCargoCompilationTask(node) &&
    usesEnvironmentCargoBuildTarget(
      environment,
      caseInsensitiveEnvironmentNames,
    )
  ) &&
  !usesMismatchedCargoTargetDirectory(
    node,
    sourceEnvironment,
    environment,
    caseInsensitiveEnvironmentNames,
  ) &&
  !(isCargoCompilationTask(node) && cargoHomeHasConfiguration);

const hashDependencyGraph = (graph: TaskGraph): TaskGraph => ({
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
});

export const taskIdsWithUnrestorableCacheInputs = (
  graph: TaskGraph,
  scopes: ReadonlyMap<string, TaskCommandScope> = new Map(),
): ReadonlySet<string> => {
  const uncacheable = new Set<string>();
  for (const id of topologicalOrder(hashDependencyGraph(graph))) {
    const node = graph.nodes.get(id)!;
    const scope = scopes.get(id);
    const scopeNodes =
      scope?.kind === "cargo-workspace" ? scope.members : [node];
    if (
      scopeNodes.some(
        (member) =>
          !member.package.cachePathRestorable ||
          !member.package.cacheInputsComplete,
      ) ||
      [...node.dependencies, ...node.with].some((upstream) =>
        uncacheable.has(upstream),
      )
    ) {
      uncacheable.add(id);
    }
  }
  return uncacheable;
};

type CachePublicationPermit = <A, E, R>(
  publication: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R>;

export const makeCachePublicationPermit: Effect.Effect<CachePublicationPermit> =
  Effect.makeSemaphore(1).pipe(
    Effect.map(
      (semaphore) => (publication) => semaphore.withPermits(1)(publication),
    ),
  );

const prepareTaskLogPath = (
  logPath: string,
): Effect.Effect<void, RepositoryError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const logDirectory = parentPath(logPath);
    const directoryExists = yield* fileSystem
      .exists(logDirectory)
      .pipe(
        Effect.mapError(
          (error) =>
            new RepositoryError({ path: logDirectory, message: error.message }),
        ),
      );
    if (!directoryExists) {
      yield* fileSystem.makeDirectory(logDirectory).pipe(
        Effect.mapError(
          (error) =>
            new RepositoryError({
              path: logDirectory,
              message: error.message,
            }),
        ),
      );
    }
    const directoryMetadata = yield* fileSystem
      .metadata(logDirectory)
      .pipe(
        Effect.mapError(
          (error) =>
            new RepositoryError({ path: logDirectory, message: error.message }),
        ),
      );
    if (directoryMetadata.kind !== "directory") {
      return yield* Effect.fail(
        new RepositoryError({
          path: logDirectory,
          message: "task log parent must be a directory without symlinks",
        }),
      );
    }
    const logExists = yield* fileSystem
      .exists(logPath)
      .pipe(
        Effect.mapError(
          (error) =>
            new RepositoryError({ path: logPath, message: error.message }),
        ),
      );
    if (!logExists) return;
    const logMetadata = yield* fileSystem
      .metadata(logPath)
      .pipe(
        Effect.mapError(
          (error) =>
            new RepositoryError({ path: logPath, message: error.message }),
        ),
      );
    if (logMetadata.kind === "symlink") {
      return yield* Effect.fail(
        new RepositoryError({
          path: logPath,
          message: "task log destination must not be a symlink",
        }),
      );
    }
    if (logMetadata.kind !== "file") {
      return yield* Effect.fail(
        new RepositoryError({
          path: logPath,
          message: "task log destination must be a regular file",
        }),
      );
    }
    yield* fileSystem
      .remove(logPath)
      .pipe(
        Effect.mapError(
          (error) =>
            new RepositoryError({ path: logPath, message: error.message }),
        ),
      );
  });

const executeTask = (
  repository: RepositoryModel,
  node: TaskNode,
  options: ResolvedRunOptions,
  hash: TaskHashResult,
  sourceEnvironment: Readonly<Record<string, string | undefined>>,
  scope: TaskCommandScope = packageTaskCommandScope,
  cacheInputsRestorable = true,
  withCachePublicationPermit: CachePublicationPermit = (publication) =>
    publication,
  logIdentifier = node.task,
): Effect.Effect<TaskOutcome, unknown, RunRequirements> =>
  Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const fileSystem = yield* FileSystemService;
    const clock = yield* ClockService;
    const environmentService = yield* EnvironmentService;
    const platform = yield* environmentService.platform;
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
    const executionEnvironment = taskScopeEnvironment(
      repository,
      node,
      sourceEnvironment,
      options.environmentMode,
      options.frameworkInference,
      scope,
      platform === "win32",
    );
    const cacheNodes =
      scope.kind === "cargo-workspace" ? scope.members : [node];
    const executionDirectory =
      scope.kind === "cargo-workspace"
        ? scope.directory
        : node.package.directory;
    const cargoHomeHasConfiguration = isCargoCompilationTask(node)
      ? yield* cargoHomeConfigurationPresent(
          executionDirectory,
          executionEnvironment,
          platform === "win32",
        )
      : false;
    const cacheable =
      cacheInputsRestorable &&
      isTaskScopeCacheable(
        node,
        options.passThroughArguments,
        scope,
        executionEnvironment,
        platform === "win32",
        sourceEnvironment,
        cargoHomeHasConfiguration,
      );
    const localOptions = {
      directory: options.cacheDirectory,
      maxAgeMilliseconds: options.cacheMaxAgeMilliseconds,
      maxSizeBytes: options.cacheMaxSizeBytes,
    };
    const logPath = joinPath(
      executionDirectory,
      ".turbo",
      `turbo-${encodeTaskLogIdentifier(logIdentifier)}.log`,
    );
    const cacheRestoreRequested =
      cacheable &&
      !options.force &&
      (options.cachePolicy.localRead ||
        (options.cachePolicy.remoteRead && options.remote !== undefined));
    const existingOutputPaths = cacheRestoreRequested
      ? yield* collectOutputPaths(
          repository,
          cacheNodes,
          options.cacheExclusionDirectory,
          platform === "win32",
        ).pipe(
          Effect.map((paths) =>
            paths.map((path) =>
              relativePath(repository.root, path, platform === "win32"),
            ),
          ),
          Effect.catchTag("RepositoryError", (error) =>
            terminal
              .writeStderr(
                renderLogEvent(
                  {
                    kind: "warning",
                    message: `cache restore preparation failed for ${taskLabel}; executing task locally without cache reads: ${error.message}`,
                  },
                  warningColor,
                ),
              )
              .pipe(Effect.ignore, Effect.as(undefined)),
          ),
        )
      : [];
    const cacheRestoreEnabled =
      cacheRestoreRequested && existingOutputPaths !== undefined;
    const pathsToClear = existingOutputPaths ?? [];
    const restoreScope = cacheRestoreScope(
      repository,
      cacheNodes,
      logPath,
      pathsToClear,
      options.cacheExclusionDirectory,
    );
    let cacheHit = false;
    if (cacheRestoreEnabled && options.cachePolicy.localRead) {
      cacheHit = yield* restoreLocalCache(
        repository.root,
        localOptions,
        hash.hash,
        restoreScope,
      ).pipe(
        Effect.catchTag("CacheError", (error) =>
          terminal
            .writeStderr(
              renderLogEvent(
                {
                  kind: "warning",
                  message: `local cache restore failed for ${taskLabel}; continuing without local cache: ${error.message}`,
                },
                warningColor,
              ),
            )
            .pipe(Effect.ignore, Effect.as(false)),
        ),
      );
    }
    if (
      !cacheHit &&
      cacheRestoreEnabled &&
      options.cachePolicy.remoteRead &&
      options.remote !== undefined
    ) {
      cacheHit = yield* restoreRemoteCache(
        repository.root,
        options.remote,
        hash.hash,
        restoreScope,
      ).pipe(
        Effect.catchTag("CacheError", (error) =>
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
    if (cacheHit) {
      if (outputMode !== "none" && showHashEvent) {
        yield* terminal.writeStdout(
          renderLogEvent(
            { kind: "cache-hit", task: taskLabel, hash: hash.hash },
            color,
          ),
        );
      }
      if (shouldReplayOutput(outputMode, true)) {
        yield* Effect.gen(function* () {
          const hasLog = yield* fileSystem.exists(logPath).pipe(
            Effect.mapError(
              (error) =>
                new RepositoryError({
                  path: logPath,
                  message: error.message,
                }),
            ),
          );
          if (!hasLog) return;
          let renderState = initialTaskOutputRenderState;
          yield* fileSystem.readTextChunks(logPath).pipe(
            Stream.mapError(
              (error) =>
                new RepositoryError({ path: logPath, message: error.message }),
            ),
            Stream.runForEach((output) =>
              Effect.gen(function* () {
                const rendered = renderTaskOutputChunk(
                  renderState,
                  taskLabel,
                  output,
                  color,
                );
                renderState = rendered.state;
                for (const chunk of rendered.chunks) {
                  yield* terminal.writeStdout(chunk);
                }
              }),
            ),
          );
          for (const chunk of finishTaskOutput(renderState)) {
            yield* terminal.writeStdout(chunk);
          }
        }).pipe(
          Effect.catchTag("RepositoryError", (error) =>
            terminal
              .writeStderr(
                renderLogEvent(
                  {
                    kind: "warning",
                    message: `cached log replay failed for ${taskLabel}; preserving successful cache hit: ${error.message}`,
                  },
                  warningColor,
                ),
              )
              .pipe(Effect.ignore),
          ),
        );
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
    yield* prepareTaskLogPath(logPath);
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
        maxCapturedOutputCharacters:
          onOutputChunk === undefined
            ? undefined
            : persistentOutputCaptureCharacters,
        env: {
          ...executionEnvironment,
          TURBO_HASH: hash.hash,
        },
      });
    const streamsCapturedOutput = node.definition.interactive !== true;
    const displaysStreamedOutput =
      streamsCapturedOutput && shouldReplayOutput(outputMode, false);
    const result = streamsCapturedOutput
      ? yield* Effect.scoped(
          Effect.gen(function* () {
            yield* fileSystem.writeText(logPath, "");
            const outputQueue = yield* Queue.bounded<TaskOutputQueueEvent>(
              persistentOutputQueueCapacity,
            );
            yield* Effect.addFinalizer(() => Queue.shutdown(outputQueue));
            const outputFiber = yield* Effect.forkScoped(
              Effect.gen(function* () {
                let renderState = initialTaskOutputRenderState;
                while (true) {
                  const event = yield* Queue.take(outputQueue);
                  if (event.kind === "end") {
                    if (displaysStreamedOutput) {
                      for (const chunk of finishTaskOutput(renderState)) {
                        yield* terminal.writeStdout(chunk);
                      }
                    }
                    return;
                  }
                  yield* fileSystem.appendText(logPath, event.output);
                  if (!displaysStreamedOutput) continue;
                  const rendered = renderTaskOutputChunk(
                    renderState,
                    taskLabel,
                    event.output,
                    color,
                  );
                  renderState = rendered.state;
                  for (const chunk of rendered.chunks) {
                    yield* terminal.writeStdout(chunk);
                  }
                }
              }),
            );
            const processResult = yield* Effect.raceFirst(
              startProcess((output) =>
                Effect.runPromise(
                  Queue.offer(outputQueue, { kind: "chunk", output }).pipe(
                    Effect.asVoid,
                  ),
                ),
              ),
              Fiber.join(outputFiber).pipe(Effect.flatMap(() => Effect.never)),
            );
            yield* Queue.offer(outputQueue, { kind: "end" });
            yield* Fiber.join(outputFiber);
            return processResult;
          }),
        )
      : yield* Effect.scoped(startProcess());
    const output = result.combinedOutput;
    if (!streamsCapturedOutput) {
      yield* fileSystem.writeText(logPath, output);
    }
    if (
      (!displaysStreamedOutput && shouldReplayOutput(outputMode, false)) ||
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
      yield* withCachePublicationPermit(
        Effect.gen(function* () {
          const collected = yield* collectCacheEntries(
            repository,
            cacheNodes,
            logPath,
            options.cacheExclusionDirectory,
            restoreScope,
            platform === "win32",
          ).pipe(
            Effect.catchAll((error) =>
              terminal
                .writeStderr(
                  renderLogEvent(
                    {
                      kind: "warning",
                      message: `cache output collection failed for ${taskLabel}; skipping cache publication while preserving successful task result: ${error.message}`,
                    },
                    warningColor,
                  ),
                )
                .pipe(Effect.ignore, Effect.as(undefined)),
            ),
          );
          if (collected === undefined) return;
          if (collected.kind === "too-large") {
            yield* terminal.writeStderr(
              renderLogEvent(
                {
                  kind: "warning",
                  message: `cache write skipped for ${taskLabel}; ${collected.inputBytes} bytes of task outputs exceed the ${maximumCacheArchiveInputBytes} byte safety limit`,
                },
                warningColor,
              ),
            );
            return;
          }
          const duration = (yield* clock.now) - started;
          if (options.cachePolicy.localWrite) {
            yield* writeLocalCache(
              localOptions,
              hash.hash,
              collected.entries,
              duration,
            ).pipe(
              Effect.catchAll((error) =>
                terminal
                  .writeStderr(
                    renderLogEvent(
                      {
                        kind: "warning",
                        message: `local cache write failed for ${taskLabel}; preserving successful task result: ${error.message}`,
                      },
                      warningColor,
                    ),
                  )
                  .pipe(Effect.ignore),
              ),
            );
          }
          if (options.cachePolicy.remoteWrite && options.remote !== undefined) {
            yield* writeRemoteCache(
              options.remote,
              hash.hash,
              collected.entries,
              duration,
            ).pipe(
              Effect.catchAll((error) =>
                terminal
                  .writeStderr(
                    renderLogEvent(
                      {
                        kind: "warning",
                        message: `remote cache upload failed for ${taskLabel}; preserving successful task result: ${error.message}`,
                      },
                      warningColor,
                    ),
                  )
                  .pipe(Effect.ignore),
              ),
            );
          }
        }),
      );
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
    for (const id of topologicalOrder(hashDependencyGraph(graph))) {
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
        options.cacheExclusionDirectory,
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

const hasCompatibleCargoWorkspaceRuntime = (
  members: ReadonlyArray<TaskNode>,
): boolean => {
  const representative = members[0];
  if (representative === undefined) return false;
  return members.every(
    (member) =>
      (member.definition.interactive === true) ===
        (representative.definition.interactive === true) &&
      (member.definition.outputLogs ?? undefined) ===
        (representative.definition.outputLogs ?? undefined) &&
      (member.definition.persistent === true) ===
        (representative.definition.persistent === true),
  );
};

export interface CargoWorkspaceTaskPlan {
  readonly graph: TaskGraph;
  readonly scopes: ReadonlyMap<string, TaskCommandScope>;
}

export const planCargoWorkspaceTasks = (
  repository: RepositoryModel,
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
    if (
      node.package.manager !== "cargo" ||
      node.package.workspaceDirectory === undefined ||
      !eligibleTasks.has(node.task)
    ) {
      continue;
    }
    const workspaceDirectory = node.package.workspaceDirectory;
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
    const workspaceMembers = repository.packages.filter(
      (packageModel) =>
        packageModel.manager === "cargo" &&
        packageModel.workspaceDirectory ===
          representative.package.workspaceDirectory,
    );
    const groupedPackageNames = new Set(
      members.map((member) => member.package.name),
    );
    if (
      !hasCompatibleCargoWorkspaceRuntime(members) ||
      workspaceMembers.some(
        (packageModel) =>
          packageModel.tasks[representative.task] === undefined ||
          !groupedPackageNames.has(packageModel.name),
      )
    ) {
      continue;
    }
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
  repository: RepositoryModel,
  graph: TaskGraph,
  hashes: ReadonlyMap<string, TaskHashResult>,
  scopes: ReadonlyMap<string, TaskCommandScope>,
  options: ResolvedRunOptions,
): Effect.Effect<
  ReadonlyMap<string, TaskHashResult>,
  RepositoryError,
  FileSystemService | EnvironmentService | DigestService | ProcessService
> =>
  Effect.gen(function* () {
    const combined = new Map(hashes);
    const changed = new Set<string>();
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
      changed.add(id);
    }
    for (const id of topologicalOrder(hashDependencyGraph(graph))) {
      if (scopes.has(id)) continue;
      const node = graph.nodes.get(id)!;
      const upstreamIds = [
        ...new Set([...node.dependencies, ...node.with]),
      ].sort();
      if (!upstreamIds.some((upstream) => changed.has(upstream))) continue;
      combined.set(
        id,
        yield* hashTask(
          repository,
          node,
          upstreamIds.map((upstream) => combined.get(upstream)!.hash),
          options.frameworkInference,
          options.passThroughArguments,
          options.cacheExclusionDirectory,
        ),
      );
      changed.add(id);
    }
    return combined;
  });

export const cargoWorkspaceHash = (
  members: ReadonlyArray<readonly [string, string]>,
): string =>
  xxhash64Hex(
    JSON.stringify({
      scope: "cargo-workspace",
      members: [...members].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
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

const readyForegroundCohorts = (
  graph: TaskGraph,
  readyIds: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const ready = new Set(readyIds);
  const adjacent = new Map(
    readyIds.map((id) => [id, new Set<string>()] as const),
  );
  for (const id of readyIds) {
    for (const companion of graph.nodes.get(id)!.with) {
      if (!ready.has(companion)) continue;
      adjacent.get(id)!.add(companion);
      adjacent.get(companion)!.add(id);
    }
  }
  const cohorts: Array<ReadonlyArray<string>> = [];
  const visited = new Set<string>();
  for (const start of [...ready].sort()) {
    if (visited.has(start)) continue;
    const members = new Set<string>();
    const pending = [start];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (members.has(id)) continue;
      members.add(id);
      visited.add(id);
      pending.push(...(adjacent.get(id) ?? []));
    }
    cohorts.push([...members].sort());
  }
  return cohorts.sort((left, right) => left[0]!.localeCompare(right[0]!));
};

const canonicalContainmentPath = (
  path: string,
): Effect.Effect<string, ConfigurationError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const suffix: Array<string> = [];
    let current = normalizePath(path);
    while (
      !(yield* fileSystem
        .exists(current)
        .pipe(
          Effect.mapError(
            (error) => new ConfigurationError({ path, message: error.message }),
          ),
        ))
    ) {
      const parent = parentPath(current);
      if (parent === current) {
        return yield* Effect.fail(
          new ConfigurationError({
            path,
            message: "unable to resolve cache directory ancestry",
          }),
        );
      }
      suffix.unshift(baseName(current));
      current = parent;
    }
    const resolved = yield* fileSystem
      .realPath(current)
      .pipe(
        Effect.mapError(
          (error) => new ConfigurationError({ path, message: error.message }),
        ),
      );
    return joinPath(resolved, ...suffix);
  });

export const executeRun = (
  parsed: ParsedRunOptions,
): Effect.Effect<number, unknown, RunRequirements> =>
  Effect.gen(function* () {
    const environmentService = yield* EnvironmentService;
    const concurrencyService = yield* ConcurrencyService;
    const fileSystem = yield* FileSystemService;
    const processCwd = yield* environmentService.cwd;
    const environment = yield* environmentService.entries;
    const platform = yield* environmentService.platform;
    const requestedRoot =
      parsed.cwd === undefined
        ? undefined
        : isAbsolutePath(parsed.cwd)
          ? parsed.cwd
          : joinPath(processCwd, parsed.cwd);
    let resolvedRequestedRoot: string | undefined;
    if (requestedRoot !== undefined) {
      const exists = yield* fileSystem.exists(requestedRoot).pipe(
        Effect.mapError(
          (error) =>
            new ConfigurationError({
              path: requestedRoot,
              message: error.message,
            }),
        ),
      );
      if (!exists) {
        return yield* Effect.fail(
          new ConfigurationError({
            path: requestedRoot,
            message: "working directory does not exist",
          }),
        );
      }
      resolvedRequestedRoot = yield* fileSystem.realPath(requestedRoot).pipe(
        Effect.mapError(
          (error) =>
            new ConfigurationError({
              path: requestedRoot,
              message: error.message,
            }),
        ),
      );
      const metadata = yield* fileSystem.metadata(resolvedRequestedRoot).pipe(
        Effect.mapError(
          (error) =>
            new ConfigurationError({
              path: requestedRoot,
              message: error.message,
            }),
        ),
      );
      if (metadata.kind !== "directory") {
        return yield* Effect.fail(
          new ConfigurationError({
            path: requestedRoot,
            message: "working directory is not a directory",
          }),
        );
      }
    }
    const preliminaryRoot = yield* discoverRepositoryRoot(
      resolvedRequestedRoot ?? processCwd,
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
    const unresolvedOptions = resolveOptions(
      parsed,
      preliminaryRoot,
      environment,
      configuration,
      availableParallelism,
    );
    const [canonicalRoot, canonicalCacheDirectory] = yield* Effect.all([
      canonicalContainmentPath(unresolvedOptions.root),
      canonicalContainmentPath(unresolvedOptions.cacheDirectory),
    ]);
    if (isPathContained(canonicalCacheDirectory, canonicalRoot)) {
      return yield* Effect.fail(
        new ConfigurationError({
          path: unresolvedOptions.cacheDirectory,
          message:
            "cache directory must not be the repository root or one of its ancestors",
        }),
      );
    }
    const options: ResolvedRunOptions = {
      ...unresolvedOptions,
      cacheExclusionDirectory: isPathContained(
        canonicalRoot,
        canonicalCacheDirectory,
      )
        ? joinPath(
            unresolvedOptions.root,
            relativePath(canonicalRoot, canonicalCacheDirectory),
          )
        : unresolvedOptions.cacheDirectory,
    };
    const repository = yield* discoverRepository(options.root, configuration);
    const containedPackage = repository.packages.find((packageModel) =>
      isPathContained(
        canonicalCacheDirectory,
        joinPath(canonicalRoot, packageModel.canonicalRelativeDirectory),
      ),
    );
    if (containedPackage !== undefined) {
      return yield* Effect.fail(
        new ConfigurationError({
          path: unresolvedOptions.cacheDirectory,
          message: `cache directory must not contain package ${containedPackage.name}`,
        }),
      );
    }
    if (options.cachePolicy.localRead || options.cachePolicy.localWrite) {
      yield* evictLocalCache({
        directory: options.cacheDirectory,
        maxAgeMilliseconds: options.cacheMaxAgeMilliseconds,
        maxSizeBytes: options.cacheMaxSizeBytes,
      }).pipe(
        Effect.catchTag("CacheError", (error) =>
          Effect.gen(function* () {
            const terminal = yield* TerminalService;
            const warningColor = options.colorEnabled
              ? yield* terminal.stderrColorEnabled
              : false;
            yield* terminal
              .writeStderr(
                renderLogEvent(
                  {
                    kind: "warning",
                    message: `local cache eviction failed; continuing without cache maintenance: ${error.message}`,
                  },
                  warningColor,
                ),
              )
              .pipe(Effect.ignore);
          }),
        ),
      );
    }
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
      platform === "win32",
    );
    const flags = repository.rootConfiguration.value.futureFlags;
    const useTaskInputs =
      (options.affected && flags?.affectedUsingTaskInputs === true) ||
      (affected.hasGitRangeFilter && flags?.filterUsingTasks === true);
    const nonRangeFilters = affected.filters.filter(
      (filter) => gitRangeSelector(filter) === undefined,
    );
    const positivePackageFilters = nonRangeFilters.filter(
      (filter) => !filter.startsWith("!"),
    );
    const negativePackageFilters = nonRangeFilters.filter((filter) =>
      filter.startsWith("!"),
    );
    const hasPositiveRangeFilter = affected.filters.some(
      (filter) =>
        !filter.startsWith("!") && gitRangeSelector(filter) !== undefined,
    );
    const retainedPackageNames = new Set(
      !useTaskInputs || positivePackageFilters.length === 0
        ? []
        : selectPackages(
            repository,
            [...positivePackageFilters, ...negativePackageFilters],
            affected.ranges,
          ).map((packageModel) => packageModel.name),
    );
    const packageFilters = !useTaskInputs
      ? affected.filters
      : hasPositiveRangeFilter
        ? negativePackageFilters
        : nonRangeFilters;
    const validationGraph = buildTaskGraph(
      repository,
      selectPackages(repository, nonRangeFilters),
      options.tasks,
      options.only,
      flags?.strictTaskEntrypointSelection === true,
    );
    const entrypointIds = new Set(validationGraph.entrypoints);
    const entrypointTasks = new Set(
      validationGraph.entrypoints.map(
        (entrypoint) => validationGraph.nodes.get(entrypoint)!.task,
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
    const selectedGraph = useTaskInputs
      ? selectAffectedTasks(
          repository,
          unfilteredGraph,
          affected.filters,
          affected.affectedBySelector,
          retainedPackageNames,
          platform === "win32",
        )
      : unfilteredGraph;
    const cargoWorkspacePlan = planCargoWorkspaceTasks(
      repository,
      selectedGraph,
      options.tasks,
      affected.filters.length === 0,
    );
    const graph = cargoWorkspacePlan.graph;
    const hashes = yield* applyCargoWorkspaceHashes(
      repository,
      graph,
      yield* computeTaskHashes(repository, selectedGraph, options),
      cargoWorkspacePlan.scopes,
      options,
    );
    const unrestorableCacheInputs = taskIdsWithUnrestorableCacheInputs(
      graph,
      cargoWorkspacePlan.scopes,
    );
    const logIdentifiers = taskLogIdentifiers(
      graph,
      cargoWorkspacePlan.scopes,
      platform === "win32",
    );
    const groups = taskGroups(graph);
    const pending = new Map(groups.map((members) => [members[0]!, members]));
    const outcomes = new Map<string, TaskOutcome>();
    const foregroundSemaphore = yield* Effect.makeSemaphore(
      options.concurrency,
    );
    const withCachePublicationPermit = yield* makeCachePublicationPermit;
    const runGroup = ([, members]: readonly [
      string,
      ReadonlyArray<string>,
    ]): Effect.Effect<
      ReadonlyArray<TaskOutcome>,
      RepositoryError,
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
            outcome !== undefined && (outcome.exitCode !== 0 || outcome.skipped)
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
          !unrestorableCacheInputs.has(id),
          withCachePublicationPermit,
          logIdentifiers.get(id),
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
      const backgroundSet = new Set(background);
      const foreground = members.filter((id) => !background.includes(id));
      return Effect.scoped(
        Effect.gen(function* () {
          const backgroundFibers: Array<{
            readonly id: string;
            readonly fiber: Fiber.RuntimeFiber<TaskOutcome, never>;
          }> = [];
          const startedBackground = new Set<string>();
          const remaining = new Set(foreground);
          const results: Array<TaskOutcome> = [];
          const hasStartedCompanions = (id: string): boolean =>
            graph.nodes
              .get(id)!
              .with.filter((companion) => backgroundSet.has(companion))
              .every((companion) => startedBackground.has(companion));
          const backgroundOutcomes = (): ReadonlyArray<TaskOutcome> =>
            backgroundFibers.map(({ id }) => ({
              id,
              exitCode: 0,
              hash: hashes.get(id)!.hash,
              skipped: false,
            }));
          const firstBackgroundFailure = () => {
            const failures = backgroundFibers.map(({ fiber }) =>
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
            return failures
              .slice(1)
              .reduce((left, right) => Effect.race(left, right), failures[0]!);
          };
          while (remaining.size > 0) {
            while (true) {
              const readyBackground = background.filter((id) => {
                if (startedBackground.has(id)) return false;
                const node = graph.nodes.get(id)!;
                return (
                  node.dependencies
                    .filter((dependency) => memberSet.has(dependency))
                    .every((dependency) => groupOutcomes.has(dependency)) &&
                  hasStartedCompanions(id)
                );
              });
              if (readyBackground.length === 0) break;
              const started = yield* Effect.forEach(
                readyBackground,
                (id) =>
                  Effect.forkScoped(runNode(id)).pipe(
                    Effect.map((fiber) => ({ id, fiber })),
                  ),
                { concurrency: "unbounded" },
              );
              backgroundFibers.push(...started);
              for (const { id } of started) startedBackground.add(id);
              yield* Effect.yieldNow();
            }
            const dependencyReadyForeground = new Set(
              [...remaining].filter(
                (id) =>
                  options.parallel ||
                  graph.nodes
                    .get(id)!
                    .dependencies.filter((dependency) =>
                      memberSet.has(dependency),
                    )
                    .every((dependency) => groupOutcomes.has(dependency)),
              ),
            );
            const readyForeground = new Set(dependencyReadyForeground);
            while (true) {
              const blocked = [...readyForeground].filter((id) => {
                if (!hasStartedCompanions(id)) return true;
                return graph.nodes
                  .get(id)!
                  .with.filter(
                    (companion) =>
                      !backgroundSet.has(companion) && remaining.has(companion),
                  )
                  .some((companion) => !readyForeground.has(companion));
              });
              if (blocked.length === 0) break;
              for (const id of blocked) readyForeground.delete(id);
            }
            if (readyForeground.size === 0) {
              return yield* Effect.fail(
                new RepositoryError({
                  path: options.root,
                  message: "scheduler deadlock inside with group",
                }),
              );
            }
            const readyCohorts = readyForegroundCohorts(graph, [
              ...readyForeground,
            ]);
            const oversizedCohort = readyCohorts.find(
              (cohort) => cohort.length > options.concurrency,
            );
            if (oversizedCohort !== undefined) {
              return yield* Effect.fail(
                new RepositoryError({
                  path: options.root,
                  message: `with group requires at least ${oversizedCohort.length} foreground concurrency slots for ready tasks: ${oversizedCohort.join(", ")}`,
                }),
              );
            }
            const scheduledCohorts: Array<ReadonlyArray<string>> = [];
            let scheduledCount = 0;
            for (const cohort of readyCohorts) {
              if (scheduledCount + cohort.length > options.concurrency) {
                break;
              }
              scheduledCohorts.push(cohort);
              scheduledCount += cohort.length;
            }
            const scheduledForeground = scheduledCohorts.flat();
            const foregroundCompletion = foregroundSemaphore
              .withPermits(scheduledForeground.length)(
                Effect.forEach(scheduledForeground, runNode, {
                  concurrency: "unbounded",
                }),
              )
              .pipe(
                Effect.map((outcome) => ({
                  _tag: "ForegroundComplete" as const,
                  outcomes: outcome,
                })),
              );
            const completion =
              backgroundFibers.length === 0
                ? yield* foregroundCompletion
                : yield* Effect.race(
                    foregroundCompletion,
                    firstBackgroundFailure(),
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
            for (const outcome of completion.outcomes) {
              remaining.delete(outcome.id);
              groupOutcomes.set(outcome.id, outcome);
              results.push(outcome);
            }
            if (
              options.continueMode === "never" &&
              completion.outcomes.some((outcome) => outcome.exitCode !== 0)
            ) {
              return [...results, ...backgroundOutcomes()];
            }
          }
          return [...results, ...backgroundOutcomes()];
        }),
      );
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        const completions = yield* Queue.unbounded<string>();
        const running = new Map<
          string,
          Fiber.RuntimeFiber<ReadonlyArray<TaskOutcome>, RepositoryError>
        >();
        let stopScheduling = false;
        while (pending.size > 0 || running.size > 0) {
          if (!stopScheduling && running.size < options.concurrency) {
            const ready = [...pending.entries()]
              .filter(([, members]) => {
                const memberSet = new Set(members);
                return (
                  options.parallel ||
                  members.every((id) =>
                    graph.nodes
                      .get(id)!
                      .dependencies.filter(
                        (dependency) => !memberSet.has(dependency),
                      )
                      .every((dependency) => outcomes.has(dependency)),
                  )
                );
              })
              .sort(([left], [right]) => left.localeCompare(right));
            const availableGroups = options.concurrency - running.size;
            for (const entry of ready.slice(0, availableGroups)) {
              const [groupId] = entry;
              pending.delete(groupId);
              const fiber = yield* Effect.forkScoped(
                runGroup(entry).pipe(
                  Effect.onExit(() => Queue.offer(completions, groupId)),
                ),
              );
              running.set(groupId, fiber);
            }
          }
          if (running.size === 0) {
            if (pending.size > 0 && !stopScheduling) {
              return yield* Effect.fail(
                new RepositoryError({
                  path: options.root,
                  message: "scheduler deadlock",
                }),
              );
            }
            break;
          }
          const completedGroupId = yield* Queue.take(completions);
          const fiber = running.get(completedGroupId)!;
          running.delete(completedGroupId);
          const results = yield* Fiber.join(fiber);
          for (const result of results) {
            outcomes.set(result.id, result);
          }
          if (
            options.continueMode === "never" &&
            results.some((result) => result.exitCode !== 0)
          ) {
            stopScheduling = true;
          }
        }
      }),
    );
    return [...outcomes.values()].some((outcome) => outcome.exitCode !== 0)
      ? 1
      : 0;
  });
