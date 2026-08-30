import { Effect } from "effect";
import {
  type CacheWriteEntry,
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
import { matchesGlob } from "../core/glob.js";
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
  hashTask,
  type TaskHashResult,
  taskEnvironment,
} from "../hash/task-hash.js";
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
  return Math.floor(Number(match[1]) * multiplier);
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
    policy = {
      localRead: false,
      localWrite: false,
      remoteRead: false,
      remoteWrite: false,
    };
    for (const part of specification.split(";")) {
      const [source, operations = ""] = part.split(":");
      const read = operations.split(",").includes("r");
      const write = operations.split(",").includes("w");
      if (source === "local") {
        policy = { ...policy, localRead: read, localWrite: write };
      } else if (source === "remote") {
        policy = { ...policy, remoteRead: read, remoteWrite: write };
      }
    }
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
      environment.TURBO_REMOTE_CACHE_TIMEOUT ??
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
          teamId: remoteConfiguration?.teamId ?? environment.TURBO_TEAMID,
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
      { "": 1, ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 },
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
  return { base, head };
};

const findAffectedPackages = (
  repository: RepositoryModel,
  environment: Readonly<Record<string, string | undefined>>,
  range?: GitRange,
): Effect.Effect<AffectedPackages, never, ProcessService> =>
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
            args: ["diff", "--name-only", `${baseReference}...${head}`],
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
      return {
        packages: new Set(
          repository.packages.map((packageModel) => packageModel.name),
        ),
        changedFiles: [],
        rootChanged: true,
      };
    }
    const changedFiles = result.right.stdout.split(/\r?\n/).filter(Boolean);
    const rootChanged = changedFiles.some(
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
    readonly changedFiles: ReadonlyArray<string>;
    readonly rootChanged: boolean;
  },
  never,
  ProcessService
