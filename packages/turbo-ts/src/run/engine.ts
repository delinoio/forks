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
import { parsePackageFilter } from "../core/filter.js";
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
import {
  CacheRollbackError,
  ConfigurationError,
  RepositoryError,
} from "../effect/errors.js";
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
  RuntimeProfileService,
  SigningService,
  TerminalService,
} from "../effect/services.js";
import type { OutputLogs } from "../generated/configuration.js";
import {
  buildTaskGraph,
  packageFilterComponentIdentities,
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
  owningLockfile,
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
import { resolveLockfilePackageClosure } from "../repository/lockfiles.js";
import {
  cargoHomeConfigurationPresent,
  configuredEnvironmentValue,
  discoverRepository,
  listRepositoryFiles,
  npmUserConfigurationPresent,
  type PackageManagerRuntimeIdentity,
  type RepositoryModel,
  type RepositoryPackage,
  resolvePackageManagerRuntimeIdentity,
  resolveUvRuntimeIdentity,
  type UvRuntimeIdentity,
  uvControlInputs,
  yarnUserConfigurationPresent,
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
  readonly globalDependencies: ReadonlyArray<string>;
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
  readonly json: boolean;
  readonly ui: "tui" | "stream" | "stream-with-experimental-timestamps";
  readonly logOrder: "auto" | "stream" | "grouped";
  readonly logPrefix: "auto" | "none" | "task";
}

type WriteStructuredRecord = (
  record: Readonly<Record<string, unknown>>,
) => Effect.Effect<void, unknown, never>;

type OutputPermit = <A, E, R>(
  output: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R>;

export const resolveRunUiMode = (
  requested: ResolvedRunOptions["ui"],
  stdinIsTerminal: boolean,
  stdoutIsTerminal: boolean,
  json: boolean,
): ResolvedRunOptions["ui"] =>
  requested === "tui" && (json || !stdinIsTerminal || !stdoutIsTerminal)
    ? "stream"
    : requested;

export const renderTimestampedStreamText = (
  timestamp: number,
  text: string,
): string => {
  if (text === "") return "";
  const prefix = `[${new Date(timestamp).toISOString()}] `;
  return `${prefix}${text.replaceAll("\n", `\n${prefix}`)}`.slice(
    0,
    text.endsWith("\n") ? -prefix.length : undefined,
  );
};

type RunTuiStatus = "queued" | "running" | "succeeded" | "failed" | "skipped";

export const renderRunTui = (
  statuses: ReadonlyMap<string, RunTuiStatus>,
): string =>
  `\u001b[2J\u001b[Hturbo-ts\n\n${[...statuses]
    .map(([id, status]) => `${status.padEnd(9)} ${id}`)
    .join("\n")}\n`;

interface TaskExecutionResult {
  readonly id: string;
  readonly exitCode: number;
  readonly hash?: string;
  readonly skipped: boolean;
  readonly cacheSource?: "local" | "remote";
  readonly cacheTimeSaved?: number;
}

interface TaskOutcome extends TaskExecutionResult {
  readonly startTime: number;
  readonly endTime: number;
}

export type RunRequirements =
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
  environmentValue: (name: string) => string | undefined,
): CachePolicy => {
  let policy: CachePolicy = {
    localRead: true,
    localWrite: true,
    remoteRead: true,
    remoteWrite: true,
  };
  const specification =
    parsed.cacheSpecification ?? environmentValue("TURBO_CACHE");
  if (specification !== undefined) {
    policy = parseCacheSpecification(
      specification,
      parsed.cacheSpecification === undefined ? "TURBO_CACHE" : "<arguments>",
    );
  }
  if (
    parsed.remoteOnly ||
    environmentBoolean(environmentValue("TURBO_REMOTE_ONLY")) === true
  ) {
    policy = { ...policy, localRead: false, localWrite: false };
  }
  if (
    parsed.remoteCacheReadOnly ||
    environmentBoolean(environmentValue("TURBO_REMOTE_CACHE_READ_ONLY")) ===
      true
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
  ".pnp.cjs",
  "aube.lock",
  "bun.lock",
  "bun.lockb",
  "nub.lock",
  "npm-shrinkwrap.json",
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

export const resolveOptions = (
  parsed: ParsedRunOptions,
  root: string,
  environment: Readonly<Record<string, string | undefined>>,
  configuration: LoadedRootConfiguration,
  availableParallelism: number,
  caseInsensitiveEnvironmentNames = false,
): ResolvedRunOptions => {
  const value = configuration.value;
  const global = value.global;
  const environmentValue = (name: string): string | undefined =>
    configuredEnvironmentValue(
      environment,
      name,
      caseInsensitiveEnvironmentNames,
    );
  const configuredEnvironmentMode = environmentValue("TURBO_ENV_MODE");
  const configuredApiUrl = environmentValue("TURBO_API");
  const configuredRemoteTimeout = environmentValue(
    "TURBO_REMOTE_CACHE_TIMEOUT",
  );
  const configuredRemoteUploadTimeout = environmentValue(
    "TURBO_REMOTE_CACHE_UPLOAD_TIMEOUT",
  );
  const concurrency =
    parsed.concurrency ??
    environmentValue("TURBO_CONCURRENCY") ??
    value.concurrency ??
    global?.concurrency ??
    undefined;
  const environmentModeValue =
    parsed.environmentMode ??
    (configuredEnvironmentMode === "loose"
      ? "loose"
      : configuredEnvironmentMode === "strict"
        ? "strict"
        : undefined) ??
    value.envMode ??
    global?.envMode ??
    "strict";
  const cacheDirectoryValue =
    parsed.cacheDirectory ??
    environmentValue("TURBO_CACHE_DIR") ??
    value.cacheDir ??
    global?.cacheDir ??
    ".turbo/cache";
  const cacheDirectory = isAbsolutePath(cacheDirectoryValue)
    ? cacheDirectoryValue
    : joinPath(root, cacheDirectoryValue);
  const remoteConfiguration = value.remoteCache ?? global?.remoteCache;
  const apiUrl =
    parsed.apiUrl ??
    configuredApiUrl ??
    remoteConfiguration?.apiUrl ??
    undefined;
  const token = parsed.token ?? environmentValue("TURBO_TOKEN");
  const signatureKey = environmentValue("TURBO_REMOTE_CACHE_SIGNATURE_KEY");
  const remoteTimeoutValue =
    parsed.remoteCacheTimeoutSeconds ??
    configuredRemoteTimeout ??
    remoteConfiguration?.timeout ??
    30;
  const remoteTimeoutPath =
    parsed.remoteCacheTimeoutSeconds !== undefined
      ? "<arguments>"
      : configuredRemoteTimeout !== undefined
        ? "TURBO_REMOTE_CACHE_TIMEOUT"
        : configuration.path;
  const remoteUploadTimeoutValue =
    parsed.remoteCacheTimeoutSeconds ??
    configuredRemoteUploadTimeout ??
    remoteConfiguration?.uploadTimeout ??
    remoteConfiguration?.timeout ??
    30;
  const remoteUploadTimeoutPath =
    parsed.remoteCacheTimeoutSeconds !== undefined
      ? "<arguments>"
      : configuredRemoteUploadTimeout !== undefined
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
        : configuredApiUrl !== undefined
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
      if (parsedApiUrl.username !== "" || parsedApiUrl.password !== "") {
        throw new TypeError("remote cache URL credentials are not supported");
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
        environmentValue("TURBO_TEAMID") ??
        remoteConfiguration?.teamId ??
        undefined,
      teamSlug:
        parsed.team ??
        environmentValue("TURBO_TEAM") ??
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
    globalDependencies: parsed.globalDependencies,
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
    cachePolicy: parseCachePolicy(parsed, environmentValue),
    force:
      parsed.force ||
      environmentBoolean(environmentValue("TURBO_FORCE")) === true,
    frameworkInference: parsed.frameworkInference ?? true,
    outputLogs: parsed.outputLogs,
    only: parsed.only,
    parallel: parsed.parallel,
    remote,
    colorEnabled: !parsed.noColor && environmentValue("NO_COLOR") === undefined,
    json: parsed.json,
    ui: parsed.ui ?? value.ui ?? global?.ui ?? "stream",
    logOrder: parsed.logOrder ?? "auto",
    logPrefix: parsed.logPrefix ?? "auto",
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

interface RunExecutionContext {
  readonly changedPaths?: ReadonlyArray<string>;
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

const affectedPackagesFromChangedFiles = (
  repository: RepositoryModel,
  changedFiles: ReadonlyArray<string>,
  globalInputsAreTaskAware: boolean,
  windowsPathSeparators: boolean,
): AffectedPackages => {
  const globalDependencyPatterns =
    repository.rootConfiguration.value.futureFlags?.globalConfiguration === true
      ? globalInputsAreTaskAware
        ? []
        : (repository.rootConfiguration.value.global?.inputs ?? [])
      : (repository.rootConfiguration.value.globalDependencies ?? []);
  const globalDependencyChanged =
    selectByGlobs(changedFiles, globalDependencyPatterns, windowsPathSeparators)
      .length > 0;
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
  const gitIgnoreChanged = changedFiles.some(
    (path) => path === ".gitignore" || path.endsWith("/.gitignore"),
  );
  const rootChanged =
    globalDependencyChanged ||
    rootConfigurationChanged ||
    gitIgnoreChanged ||
    (!globalInputsAreTaskAware && ordinaryRootChanged);
  return {
    packages: rootChanged
      ? new Set(
          repository.packages.map((packageModel) => packageModel.identity),
        )
      : new Set(
          repository.packages
            .filter((packageModel) =>
              changedFiles.some(
                (path) =>
                  packageRelativeChangedFile(packageModel, path) !== undefined,
              ),
            )
            .map((packageModel) => packageModel.identity),
        ),
    changedFiles,
    rootChanged,
  };
};

const gitRangeSelector = (rawFilter: string): string | undefined => {
  return parsePackageFilter(rawFilter).gitRangeSelector;
};

const filterTraversal = (
  rawFilter: string,
): { readonly dependencies: boolean; readonly dependents: boolean } => {
  const filter = parsePackageFilter(rawFilter);
  return {
    dependents: filter.includeDependents,
    dependencies: filter.includeDependencies,
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
    const explicitBase = configuredEnvironmentValue(
      environment,
      "TURBO_SCM_BASE",
      windowsPathSeparators,
    );
    const githubBase = configuredEnvironmentValue(
      environment,
      "GITHUB_BASE_REF",
      windowsPathSeparators,
    );
    const base = range?.base ?? explicitBase ?? githubBase ?? "main";
    const head =
      range?.head ??
      configuredEnvironmentValue(
        environment,
        "TURBO_SCM_HEAD",
        windowsPathSeparators,
      ) ??
      "HEAD";
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
          repository.packages.map((packageModel) => packageModel.identity),
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
    return affectedPackagesFromChangedFiles(
      repository,
      changedFiles,
      globalInputsAreTaskAware,
      windowsPathSeparators,
    );
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
  runtimeEnvironment: Readonly<Record<string, string | undefined>>,
  windowsPathSeparators: boolean,
): boolean => {
  const rootRelativeInputPrefix = "$TURBO_ROOT$/";
  const isRootPackage = node.package.relativeDirectory === ".";
  const inputs = effectiveTaskInputs(repository, node);
  const implicitInputs = new Set(
    implicitTaskInputCandidates(
      repository,
      node,
      runtimeEnvironment,
      windowsPathSeparators,
    ).map((path) => relativePath(repository.root, path)),
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
  packageIdentities: ReadonlySet<string> | undefined,
  sourceEnvironment: Readonly<Record<string, string | undefined>>,
  environmentMode: "loose" | "strict",
  frameworkInference: boolean,
  windowsPathSeparators: boolean,
): ReadonlySet<string> => {
  const matchingNodes = new Set(
    [...graph.nodes]
      .filter(
        ([, node]) =>
          (packageIdentities === undefined ||
            packageIdentities.has(node.package.identity)) &&
          (rootChanged ||
            taskMatchesChangedFiles(
              repository,
              node,
              changedFiles,
              node.package.manager === "uv"
                ? taskEnvironment(
                    repository,
                    node,
                    sourceEnvironment,
                    environmentMode,
                    frameworkInference,
                    windowsPathSeparators,
                  )
                : {},
              windowsPathSeparators,
            )),
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
    const matchingPackageIdentities = new Set(
      [...matchingNodes].flatMap((id) => {
        const identity = graph.nodes.get(id)?.package.identity;
        return identity === undefined || identity === "//" ? [] : [identity];
      }),
    );
    const prefix = traversal.dependents ? "..." : "";
    const suffix = traversal.dependencies ? "..." : "";
    const expandedPackageIdentities = new Set(
      matchingPackageIdentities.size === 0
        ? []
        : selectPackages(
            repository,
            [...matchingPackageIdentities].map(
              (identity) => `${prefix}${identity}${suffix}`,
            ),
          ).map((packageModel) => packageModel.identity),
    );
    for (const identity of matchingPackageIdentities) {
      expandedPackageIdentities.delete(identity);
    }
    for (const id of graph.entrypoints) {
      const node = graph.nodes.get(id)!;
      if (
        node.command !== undefined &&
        expandedPackageIdentities.has(node.package.identity)
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
  retainedPackageIdentities: ReadonlySet<string> = new Set(),
  sourceEnvironment: Readonly<Record<string, string | undefined>> = {},
  environmentMode: "loose" | "strict" = "strict",
  frameworkInference = true,
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
          retainedPackageIdentities.has(graph.nodes.get(id)!.package.identity),
        ),
  );
  for (const { filter, affected } of positiveFilters) {
    const packageIdentities = packageFilterComponentIdentities(
      repository,
      parsePackageFilter(filter),
    );
    for (const id of affectedTaskEntrypoints(
      repository,
      graph,
      affected.changedFiles,
      affected.rootChanged,
      filter,
      packageIdentities,
      sourceEnvironment,
      environmentMode,
      frameworkInference,
      windowsPathSeparators,
    )) {
      retainedEntrypoints.add(id);
    }
  }
  for (const { filter, affected } of rangeFilters.filter(({ filter }) =>
    filter.startsWith("!"),
  )) {
    const packageIdentities = packageFilterComponentIdentities(
      repository,
      parsePackageFilter(filter),
    );
    for (const id of affectedTaskEntrypoints(
      repository,
      graph,
      affected.changedFiles,
      affected.rootChanged,
      filter,
      packageIdentities,
      sourceEnvironment,
      environmentMode,
      frameworkInference,
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
  preserveExcludedDescendants = false,
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
        const negativePatterns = patterns.flatMap((pattern) =>
          pattern.startsWith("!") ? [pattern.slice(1)] : [],
        );
        const files = yield* listRepositoryFiles(directory, {
          ignoredDirectories: new Set([".git"]),
          includeDirectories: true,
          includeOtherEntries: true,
          shouldTraverseDirectory: (relativeDirectory) => {
            const path = normalizePath(
              `${directory}/${relativeDirectory}`,
              windowsPathSeparators,
            );
            return (
              !isPathContained(cacheDirectory, path, windowsPathSeparators) &&
              positivePatterns.some((pattern) =>
                canMatchGlobDescendant(
                  relativeDirectory,
                  pattern,
                  windowsPathSeparators,
                ),
              )
            );
          },
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
          const matchesOutput = matchesGlobsWithExclusions(
            candidates,
            patterns,
            windowsPathSeparators,
          );
          if (
            metadata.kind === "symlink" &&
            !matchesOutput &&
            positivePatterns.some((pattern) =>
              canMatchGlobDescendant(relative, pattern, windowsPathSeparators),
            )
          ) {
            return yield* Effect.fail(
              new RepositoryError({
                path,
                message:
                  "declared task output has an untraversed symlink ancestor",
              }),
            );
          }
          const canContainExcludedDescendant =
            metadata.kind === "directory" &&
            negativePatterns.some((pattern) =>
              canMatchGlobDescendant(relative, pattern, windowsPathSeparators),
            );
          if (
            matchesOutput &&
            !(preserveExcludedDescendants && canContainExcludedDescendant)
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
      if (metadata.kind === "other") {
        return yield* Effect.fail(
          new RepositoryError({
            path,
            message: "declared task output has an unsupported filesystem type",
          }),
        );
      }
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
      windowsPathSeparators,
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
  | {
      readonly kind: "chunk";
      readonly output: string;
      readonly level: "stdout" | "stderr";
    }
  | { readonly kind: "end" };

const persistentOutputCaptureCharacters = 64 * 1024;
const persistentOutputQueueCapacity = 16;

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

const cargoAlternateOutputFlags = [
  "--artifact-dir",
  "--manifest-path",
  "--out-dir",
  "--profile",
  "--target",
  "--target-dir",
  "--timings",
] as const;

const cargoAdditionalPackageFlags = [
  "--all",
  "--package",
  "--workspace",
] as const;

const cargoUnmodeledTargetFlags = [
  "--all-targets",
  "--bench",
  "--benches",
  "--bin",
  "--bins",
  "--example",
  "--examples",
  "--lib",
  "--test",
  "--tests",
  ...cargoAdditionalPackageFlags,
] as const;

const usesAlternateCargoCompilationOutputs = (
  node: TaskNode,
  passThroughArguments: ReadonlyArray<string>,
): boolean =>
  isCargoCompilationTask(node) &&
  passThroughArguments.some(
    (argument) =>
      argument === "--release" ||
      argument === "-r" ||
      argument.startsWith("-p") ||
      [...cargoAlternateOutputFlags, ...cargoUnmodeledTargetFlags].some(
        (flag) => argument === flag || argument.startsWith(`${flag}=`),
      ),
  );

const uvAlternateProjectFlags = ["--directory", "--project"] as const;

const usesAlternateUvBuildOutputs = (
  node: TaskNode,
  passThroughArguments: ReadonlyArray<string>,
): boolean =>
  node.package.manager === "uv" &&
  node.task === "build" &&
  passThroughArguments.some(
    (argument) =>
      argument.startsWith("-o") ||
      argument === "--out-dir" ||
      argument.startsWith("--out-dir=") ||
      uvAlternateProjectFlags.some(
        (flag) => argument === flag || argument.startsWith(`${flag}=`),
      ),
  );

const usesUvConfigurationOverride = (
  node: TaskNode,
  passThroughArguments: ReadonlyArray<string>,
): boolean =>
  node.package.manager === "uv" &&
  node.task === "build" &&
  passThroughArguments.some(
    (argument) =>
      argument === "--config-file" || argument.startsWith("--config-file="),
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

const cargoCompilerEnvironmentOverrides = [
  "RUSTC",
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
] as const;

const usesEnvironmentRustCompilerOverride = (
  environment: Readonly<Record<string, string | undefined>>,
  caseInsensitiveEnvironmentNames: boolean,
): boolean =>
  Object.entries(environment).some(
    ([name, value]) =>
      value !== undefined &&
      cargoCompilerEnvironmentOverrides.some((override) =>
        caseInsensitiveEnvironmentNames
          ? name.toLowerCase() === override.toLowerCase()
          : name === override,
      ),
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
  isCargoCompilationTask(node) &&
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

const taskLogPath = (
  node: TaskNode,
  scope: TaskCommandScope | undefined,
  identifier = node.task,
): string =>
  joinPath(
    taskExecutionDirectory(node, scope),
    ".turbo",
    `turbo-${encodeTaskLogIdentifier(identifier)}.log`,
  );

const emptyExternalDependenciesHash = "459c029558afe716";

const taskExternalDependenciesHash = (
  repository: RepositoryModel,
  node: TaskNode,
): Effect.Effect<string, RepositoryError, FileSystemService> =>
  Effect.gen(function* () {
    const lockfile = yield* owningLockfile(repository, node);
    if (lockfile === undefined) return emptyExternalDependenciesHash;
    const fileSystem = yield* FileSystemService;
    const contents = yield* fileSystem
      .readBytes(lockfile)
      .pipe(
        Effect.mapError(
          (error) =>
            new RepositoryError({ path: lockfile, message: error.message }),
        ),
      );
    const internalNames = new Set([
      node.package.name,
      ...node.package.internalDependencies.flatMap((identity) => {
        const dependency = repository.packagesByIdentity.get(identity);
        return dependency === undefined ? [] : [dependency.name];
      }),
    ]);
    const manifestDependencyReferences = new Map(
      [
        node.package.manifest.dependencies,
        node.package.manifest.devDependencies,
        node.package.manifest.optionalDependencies,
        node.package.manifest.peerDependencies,
      ].flatMap((dependencies) => Object.entries(dependencies ?? {})),
    );
    const directExternalDependencies = node.package.dependencyNames
      .filter((name) => !internalNames.has(name))
      .map((name) => [name, manifestDependencyReferences.get(name)] as const);
    const dependencies = yield* Effect.try({
      try: () =>
        resolveLockfilePackageClosure(lockfile, contents, {
          workspacePath: node.package.relativeDirectory,
          packageName: node.package.name,
          packageVersion: node.package.manifest.version,
          directDependencies: directExternalDependencies,
        }),
      catch: (cause) =>
        new RepositoryError({ path: lockfile, message: String(cause) }),
    });
    const identities = [
      ...new Set(
        dependencies.flatMap((dependency) =>
          internalNames.has(dependency.name)
            ? []
            : [`${dependency.name}@${dependency.version}`],
        ),
      ),
    ].sort();
    return identities.length === 0
      ? emptyExternalDependenciesHash
      : xxhash64Hex(JSON.stringify(identities));
  });

const taskLogIdentifiers = (
  repository: RepositoryModel,
  graph: TaskGraph,
  scopes: ReadonlyMap<string, TaskCommandScope> = new Map(),
  caseInsensitivePaths = false,
): ReadonlyMap<string, string> => {
  const repositoryPackages = [repository.rootPackage, ...repository.packages];
  const comparableDirectory = (directory: string): string => {
    const normalized = normalizePath(directory);
    return caseInsensitivePaths ? normalized.toLowerCase() : normalized;
  };
  const hasRepositoryCollision = (node: TaskNode): boolean => {
    const directory = comparableDirectory(
      taskExecutionDirectory(node, scopes.get(node.id)),
    );
    return repositoryPackages.some(
      (packageModel) =>
        packageModel.identity !== node.package.identity &&
        comparableDirectory(packageModel.directory) === directory &&
        !packageModel.excludedTasks.has(node.task) &&
        packageModel.scripts[node.task] !== undefined,
    );
  };
  const nodesByLogPath = new Map<string, Array<TaskNode>>();
  for (const node of graph.nodes.values()) {
    const directory = comparableDirectory(
      taskExecutionDirectory(node, scopes.get(node.id)),
    );
    const key = `${directory}\0${encodeTaskLogIdentifier(node.task)}`;
    const nodes = nodesByLogPath.get(key) ?? [];
    nodes.push(node);
    nodesByLogPath.set(key, nodes);
  }
  return new Map(
    [...nodesByLogPath.values()].flatMap((nodes) =>
      nodes.map(
        (node) =>
          [
            node.id,
            nodes.length > 1 || hasRepositoryCollision(node)
              ? node.id
              : node.task,
          ] as const,
      ),
    ),
  );
};

const usesAdditionalCargoPackageSelection = (
  node: TaskNode,
  passThroughArguments: ReadonlyArray<string>,
): boolean =>
  isCargoCompilationTask(node) &&
  passThroughArguments.some(
    (argument) =>
      argument.startsWith("-p") ||
      cargoAdditionalPackageFlags.some(
        (flag) => argument === flag || argument.startsWith(`${flag}=`),
      ),
  );

const usesCargoConfigurationOverride = (
  node: TaskNode,
  passThroughArguments: ReadonlyArray<string>,
): boolean =>
  isCargoCompilationTask(node) &&
  passThroughArguments.some(
    (argument) => argument === "--config" || argument.startsWith("--config="),
  );

const isTaskScopeStaticallyCacheable = (
  node: TaskNode,
  scope: TaskCommandScope,
): boolean =>
  (scope.kind === "cargo-workspace" ? scope.members : [node]).every(
    (member) =>
      member.package.cachePathRestorable &&
      member.package.cacheInputsComplete &&
      member.definition.cache !== false &&
      member.definition.persistent !== true,
  );

export const isTaskScopeDynamicallyCacheable = (
  node: TaskNode,
  passThroughArguments: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>> = {},
  caseInsensitiveEnvironmentNames = false,
  sourceEnvironment: Readonly<Record<string, string | undefined>> = environment,
  cargoHomeHasConfiguration = false,
  packageManagerUserHasConfiguration = false,
  uvHasExternalControls = false,
  uvRuntimeIdentityAvailable = true,
  packageManagerRuntimeIdentityAvailable = true,
): boolean =>
  !usesAlternateCargoCompilationOutputs(node, passThroughArguments) &&
  !usesAdditionalCargoPackageSelection(node, passThroughArguments) &&
  !usesCargoConfigurationOverride(node, passThroughArguments) &&
  !usesAlternateUvBuildOutputs(node, passThroughArguments) &&
  !usesUvConfigurationOverride(node, passThroughArguments) &&
  !(
    isCargoCompilationTask(node) &&
    usesEnvironmentCargoBuildTarget(
      environment,
      caseInsensitiveEnvironmentNames,
    )
  ) &&
  !(
    isCargoCompilationTask(node) &&
    usesEnvironmentRustCompilerOverride(
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
  !(isCargoCompilationTask(node) && cargoHomeHasConfiguration) &&
  !(
    (node.package.manager === "npm" ||
      node.package.manager === "pnpm" ||
      node.package.manager === "yarn") &&
    packageManagerUserHasConfiguration
  ) &&
  !(
    node.package.manager === "uv" &&
    (uvHasExternalControls || !uvRuntimeIdentityAvailable)
  ) &&
  !(
    node.package.manager !== "cargo" &&
    node.package.manager !== "uv" &&
    !packageManagerRuntimeIdentityAvailable
  );

export const isTaskScopeCacheable = (
  node: TaskNode,
  passThroughArguments: ReadonlyArray<string>,
  scope: TaskCommandScope = packageTaskCommandScope,
  environment: Readonly<Record<string, string | undefined>> = {},
  caseInsensitiveEnvironmentNames = false,
  sourceEnvironment: Readonly<Record<string, string | undefined>> = environment,
  cargoHomeHasConfiguration = false,
  packageManagerUserHasConfiguration = false,
  uvHasExternalControls = false,
  uvRuntimeIdentityAvailable = true,
  packageManagerRuntimeIdentityAvailable = true,
): boolean =>
  isTaskScopeStaticallyCacheable(node, scope) &&
  isTaskScopeDynamicallyCacheable(
    node,
    passThroughArguments,
    environment,
    caseInsensitiveEnvironmentNames,
    sourceEnvironment,
    cargoHomeHasConfiguration,
    packageManagerUserHasConfiguration,
    uvHasExternalControls,
    uvRuntimeIdentityAvailable,
    packageManagerRuntimeIdentityAvailable,
  );

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
  runtimeUnrestorableTaskIds: ReadonlySet<string> = new Set(),
): ReadonlySet<string> => {
  const uncacheable = new Set<string>();
  for (const id of topologicalOrder(hashDependencyGraph(graph))) {
    const node = graph.nodes.get(id)!;
    const scope = scopes.get(id);
    const scopeNodes =
      scope?.kind === "cargo-workspace" ? scope.members : [node];
    if (
      runtimeUnrestorableTaskIds.has(id) ||
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

interface TaskScopeCacheability {
  readonly cacheable: boolean;
  readonly runtimeInputsRestorable: boolean;
  readonly packageManagerRuntimeIdentity?: PackageManagerRuntimeIdentity;
  readonly uvRuntimeIdentity?: UvRuntimeIdentity;
}

const resolveTaskScopeCacheability = (
  repository: RepositoryModel,
  node: TaskNode,
  options: ResolvedRunOptions,
  sourceEnvironment: Readonly<Record<string, string | undefined>>,
  scope: TaskCommandScope = packageTaskCommandScope,
  caseInsensitiveEnvironmentNames = false,
): Effect.Effect<
  TaskScopeCacheability,
  RepositoryError,
  FileSystemService | ProcessService
> =>
  Effect.gen(function* () {
    const executionEnvironment = taskScopeEnvironment(
      repository,
      node,
      sourceEnvironment,
      options.environmentMode,
      options.frameworkInference,
      scope,
      caseInsensitiveEnvironmentNames,
    );
    const executionDirectory = taskExecutionDirectory(node, scope);
    const cargoHomeHasConfiguration = isCargoCompilationTask(node)
      ? yield* cargoHomeConfigurationPresent(
          executionDirectory,
          executionEnvironment,
          caseInsensitiveEnvironmentNames,
        )
      : false;
    const packageManagerUserHasConfiguration =
      node.package.manager === "npm" || node.package.manager === "pnpm"
        ? yield* npmUserConfigurationPresent(
            executionDirectory,
            executionEnvironment,
            caseInsensitiveEnvironmentNames,
          )
        : node.package.manager === "yarn"
          ? yield* yarnUserConfigurationPresent(
              executionEnvironment,
              caseInsensitiveEnvironmentNames,
            )
          : false;
    const uvHasExternalControls =
      node.package.manager === "uv"
        ? (yield* uvControlInputs(
            repository.root,
            executionDirectory,
            node.package.workspaceDirectory ?? executionDirectory,
            executionEnvironment,
            caseInsensitiveEnvironmentNames,
          )).external
        : false;
    const resolvedUvRuntimeIdentity =
      node.package.manager === "uv"
        ? yield* resolveUvRuntimeIdentity(
            executionDirectory,
            executionEnvironment,
          )
        : undefined;
    const cacheTransportEnabled =
      options.cachePolicy.localRead ||
      options.cachePolicy.localWrite ||
      (options.remote !== undefined &&
        (options.cachePolicy.remoteRead || options.cachePolicy.remoteWrite));
    const packageManagerRuntimeIdentityRequired =
      node.command !== undefined &&
      cacheTransportEnabled &&
      isTaskScopeStaticallyCacheable(node, scope) &&
      !packageManagerUserHasConfiguration &&
      node.package.manager !== "cargo" &&
      node.package.manager !== "uv";
    const resolvedPackageManagerRuntimeIdentity =
      packageManagerRuntimeIdentityRequired
        ? yield* resolvePackageManagerRuntimeIdentity(
            node.package.manager,
            executionDirectory,
            executionEnvironment,
          )
        : undefined;
    const runtimeInputsRestorable = isTaskScopeDynamicallyCacheable(
      node,
      options.passThroughArguments,
      executionEnvironment,
      caseInsensitiveEnvironmentNames,
      sourceEnvironment,
      cargoHomeHasConfiguration,
      packageManagerUserHasConfiguration,
      uvHasExternalControls,
      resolvedUvRuntimeIdentity !== undefined,
      !packageManagerRuntimeIdentityRequired ||
        resolvedPackageManagerRuntimeIdentity !== undefined,
    );
    return {
      cacheable:
        isTaskScopeStaticallyCacheable(node, scope) && runtimeInputsRestorable,
      runtimeInputsRestorable,
      ...(resolvedPackageManagerRuntimeIdentity === undefined
        ? {}
        : {
            packageManagerRuntimeIdentity:
              resolvedPackageManagerRuntimeIdentity,
          }),
      ...(resolvedUvRuntimeIdentity === undefined
        ? {}
        : { uvRuntimeIdentity: resolvedUvRuntimeIdentity }),
    };
  });

const executeTask = (
  repository: RepositoryModel,
  node: TaskNode,
  options: ResolvedRunOptions,
  hash: TaskHashResult,
  sourceEnvironment: Readonly<Record<string, string | undefined>>,
  scope: TaskCommandScope = packageTaskCommandScope,
  cacheable = true,
  withCachePublicationPermit: CachePublicationPermit = (publication) =>
    publication,
  logIdentifier = node.task,
  withOutputPermit: OutputPermit = (output) => output,
  writeStructuredRecord: WriteStructuredRecord = () => Effect.void,
): Effect.Effect<TaskExecutionResult, unknown, RunRequirements> =>
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
    const taskLabel = `${node.package.name}:${node.task}`;
    const prefixTask = options.logPrefix !== "none";
    const taskRecord = (
      timestamp: number,
      level: "info" | "stdout" | "stderr",
      text: string,
    ) =>
      ({
        type: "task_event",
        timestamp,
        source: taskLabel,
        level,
        text,
      }) as const;
    const writeTaskEvent = (
      level: "info" | "stdout" | "stderr",
      text: string,
      recordStructuredOutput = true,
    ) =>
      clock.now.pipe(
        Effect.flatMap((timestamp) => {
          const record = taskRecord(timestamp, level, text);
          return (
            recordStructuredOutput ? writeStructuredRecord(record) : Effect.void
          ).pipe(
            Effect.zipRight(
              options.json
                ? terminal.writeStdout(`${JSON.stringify(record)}\n`)
                : options.ui === "tui"
                  ? Effect.void
                  : terminal.writeStdout(
                      options.ui === "stream-with-experimental-timestamps"
                        ? renderTimestampedStreamText(timestamp, text)
                        : text,
                    ),
            ),
          );
        }),
      );
    const writeTaskWarning = (message: string) =>
      clock.now.pipe(
        Effect.flatMap((timestamp) =>
          writeStructuredRecord(taskRecord(timestamp, "stderr", message)).pipe(
            Effect.zipRight(
              terminal.writeStderr(
                renderLogEvent({ kind: "warning", message }, warningColor),
              ),
            ),
          ),
        ),
      );
    if (node.command === undefined) {
      return { id: node.id, exitCode: 0, hash: hash.hash, skipped: false };
    }
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
    const executionDirectory = taskExecutionDirectory(node, scope);
    const localOptions = {
      directory: options.cacheDirectory,
      maxAgeMilliseconds: options.cacheMaxAgeMilliseconds,
      maxSizeBytes: options.cacheMaxSizeBytes,
    };
    const logPath = taskLogPath(node, scope, logIdentifier);
    const replayTaskLog = (recordOutput: boolean) =>
      Effect.gen(function* () {
        const hasLog = yield* fileSystem
          .exists(logPath)
          .pipe(
            Effect.mapError(
              (error) =>
                new RepositoryError({ path: logPath, message: error.message }),
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
              const timestamp = yield* clock.now;
              const record = taskRecord(timestamp, "stdout", output);
              if (recordOutput) yield* writeStructuredRecord(record);
              if (options.json) {
                yield* terminal.writeStdout(`${JSON.stringify(record)}\n`);
                return;
              }
              const rendered = renderTaskOutputChunk(
                renderState,
                taskLabel,
                output,
                color,
                prefixTask,
              );
              renderState = rendered.state;
              for (const chunk of rendered.chunks) {
                yield* terminal.writeStdout(
                  options.ui === "stream-with-experimental-timestamps"
                    ? renderTimestampedStreamText(timestamp, chunk)
                    : chunk,
                );
              }
            }),
          ),
        );
        if (!options.json) {
          for (const chunk of finishTaskOutput(renderState)) {
            yield* terminal.writeStdout(
              options.ui === "stream-with-experimental-timestamps"
                ? renderTimestampedStreamText(yield* clock.now, chunk)
                : chunk,
            );
          }
        }
      });
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
          true,
        ).pipe(
          Effect.map((paths) =>
            paths.map((path) =>
              relativePath(repository.root, path, platform === "win32"),
            ),
          ),
          Effect.catchTag("RepositoryError", (error) =>
            writeTaskWarning(
              `cache restore preparation failed for ${taskLabel}; executing task locally without cache reads: ${error.message}`,
            ).pipe(Effect.ignore, Effect.as(undefined)),
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
    let cacheSource: TaskExecutionResult["cacheSource"];
    let cacheTimeSaved = 0;
    if (cacheRestoreEnabled && options.cachePolicy.localRead) {
      cacheHit = yield* restoreLocalCache(
        repository.root,
        localOptions,
        hash.hash,
        restoreScope,
        platform === "win32",
        (duration) => {
          cacheSource = "local";
          cacheTimeSaved = duration;
        },
      ).pipe(
        Effect.catchTag("CacheError", (error) =>
          writeTaskWarning(
            `local cache restore failed for ${taskLabel}; continuing without local cache: ${error.message}`,
          ).pipe(Effect.ignore, Effect.as(false)),
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
        platform === "win32",
        (duration) => {
          cacheSource = "remote";
          cacheTimeSaved = duration;
        },
      ).pipe(
        Effect.catchTag("CacheError", (error) =>
          writeTaskWarning(
            `remote cache restore failed for ${taskLabel}; executing task locally: ${error.message}`,
          ).pipe(Effect.ignore, Effect.as(false)),
        ),
      );
    }
    if (cacheHit) {
      if (outputMode !== "none" && showHashEvent) {
        yield* writeTaskEvent(
          "info",
          renderLogEvent(
            { kind: "cache-hit", task: taskLabel, hash: hash.hash },
            color,
            options.json ? false : prefixTask,
          ),
        );
      }
      if (shouldReplayOutput(outputMode, true)) {
        yield* withOutputPermit(replayTaskLog(true)).pipe(
          Effect.catchAll((error) =>
            writeTaskWarning(
              `cached log replay failed for ${taskLabel}; preserving successful cache hit: ${String(error)}`,
            ).pipe(Effect.ignore),
          ),
        );
      }
      return {
        id: node.id,
        exitCode: 0,
        hash: hash.hash,
        skipped: false,
        cacheSource,
        cacheTimeSaved,
      };
    }
    if (outputMode !== "none" && showHashEvent) {
      yield* writeTaskEvent(
        "info",
        renderLogEvent(
          { kind: "cache-miss", task: taskLabel, hash: hash.hash },
          color,
          options.json ? false : prefixTask,
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
    const startProcess = (
      onOutputChunk?: (
        chunk: string,
        level: "stdout" | "stderr",
      ) => void | PromiseLike<void>,
    ) =>
      processService.run({
        command: invocation.command,
        args: invocation.arguments,
        cwd: invocation.cwd,
        inheritEnvironment: false,
        stdio:
          node.definition.interactive === true && !options.json
            ? "inherit"
            : "capture",
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
    const streamsCapturedOutput =
      node.definition.interactive !== true || options.json;
    const displaysStreamedOutput =
      streamsCapturedOutput &&
      shouldReplayOutput(outputMode, false) &&
      options.logOrder !== "grouped" &&
      options.ui !== "tui";
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
                  if (!displaysStreamedOutput) {
                    yield* clock.now.pipe(
                      Effect.flatMap((timestamp) =>
                        writeStructuredRecord(
                          taskRecord(timestamp, event.level, event.output),
                        ),
                      ),
                    );
                    continue;
                  }
                  if (options.json) {
                    yield* writeTaskEvent(event.level, event.output);
                    continue;
                  }
                  const rendered = renderTaskOutputChunk(
                    renderState,
                    taskLabel,
                    event.output,
                    color,
                    prefixTask,
                  );
                  renderState = rendered.state;
                  for (const chunk of rendered.chunks) {
                    yield* writeTaskEvent(event.level, chunk);
                  }
                }
              }),
            );
            const processResult = yield* Effect.raceFirst(
              startProcess((output, level) =>
                Effect.runPromise(
                  Queue.offer(outputQueue, {
                    kind: "chunk",
                    output,
                    level,
                  }).pipe(Effect.asVoid),
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
    const replayCompletedOutput =
      shouldReplayOutput(outputMode, false) ||
      (outputMode === "errors-only" && result.exitCode !== 0);
    if (
      !displaysStreamedOutput &&
      replayCompletedOutput &&
      options.ui !== "tui"
    ) {
      if (options.logOrder === "grouped" && streamsCapturedOutput) {
        yield* withOutputPermit(replayTaskLog(false));
      } else {
        yield* writeTaskEvent(
          "stdout",
          renderLogEvent(
            { kind: "task-output", task: taskLabel, output },
            color,
            options.json ? false : prefixTask,
          ),
          !streamsCapturedOutput,
        );
      }
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
              writeTaskWarning(
                `cache output collection failed for ${taskLabel}; skipping cache publication while preserving successful task result: ${error.message}`,
              ).pipe(Effect.ignore, Effect.as(undefined)),
            ),
          );
          if (collected === undefined) return;
          if (collected.kind === "too-large") {
            yield* writeTaskWarning(
              `cache write skipped for ${taskLabel}; ${collected.inputBytes} bytes of task outputs exceed the ${maximumCacheArchiveInputBytes} byte safety limit`,
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
              platform === "win32",
            ).pipe(
              Effect.catchAll((error) =>
                writeTaskWarning(
                  `local cache write failed for ${taskLabel}; preserving successful task result: ${error.message}`,
                ).pipe(Effect.ignore),
              ),
            );
          }
          if (options.cachePolicy.remoteWrite && options.remote !== undefined) {
            yield* writeRemoteCache(
              options.remote,
              hash.hash,
              collected.entries,
              duration,
              platform === "win32",
            ).pipe(
              Effect.catchAll((error) =>
                writeTaskWarning(
                  `remote cache upload failed for ${taskLabel}; preserving successful task result: ${error.message}`,
                ).pipe(Effect.ignore),
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
  sourceEnvironment: Readonly<Record<string, string | undefined>>,
  caseInsensitiveEnvironmentNames: boolean,
  cacheabilityByTask: ReadonlyMap<string, TaskScopeCacheability>,
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
        taskScopeEnvironment(
          repository,
          node,
          sourceEnvironment,
          options.environmentMode,
          options.frameworkInference,
          packageTaskCommandScope,
          caseInsensitiveEnvironmentNames,
        ),
        cacheabilityByTask.get(id)?.uvRuntimeIdentity,
        cacheabilityByTask.get(id)?.packageManagerRuntimeIdentity,
        options.globalDependencies,
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
    const groupedPackageIdentities = new Set(
      members.map((member) => member.package.identity),
    );
    if (
      !hasCompatibleCargoWorkspaceRuntime(members) ||
      workspaceMembers.some(
        (packageModel) =>
          packageModel.tasks[representative.task] === undefined ||
          !groupedPackageIdentities.has(packageModel.identity),
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
  sourceEnvironment: Readonly<Record<string, string | undefined>>,
  caseInsensitiveEnvironmentNames: boolean,
  cacheabilityByTask: ReadonlyMap<string, TaskScopeCacheability>,
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
          taskScopeEnvironment(
            repository,
            node,
            sourceEnvironment,
            options.environmentMode,
            options.frameworkInference,
            packageTaskCommandScope,
            caseInsensitiveEnvironmentNames,
          ),
          cacheabilityByTask.get(id)?.uvRuntimeIdentity,
          cacheabilityByTask.get(id)?.packageManagerRuntimeIdentity,
          options.globalDependencies,
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
  context: RunExecutionContext = {},
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
      platform === "win32",
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
    const terminal = yield* TerminalService;
    const stdinIsTerminal =
      terminal.stdinIsTerminal === undefined
        ? false
        : yield* terminal.stdinIsTerminal;
    const stdoutIsTerminal =
      terminal.stdoutIsTerminal === undefined
        ? false
        : yield* terminal.stdoutIsTerminal;
    const options: ResolvedRunOptions = {
      ...unresolvedOptions,
      ui: resolveRunUiMode(
        unresolvedOptions.ui,
        stdinIsTerminal,
        stdoutIsTerminal,
        unresolvedOptions.json,
      ),
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
    const repository = yield* discoverRepository(options.root, configuration, {
      singlePackage: parsed.singlePackage,
    });
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
    const packageManagerCheckDisabled =
      parsed.dangerouslyDisablePackageManagerCheck ||
      environmentBoolean(
        configuredEnvironmentValue(
          environment,
          "TURBO_DANGEROUSLY_DISABLE_PACKAGE_MANAGER_CHECK",
          platform === "win32",
        ),
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
    const watchChanges =
      flags?.watchUsingTaskInputs === true && context.changedPaths !== undefined
        ? affectedPackagesFromChangedFiles(
            repository,
            context.changedPaths.map((path) =>
              relativePath(repository.root, path),
            ),
            true,
            platform === "win32",
          )
        : undefined;
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
    const retainedPackageIdentities = new Set(
      !useTaskInputs || positivePackageFilters.length === 0
        ? []
        : selectPackages(
            repository,
            [...positivePackageFilters, ...negativePackageFilters],
            affected.ranges,
          ).map((packageModel) => packageModel.identity),
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
    const entrypointNodes = validationGraph.entrypoints.map(
      (entrypoint) => validationGraph.nodes.get(entrypoint)!,
    );
    const unresolvedTasks = [
      ...new Set(
        options.tasks.filter((task) => {
          if (task.startsWith("//#")) return !entrypointIds.has(task);
          const separator = task.indexOf("#");
          if (separator === -1) {
            return !entrypointNodes.some((node) => node.task === task);
          }
          const packageSelector = task.slice(0, separator);
          const taskName = task.slice(separator + 1);
          return !entrypointNodes.some(
            (node) =>
              node.task === taskName &&
              (node.package.identity === packageSelector ||
                node.package.name === packageSelector),
          );
        }),
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
    const affectedGraph = useTaskInputs
      ? selectAffectedTasks(
          repository,
          unfilteredGraph,
          affected.filters,
          affected.affectedBySelector,
          retainedPackageIdentities,
          environment,
          options.environmentMode,
          options.frameworkInference,
          platform === "win32",
        )
      : unfilteredGraph;
    const selectedGraph =
      watchChanges === undefined
        ? affectedGraph
        : retainTaskEntrypoints(
            affectedGraph,
            affectedTaskEntrypoints(
              repository,
              affectedGraph,
              watchChanges.changedFiles,
              watchChanges.rootChanged,
              "",
              undefined,
              environment,
              options.environmentMode,
              options.frameworkInference,
              platform === "win32",
            ),
          );
    const cargoWorkspacePlan = planCargoWorkspaceTasks(
      repository,
      selectedGraph,
      options.tasks,
      affected.filters.length === 0,
    );
    const graph = cargoWorkspacePlan.graph;
    const cacheabilityByTask = new Map(
      yield* Effect.forEach(
        [...graph.nodes],
        ([id, node]) =>
          resolveTaskScopeCacheability(
            repository,
            node,
            options,
            environment,
            cargoWorkspacePlan.scopes.get(id),
            platform === "win32",
          ).pipe(Effect.map((cacheability) => [id, cacheability] as const)),
        { concurrency: 8 },
      ),
    );
    const hashes = yield* applyCargoWorkspaceHashes(
      repository,
      graph,
      yield* computeTaskHashes(
        repository,
        selectedGraph,
        options,
        environment,
        platform === "win32",
        cacheabilityByTask,
      ),
      cargoWorkspacePlan.scopes,
      options,
      environment,
      platform === "win32",
      cacheabilityByTask,
    );
    const unrestorableCacheInputs = taskIdsWithUnrestorableCacheInputs(
      graph,
      cargoWorkspacePlan.scopes,
      new Set(
        [...cacheabilityByTask].flatMap(([id, cacheability]) =>
          cacheability.runtimeInputsRestorable ? [] : [id],
        ),
      ),
    );
    const logIdentifiers = taskLogIdentifiers(
      repository,
      graph,
      cargoWorkspacePlan.scopes,
      platform === "win32",
    );
    const orderedNodes = [...graph.nodes.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const globalInputFileHashes =
      orderedNodes[0] === undefined
        ? {}
        : hashes.get(orderedNodes[0].id)!.globalInputFileHashes;
    const isMonorepo = !parsed.singlePackage && repository.packages.length > 0;
    if (parsed.graph !== undefined) {
      const edges = orderedNodes.flatMap((node) =>
        node.dependencies.length === 0
          ? ([[node.id, "___ROOT___"]] as const)
          : node.dependencies.map(
              (dependency) => [node.id, dependency] as const,
            ),
      );
      const requestedPath = parsed.graph;
      const extension = requestedPath.toLowerCase().split(".").pop();
      const dotOutput = `\ndigraph {\n\tcompound = "true"\n\tnewrank = "true"\n\tsubgraph "root" {\n${edges
        .map(
          ([source, target]) =>
            `\t\t${JSON.stringify(`[root] ${source}`)} -> ${JSON.stringify(`[root] ${target}`)}`,
        )
        .join("\n")}\n\t}\n}\n\n`;
      const mermaidIdentifiers = new Map(
        [...new Set(edges.flat())]
          .sort((left, right) => left.localeCompare(right))
          .map((value, index) => [value, `N${index}`]),
      );
      const mermaidOutput = `graph TD\n${edges
        .map(
          ([source, target]) =>
            `\t${mermaidIdentifiers.get(source)}(${JSON.stringify(source)}) --> ${mermaidIdentifiers.get(target)}(${JSON.stringify(target)})`,
        )
        .join("\n")}`;
      if (requestedPath === "") {
        const terminal = yield* TerminalService;
        yield* terminal.writeStdout(dotOutput);
      } else {
        const terminal = yield* TerminalService;
        const graphPath = isAbsolutePath(requestedPath)
          ? requestedPath
          : joinPath(options.root, requestedPath);
        if (extension === "mermaid" || extension === "mmd") {
          yield* fileSystem.writeTextAtomic(graphPath, mermaidOutput);
        } else if (extension === "html") {
          const serializedDot = JSON.stringify(dotOutput).replaceAll(
            ">",
            "\\u003E",
          );
          yield* fileSystem.writeTextAtomic(
            graphPath,
            `\n<!DOCTYPE html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <title>Graph</title>\n</head>\n<body>\n  <script src="https://cdn.jsdelivr.net/npm/viz.js@2.1.2-pre.1/viz.js"></script>\n  <script src="https://cdn.jsdelivr.net/npm/viz.js@2.1.2-pre.1/full.render.js"></script>\n  <script>\nconst s = ${serializedDot}.replace(/\\_\\_\\_ROOT\\_\\_\\_/g, "Root").replace(/\\[root\\]/g, "");new Viz().renderSVGElement(s).then(el => document.body.appendChild(el)).catch(e => console.error(e));\n  </script>\n</body>\n</html>\n`,
          );
        } else if (
          extension !== undefined &&
          ["jpg", "json", "pdf", "png", "svg"].includes(extension)
        ) {
          if (["jpg", "json", "pdf", "png"].includes(extension)) {
            yield* terminal.writeStderr(
              " WARNING  --graph with this output format is deprecated and will be removed in version 3.0. Use `turbo query` for programmatic graph access.\n",
            );
          }
          const processService = yield* ProcessService;
          const rendered = yield* Effect.either(
            Effect.scoped(
              processService.runBytes({
                command: "dot",
                args: [`-T${extension === "jpg" ? "jpeg" : extension}`],
                cwd: options.root,
                stdin: dotOutput,
                inheritEnvironment: true,
              }),
            ),
          );
          if (rendered._tag === "Right" && rendered.right.exitCode === 0) {
            yield* fileSystem.writeBytes(graphPath, rendered.right.stdout);
          } else {
            yield* terminal.writeStderr(
              " WARNING  `turbo-ts` uses Graphviz to generate an image of your graph, but Graphviz isn't installed on this machine.\n\n",
            );
            yield* terminal.writeStdout(dotOutput);
            return 0;
          }
        } else {
          yield* fileSystem.writeTextAtomic(graphPath, dotOutput);
        }
        yield* terminal.writeStdout(
          `\n✓ Generated task graph in ${graphPath}\n`,
        );
      }
      return 0;
    }
    const externalDependencyHashes = new Map(
      parsed.dryRun === "json" ||
        parsed.summarize ||
        parsed.json ||
        parsed.logFile !== undefined
        ? yield* Effect.forEach(
            orderedNodes,
            (node) =>
              taskExternalDependenciesHash(repository, node).pipe(
                Effect.map((hash) => [node.id, hash] as const),
              ),
            { concurrency: 8 },
          )
        : [],
    );
    if (parsed.dryRun !== undefined) {
      const terminal = yield* TerminalService;
      if (parsed.dryRun === "json") {
        yield* terminal.writeStdout(
          `${JSON.stringify(
            {
              id: xxhash64Hex(
                `${options.root}\0${options.tasks.join("\0")}\0${orderedNodes
                  .map((node) => hashes.get(node.id)!.hash)
                  .join("\0")}`,
              ),
              version: "1",
              turboVersion: "2.10.12",
              monorepo: isMonorepo,
              globalCacheInputs: {
                rootKey: "I can’t see ya, but I know you’re here",
                files: globalInputFileHashes,
                hashOfExternalDependencies: emptyExternalDependenciesHash,
                hashOfInternalDependencies: "",
                environmentVariables: {
                  specified: { env: [], passThroughEnv: null },
                  configured: [],
                  inferred: [],
                  passthrough: null,
                },
                engines: null,
              },
              packages: [
                ...new Set(orderedNodes.map((node) => node.package.name)),
              ],
              envMode: options.environmentMode,
              frameworkInference: options.frameworkInference,
              tasks: orderedNodes.map((node) => ({
                taskId: node.id,
                task: node.task,
                package: node.package.name,
                hash: hashes.get(node.id)!.hash,
                inputs: Object.fromEntries(
                  Object.entries(hashes.get(node.id)!.inputFileHashes).filter(
                    ([path]) => !path.startsWith("$TURBO_ROOT$/"),
                  ),
                ),
                hashOfExternalDependencies: externalDependencyHashes.get(
                  node.id,
                )!,
                cache: {
                  local: false,
                  remote: false,
                  status: "MISS",
                  timeSaved: 0,
                },
                command: node.command ?? "",
                cliArguments: parsed.passThroughArguments,
                outputs: (node.definition.outputs ?? []).filter(
                  (output) => !output.startsWith("!"),
                ),
                excludedOutputs: (() => {
                  const outputs =
                    node.definition.outputs?.filter((output) =>
                      output.startsWith("!"),
                    ) ?? [];
                  return outputs.length === 0 ? null : outputs;
                })(),
                logFile: relativePath(
                  repository.root,
                  taskLogPath(
                    node,
                    cargoWorkspacePlan.scopes.get(node.id),
                    logIdentifiers.get(node.id),
                  ),
                ),
                directory:
                  node.package.relativeDirectory === "."
                    ? ""
                    : node.package.relativeDirectory,
                dependencies: node.dependencies,
                dependents: orderedNodes
                  .filter((entry) => entry.dependencies.includes(node.id))
                  .map((entry) => entry.id),
                with: node.with,
                resolvedTaskDefinition: {
                  outputs: node.definition.outputs ?? [],
                  cache: node.definition.cache !== false,
                  dependsOn: node.definition.dependsOn ?? [],
                  inputs: node.definition.inputs ?? [],
                  outputLogs: node.definition.outputLogs ?? "full",
                  persistent: node.definition.persistent ?? false,
                  interruptible: node.definition.interruptible ?? false,
                  env: node.definition.env ?? [],
                  passThroughEnv: node.definition.passThroughEnv ?? null,
                  interactive: node.definition.interactive ?? false,
                },
                expandedOutputs: [],
                framework: "",
                envMode: options.environmentMode,
                environmentVariables: {
                  specified: {
                    env: Object.keys(hashes.get(node.id)!.environment),
                    passThroughEnv: null,
                  },
                  configured: [],
                  inferred: [],
                  passthrough: null,
                },
              })),
              user: "",
              scm: { type: "git", sha: null, branch: null },
            },
            undefined,
            2,
          )}\n\n`,
        );
      } else {
        const packages = [
          ...new Map(
            orderedNodes.map((node) => [node.package.identity, node.package]),
          ).values(),
        ];
        yield* terminal.writeStdout(
          `Packages in Scope\nName Path\n${packages
            .map(
              (packageModel) =>
                `${packageModel.name} ${packageModel.relativeDirectory}`,
            )
            .join("\n")}\n\nTasks to Run\n${orderedNodes
            .map(
              (node) =>
                `${node.id}\n  Task = ${node.task}\n  Package = ${node.package.name}\n  Hash = ${hashes.get(node.id)!.hash}\n  Directory = ${node.package.relativeDirectory}\n  Command = ${node.command ?? ""}\n  Dependencies = ${node.dependencies.join(", ")}\n  Inputs Files Considered = ${hashes.get(node.id)!.inputFiles.length}`,
            )
            .join("\n")}\n`,
        );
      }
      return 0;
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
    const profileService = yield* Effect.serviceOption(RuntimeProfileService);
    const clock = yield* ClockService;
    const runStartedAt = yield* clock.now;
    const structuredLogPath =
      parsed.logFile === undefined
        ? undefined
        : parsed.logFile === ""
          ? joinPath(options.root, ".turbo", "logs", `${runStartedAt}.json`)
          : isAbsolutePath(parsed.logFile)
            ? parsed.logFile
            : joinPath(options.root, parsed.logFile);
    const structuredLogSemaphore = yield* Effect.makeSemaphore(1);
    if (structuredLogPath !== undefined) {
      yield* fileSystem.writeTextAtomic(structuredLogPath, "");
    }
    const writeStructuredRecord: WriteStructuredRecord = (record) =>
      structuredLogPath === undefined
        ? Effect.void
        : structuredLogSemaphore.withPermits(1)(
            fileSystem.appendText(
              structuredLogPath,
              `${JSON.stringify(record)}\n`,
            ),
          );
    if (parsed.heap !== undefined) {
      if (profileService._tag === "None") {
        return yield* Effect.fail(
          new ConfigurationError({
            path: "<arguments>",
            message: "runtime heap profiling is unavailable",
          }),
        );
      }
      yield* profileService.value.heapSnapshot(
        isAbsolutePath(parsed.heap)
          ? parsed.heap
          : joinPath(options.root, parsed.heap),
      );
    }
    const groups = taskGroups(graph);
    const pending = new Map(groups.map((members) => [members[0]!, members]));
    const outcomes = new Map<string, TaskOutcome>();
    const foregroundSemaphore = yield* Effect.makeSemaphore(
      options.concurrency,
    );
    const withCachePublicationPermit = yield* makeCachePublicationPermit;
    const outputSemaphore = yield* Effect.makeSemaphore(1);
    const withOutputPermit: OutputPermit = (output) =>
      options.logOrder === "grouped"
        ? outputSemaphore.withPermits(1)(output)
        : output;
    const tuiStatuses = new Map<string, RunTuiStatus>(
      orderedNodes.map((node) => [node.id, "queued"]),
    );
    const tuiSemaphore = yield* Effect.makeSemaphore(1);
    const updateTuiStatus = (
      id: string,
      status: RunTuiStatus,
    ): Effect.Effect<void> => {
      if (options.ui !== "tui") return Effect.void;
      tuiStatuses.set(id, status);
      return tuiSemaphore
        .withPermits(1)(terminal.writeStdout(renderRunTui(tuiStatuses)))
        .pipe(Effect.ignore);
    };
    if (options.ui === "tui") {
      yield* terminal.writeStdout(`\u001b[?25l${renderRunTui(tuiStatuses)}`);
    }
    const runGroup = ([, members]: readonly [
      string,
      ReadonlyArray<string>,
    ]): Effect.Effect<
      ReadonlyArray<TaskOutcome>,
      CacheRollbackError | RepositoryError,
      RunRequirements
    > => {
      const memberSet = new Set(members);
      const groupOutcomes = new Map<string, TaskOutcome>();
      const taskStartedAt = new Map<string, number>();
      const runNode = (
        id: string,
      ): Effect.Effect<TaskOutcome, CacheRollbackError, RunRequirements> =>
        Effect.gen(function* () {
          const clock = yield* ClockService;
          const startTime = yield* clock.now;
          taskStartedAt.set(id, startTime);
          const node = graph.nodes.get(id)!;
          yield* updateTuiStatus(id, "running");
          const dependencyFailed = node.dependencies.some((dependency) => {
            const outcome =
              groupOutcomes.get(dependency) ?? outcomes.get(dependency);
            return (
              outcome !== undefined &&
              (outcome.exitCode !== 0 || outcome.skipped)
            );
          });
          const result: TaskExecutionResult =
            !options.parallel &&
            dependencyFailed &&
            options.continueMode !== "always"
              ? { id, exitCode: 1, skipped: true }
              : yield* executeTask(
                  repository,
                  node,
                  options,
                  hashes.get(id)!,
                  environment,
                  cargoWorkspacePlan.scopes.get(id),
                  cacheabilityByTask.get(id)!.cacheable &&
                    !unrestorableCacheInputs.has(id),
                  withCachePublicationPermit,
                  logIdentifiers.get(id),
                  withOutputPermit,
                  writeStructuredRecord,
                ).pipe(
                  Effect.catchAll((cause) =>
                    cause instanceof CacheRollbackError
                      ? Effect.fail(cause)
                      : Effect.gen(function* () {
                          const message = `turbo-ts: ${String(cause)}`;
                          const timestamp = yield* clock.now;
                          yield* writeStructuredRecord({
                            type: "task_event",
                            timestamp,
                            source: `${node.package.name}:${node.task}`,
                            level: "stderr",
                            text: message,
                          }).pipe(Effect.ignore);
                          yield* terminal
                            .writeStderr(`${message}\n`)
                            .pipe(Effect.ignore);
                          return {
                            id,
                            exitCode: 1,
                            skipped: false,
                          } satisfies TaskExecutionResult;
                        }),
                  ),
                );
          const endTime = yield* clock.now;
          yield* updateTuiStatus(
            id,
            result.skipped
              ? "skipped"
              : result.exitCode === 0
                ? "succeeded"
                : "failed",
          );
          return { ...result, startTime, endTime };
        });
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
            readonly fiber: Fiber.RuntimeFiber<TaskOutcome, CacheRollbackError>;
          }> = [];
          const startedBackground = new Set<string>();
          const remaining = new Set(foreground);
          const results: Array<TaskOutcome> = [];
          const hasStartedCompanions = (id: string): boolean =>
            graph.nodes
              .get(id)!
              .with.filter((companion) => backgroundSet.has(companion))
              .every((companion) => startedBackground.has(companion));
          const backgroundOutcomes = (): Effect.Effect<
            ReadonlyArray<TaskOutcome>,
            never,
            ClockService
          > =>
            Effect.gen(function* () {
              const endTime = yield* (yield* ClockService).now;
              return backgroundFibers.map(({ id }) => ({
                id,
                exitCode: 0,
                hash: hashes.get(id)!.hash,
                skipped: false,
                startTime: taskStartedAt.get(id) ?? endTime,
                endTime,
              }));
            });
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
              const endTime = yield* (yield* ClockService).now;
              return members.map((id) =>
                id === completion.outcome.id
                  ? completion.outcome
                  : {
                      id,
                      exitCode: 1,
                      skipped: true,
                      startTime: taskStartedAt.get(id) ?? endTime,
                      endTime,
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
              return [...results, ...(yield* backgroundOutcomes())];
            }
          }
          return [...results, ...(yield* backgroundOutcomes())];
        }),
      );
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        const completions = yield* Queue.unbounded<string>();
        const running = new Map<
          string,
          Fiber.RuntimeFiber<
            ReadonlyArray<TaskOutcome>,
            CacheRollbackError | RepositoryError
          >
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
    ).pipe(
      Effect.ensuring(
        options.ui === "tui"
          ? terminal.writeStdout("\u001b[?25h").pipe(Effect.ignore)
          : Effect.void,
      ),
    );
    const runFinishedAt = yield* (yield* ClockService).now;
    const exitCode = [...outcomes.values()].some(
      (outcome) => outcome.exitCode !== 0,
    )
      ? 1
      : 0;
    const successfulTasks = [...outcomes.values()].filter(
      (outcome) => outcome.exitCode === 0 && !outcome.skipped,
    ).length;
    const failedTasks = [...outcomes.values()].filter(
      (outcome) => outcome.exitCode !== 0 && !outcome.skipped,
    ).length;
    const summaryTasks = orderedNodes.map((node) => {
      const taskHash = hashes.get(node.id)!;
      const outcome = outcomes.get(node.id);
      const excludedOutputs =
        node.definition.outputs?.filter((output) => output.startsWith("!")) ??
        [];
      return {
        taskId: node.id,
        task: node.task,
        package: node.package.name,
        hash: taskHash.hash,
        inputs: Object.fromEntries(
          Object.entries(taskHash.inputFileHashes).filter(
            ([path]) => !path.startsWith("$TURBO_ROOT$/"),
          ),
        ),
        hashOfExternalDependencies:
          externalDependencyHashes.get(node.id) ??
          emptyExternalDependenciesHash,
        cache: {
          local: outcome?.cacheSource === "local",
          remote: outcome?.cacheSource === "remote",
          status: outcome?.cacheSource === undefined ? "MISS" : "HIT",
          timeSaved: outcome?.cacheTimeSaved ?? 0,
        },
        command: node.command ?? "",
        cliArguments: parsed.passThroughArguments,
        outputs: (node.definition.outputs ?? []).filter(
          (output) => !output.startsWith("!"),
        ),
        excludedOutputs: excludedOutputs.length === 0 ? null : excludedOutputs,
        logFile: relativePath(
          repository.root,
          taskLogPath(
            node,
            cargoWorkspacePlan.scopes.get(node.id),
            logIdentifiers.get(node.id),
          ),
        ),
        directory:
          node.package.relativeDirectory === "."
            ? ""
            : node.package.relativeDirectory,
        dependencies: node.dependencies,
        dependents: orderedNodes
          .filter((entry) => entry.dependencies.includes(node.id))
          .map((entry) => entry.id),
        with: node.with,
        resolvedTaskDefinition: {
          outputs: node.definition.outputs ?? [],
          cache: node.definition.cache !== false,
          dependsOn: node.definition.dependsOn ?? [],
          inputs: node.definition.inputs ?? [],
          outputLogs: node.definition.outputLogs ?? "full",
          persistent: node.definition.persistent ?? false,
          interruptible: node.definition.interruptible ?? false,
          env: node.definition.env ?? [],
          passThroughEnv: node.definition.passThroughEnv ?? null,
          interactive: node.definition.interactive ?? false,
        },
        expandedOutputs: [],
        framework: "",
        envMode: options.environmentMode,
        environmentVariables: {
          specified: {
            env: Object.keys(taskHash.environment),
            passThroughEnv: null,
          },
          configured: [],
          inferred: [],
          passthrough: null,
        },
        execution: {
          startTime: outcome?.startTime ?? runStartedAt,
          endTime: outcome?.endTime ?? runFinishedAt,
          exitCode: outcome?.exitCode ?? 1,
        },
      };
    });
    const summaryIsEmitted =
      parsed.summarize || parsed.json || parsed.logFile !== undefined;
    const runId = summaryIsEmitted
      ? yield* (yield* RandomnessService).uuidV7
      : "";
    const summary = {
      id: runId,
      version: "1",
      turboVersion: "2.10.12",
      monorepo: isMonorepo,
      globalCacheInputs: {
        rootKey: "I can’t see ya, but I know you’re here",
        files: globalInputFileHashes,
        hashOfExternalDependencies: "459c029558afe716",
        hashOfInternalDependencies: "",
        environmentVariables: {
          specified: { env: [], passThroughEnv: null },
          configured: [],
          inferred: [],
          passthrough: null,
        },
        engines: null,
      },
      execution: {
        command: `turbo-ts run ${options.tasks.join(" ")}`,
        repoPath: "",
        success: successfulTasks,
        failed: failedTasks,
        cached: [...outcomes.values()].filter(
          (outcome) => outcome.cacheSource !== undefined,
        ).length,
        attempted: outcomes.size,
        startTime: runStartedAt,
        endTime: runFinishedAt,
        exitCode,
      },
      packages: [...new Set(orderedNodes.map((node) => node.package.name))],
      envMode: options.environmentMode,
      frameworkInference: options.frameworkInference,
      tasks: summaryTasks,
      user: "",
      scm: { type: "git", sha: null, branch: null },
    };
    if (parsed.summarize) {
      yield* fileSystem.writeTextAtomic(
        joinPath(options.root, ".turbo", "runs", `${runId}.json`),
        `${JSON.stringify(summary, undefined, 2)}\n`,
      );
    }
    const profileEvents = (anonymous: boolean) =>
      orderedNodes.map((node) => {
        const outcome = outcomes.get(node.id);
        const startTime = outcome?.startTime ?? runStartedAt;
        const endTime = outcome?.endTime ?? runFinishedAt;
        return {
          name: anonymous ? node.task : node.id,
          cat: "turbo-ts",
          ph: "X",
          ts: startTime * 1_000,
          dur: Math.max(0, endTime - startTime) * 1_000,
          pid: 1,
          tid: 1,
        };
      });
    const namedProfileEvents = profileEvents(false);
    const anonymousProfileEvents = profileEvents(true);
    for (const [requestedPath, traceEvents] of [
      [parsed.profile, namedProfileEvents],
      [parsed.anonymousProfile, anonymousProfileEvents],
      [parsed.trace, namedProfileEvents],
    ] as const) {
      if (requestedPath === undefined) continue;
      if (profileService._tag === "None") {
        return yield* Effect.fail(
          new ConfigurationError({
            path: "<arguments>",
            message: "runtime trace profiling is unavailable",
          }),
        );
      }
      const resolvedPath =
        requestedPath === ""
          ? joinPath(options.root, `profile.${runStartedAt}`)
          : isAbsolutePath(requestedPath)
            ? requestedPath
            : joinPath(options.root, requestedPath);
      yield* profileService.value.writeTrace(resolvedPath, traceEvents);
    }
    const summaryRecord = { type: "run_summary", ...summary } as const;
    yield* writeStructuredRecord(summaryRecord);
    if (parsed.json) {
      yield* terminal.writeStdout(`${JSON.stringify(summaryRecord)}\n`);
    }
    return exitCode;
  });