> =>
  Effect.gen(function* () {
    const ranges = new Map<string, ReadonlySet<string>>();
    const results: Array<AffectedPackages> = [];
    const selectors = [
      ...new Set(
        options.filters.flatMap((filter) => {
          const match = /\[([^\]]+)\]/.exec(filter);
          return match?.[1] === undefined ? [] : [match[1]];
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
      results.push(affected);
    }
    if (options.affected) {
      const affected = yield* findAffectedPackages(repository, environment);
      ranges.set(defaultAffectedSelector, affected.packages);
      results.push(affected);
    }
    return {
      filters: options.affected
        ? [...options.filters, `...[${defaultAffectedSelector}]`]
        : options.filters,
      ranges,
      changedFiles: [
        ...new Set(results.flatMap((result) => result.changedFiles)),
      ].sort(),
      rootChanged: results.some((result) => result.rootChanged),
    };
  });

const taskMatchesChangedFiles = (
  node: TaskNode,
  changedFiles: ReadonlyArray<string>,
): boolean => {
  const packagePrefix = `${node.package.relativeDirectory}/`;
  const relativeFiles = changedFiles
    .filter((path) => path.startsWith(packagePrefix))
    .map((path) => path.slice(packagePrefix.length));
  const inputs = node.definition.inputs;
  if (inputs === undefined || inputs === null || inputs.length === 0) {
    return relativeFiles.length > 0;
  }
  return relativeFiles.some((file) => {
    let selected = false;
    for (const input of inputs) {
      if (typeof input !== "string") {
        if (input.withDefaults !== false) selected = true;
        if ((input.globs ?? []).some((glob) => matchesGlob(file, glob))) {
          selected = true;
        }
      } else if (input === "$TURBO_DEFAULT$") {
        selected = true;
      } else if (input.startsWith("!")) {
        if (matchesGlob(file, input.slice(1))) selected = false;
      } else if (matchesGlob(file, input)) {
        selected = true;
      }
    }
    return selected;
  });
};

const selectAffectedTasks = (
  graph: TaskGraph,
  changedFiles: ReadonlyArray<string>,
  rootChanged: boolean,
): TaskGraph => {
  if (rootChanged) return graph;
  const retained = new Set(
    graph.entrypoints.filter((id) => {
      const node = graph.nodes.get(id);
      return node !== undefined && taskMatchesChangedFiles(node, changedFiles);
    }),
  );
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
    entrypoints: graph.entrypoints.filter((id) => retained.has(id)),
    nodes: new Map([...graph.nodes].filter(([id]) => retained.has(id))),
  };
};

export const packageManagerCommand = (
  node: TaskNode,
  passThroughArguments: ReadonlyArray<string>,
): { readonly command: string; readonly arguments: ReadonlyArray<string> } => {
  switch (node.package.manager) {
    case "yarn":
    case "bun":
    case "aube":
    case "nub":
      return {
        command: node.package.manager,
        arguments: ["run", node.task, ...passThroughArguments],
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
      const target = [`--package=${node.package.name}`];
      const passThrough =
        passThroughArguments.length === 0
          ? []
          : cargoTask === "build" || cargoTask === "check"
            ? passThroughArguments
            : ["--", ...passThroughArguments];
      return {
        command: "cargo",
        arguments: [cargoTask, ...target, ...locked, ...passThrough],
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
        };
      }
      if (node.task === "format") {
        return {
          command: "uv",
          arguments: [
            "format",
            ...passThroughArguments,
            "--",
            node.package.relativeDirectory,
          ],
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
          node.package.relativeDirectory,
        ],
      };
    case "npm":
    case "pnpm":
      return {
        command: node.package.manager,
        arguments:
          passThroughArguments.length === 0
            ? ["run", node.task]
            : ["run", node.task, "--", ...passThroughArguments],
      };
  }
};

const collectCacheEntries = (
  repository: RepositoryModel,
  node: TaskNode,
  logPath: string,
): Effect.Effect<
  ReadonlyArray<CacheWriteEntry>,
  RepositoryError,
  FileSystemService
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const files = [
      ...(yield* listRepositoryFiles(node.package.directory, {
        ignoredDirectories: new Set([".git", ".turbo", "node_modules"]),
      })),
      logPath,
    ];
    const outputPatterns = node.definition.outputs ?? [];
    const selected = files.filter((path) => {
      if (path === logPath) {
        return true;
      }
      const relative = relativePath(node.package.directory, path);
      return (
        outputPatterns.some(
          (pattern) =>
            !pattern.startsWith("!") && matchesGlob(relative, pattern),
        ) &&
        !outputPatterns.some(
          (pattern) =>
            pattern.startsWith("!") && matchesGlob(relative, pattern.slice(1)),
        )
      );
    });
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

const executeTask = (
  repository: RepositoryModel,
  node: TaskNode,
  options: ResolvedRunOptions,
  hash: TaskHashResult,
  sourceEnvironment: Readonly<Record<string, string | undefined>>,
): Effect.Effect<TaskOutcome, unknown, RunRequirements> =>
  Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const fileSystem = yield* FileSystemService;
    const clock = yield* ClockService;
    const color =
      options.outputLogs === "none" || !options.colorEnabled
        ? false
        : yield* terminal.stdoutColorEnabled;
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
    const cacheable = node.definition.cache !== false;
    const localOptions = {
      directory: options.cacheDirectory,
      maxAgeMilliseconds: options.cacheMaxAgeMilliseconds,
      maxSizeBytes: options.cacheMaxSizeBytes,
    };
    let cacheHit = false;
    if (cacheable && !options.force && options.cachePolicy.localRead) {
      cacheHit = yield* restoreLocalCache(
        repository.root,
        localOptions,
        hash.hash,
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
      );
    }
    const logPath = joinPath(
      node.package.directory,
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
    );
    const processService = yield* ProcessService;
    const result = yield* Effect.scoped(
      processService.run({
        command: invocation.command,
        args: invocation.arguments,
        cwd:
          node.package.manager === "cargo" || node.package.manager === "uv"
            ? repository.root
            : node.package.directory,
        inheritEnvironment: false,
        stdio: node.definition.interactive === true ? "inherit" : "capture",
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
      }),
    );
    const output = `${result.stdout}${result.stderr}`;
    yield* fileSystem.makeDirectory(joinPath(node.package.directory, ".turbo"));
    yield* fileSystem.writeText(logPath, output);
    if (
      shouldReplayOutput(outputMode, false) ||
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
      const entries = yield* collectCacheEntries(repository, node, logPath);
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
    for (const id of topologicalOrder(graph)) {
      const node = graph.nodes.get(id)!;
      const result = yield* hashTask(
        repository,
        node,
        node.dependencies.map((dependency) => hashes.get(dependency)!.hash),
        options.frameworkInference,
        options.passThroughArguments,
      );
      hashes.set(id, result);
    }
    return hashes;
  });

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
    const preliminaryRoot =
      requestedRoot === undefined
        ? yield* discoverRepositoryRoot(processCwd)
        : normalizePath(requestedRoot);
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
    const packages = selectPackages(
      repository,
      affected.filters,
      affected.ranges,
    );
    const flags = repository.rootConfiguration.value.futureFlags;
    const unfilteredGraph = buildTaskGraph(
      repository,
      packages,
      options.tasks,
      options.only,
      flags?.strictTaskEntrypointSelection === true,
    );
    if (unfilteredGraph.entrypoints.length === 0) {
      return yield* Effect.fail(
        new RepositoryError({
          path: options.root,
          message: `task not found: ${options.tasks.join(", ")}`,
        }),
      );
    }
    const useTaskInputs =
      (options.affected && flags?.affectedUsingTaskInputs === true) ||
      (options.filters.some((filter) => filter.includes("[")) &&
        flags?.filterUsingTasks === true);
    const graph = useTaskInputs
      ? selectAffectedTasks(
          unfilteredGraph,
          affected.changedFiles,
          affected.rootChanged,
        )
      : unfilteredGraph;
    const hashes = yield* computeTaskHashes(repository, graph, options);
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
          const runNode = (
            id: string,
          ): Effect.Effect<TaskOutcome, never, RunRequirements> => {
            const node = graph.nodes.get(id)!;
            const dependencyOutcomes = options.parallel
              ? []
              : node.dependencies.flatMap((dependency) => {
                  const outcome = outcomes.get(dependency);
                  return outcome === undefined ? [] : [outcome];
                });
            const externalDependencyFailed = node.dependencies
              .filter((dependency) => !memberSet.has(dependency))
              .some((dependency) => {
                const outcome = outcomes.get(dependency);
                return (
                  outcome !== undefined &&
                  (outcome.exitCode !== 0 || outcome.skipped)
                );
              });
            if (
              !options.parallel &&
              externalDependencyFailed &&
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
          const owners = new Set(
            members.filter((id) => graph.nodes.get(id)!.with.length > 0),
          );
          const targets = new Set(
            members.flatMap((id) => graph.nodes.get(id)!.with),
          );
          const background = members.filter(
            (id) =>
              targets.has(id) &&
              !owners.has(id) &&
              graph.nodes.get(id)!.definition.persistent === true,
          );
          const foreground = members.filter((id) => !background.includes(id));
          return Effect.scoped(
            Effect.gen(function* () {
              for (const id of background) {
                yield* Effect.forkScoped(runNode(id));
              }
              if (background.length > 0) yield* Effect.yieldNow();
              const results = yield* Effect.forEach(foreground, runNode, {
                concurrency: "unbounded",
              });
              return [
                ...results,
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
