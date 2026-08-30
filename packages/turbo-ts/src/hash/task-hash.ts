import { Effect } from "effect";
import { matchesGlob, selectByGlobs } from "../core/glob.js";
import {
  isPathContained,
  joinPath,
  parentPath,
  relativePath,
} from "../core/path.js";
import { RepositoryError } from "../effect/errors.js";
import {
  DigestService,
  EnvironmentService,
  FileSystemService,
  ProcessService,
} from "../effect/services.js";
import type { TaskNode } from "../graph/task-graph.js";
import type { RepositoryModel } from "../repository/model.js";
import { listRepositoryFiles } from "../repository/model.js";
import { xxhash64Hex } from "./xxhash64.js";

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
};

export const canonicalStringify = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

const frameworkEnvironmentPatterns: ReadonlyArray<{
  readonly dependencies: ReadonlyArray<string>;
  readonly patterns: ReadonlyArray<string>;
}> = [
  { dependencies: ["next"], patterns: ["NEXT_PUBLIC_*"] },
  { dependencies: ["gatsby"], patterns: ["GATSBY_*"] },
  { dependencies: ["react-scripts"], patterns: ["REACT_APP_*"] },
  { dependencies: ["vite"], patterns: ["VITE_*"] },
  { dependencies: ["@sveltejs/kit"], patterns: ["PUBLIC_*"] },
  { dependencies: ["astro"], patterns: ["PUBLIC_*"] },
  { dependencies: ["nuxt"], patterns: ["NUXT_*"] },
  { dependencies: ["@redwoodjs/core"], patterns: ["REDWOOD_ENV_*"] },
  { dependencies: ["sanity"], patterns: ["SANITY_STUDIO_*"] },
];

const matchesEnvironmentPattern = (name: string, pattern: string): boolean =>
  matchesGlob(name, pattern);

export const selectEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  patterns: ReadonlyArray<string>,
): Readonly<Record<string, string>> => {
  const selected = new Map<string, string>();
  for (const pattern of patterns) {
    const negative = pattern.startsWith("!");
    const matcher = negative ? pattern.slice(1) : pattern;
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined || !matchesEnvironmentPattern(name, matcher)) {
        continue;
      }
      if (negative) {
        selected.delete(name);
      } else {
        selected.set(name, value);
      }
    }
  }
  return Object.fromEntries(
    [...selected].sort(([left], [right]) => left.localeCompare(right)),
  );
};

export const inferredEnvironmentPatterns = (
  node: TaskNode,
): ReadonlyArray<string> =>
  frameworkEnvironmentPatterns
    .filter((framework) =>
      framework.dependencies.some((dependency) =>
        node.package.dependencyNames.includes(dependency),
      ),
    )
    .flatMap((framework) => framework.patterns);

interface TaskInputFile {
  readonly absolutePath: string;
  readonly hashPath: string;
  readonly matchPath: string;
}

const turboRootInputPrefix = "$TURBO_ROOT$/";

const isIgnoredInputPath = (path: string, cacheDirectory: string): boolean =>
  path.includes("/.turbo/") ||
  path.includes("/node_modules/") ||
  isPathContained(cacheDirectory, path);

type TaskInput = NonNullable<TaskNode["definition"]["inputs"]>[number];

const rootInputPattern = (pattern: string): string => {
  const negative = pattern.startsWith("!");
  const value = negative ? pattern.slice(1) : pattern;
  const rooted = value.startsWith(turboRootInputPrefix)
    ? value
    : `${turboRootInputPrefix}${value.replace(/^\.\//, "")}`;
  return negative ? `!${rooted}` : rooted;
};

const effectiveTaskInputs = (
  repository: RepositoryModel,
  node: TaskNode,
): ReadonlyArray<TaskInput> => {
  const configured = node.definition.inputs;
  const taskInputs =
    configured === undefined || configured === null || configured.length === 0
      ? ["$TURBO_DEFAULT$"]
      : configured;
  return repository.rootConfiguration.value.futureFlags?.globalConfiguration ===
    true
    ? [
        ...(repository.rootConfiguration.value.global?.inputs ?? []).map(
          rootInputPattern,
        ),
        ...taskInputs,
      ]
    : taskInputs;
};

const usesTurboRootInput = (inputs: ReadonlyArray<TaskInput>): boolean =>
  inputs.some((input) =>
    typeof input === "string"
      ? input.replace(/^!/, "").startsWith(turboRootInputPrefix)
      : (input.globs ?? []).some((glob) =>
          glob.replace(/^!/, "").startsWith(turboRootInputPrefix),
        ),
  );

const taskInputFiles = (
  repository: RepositoryModel,
  node: TaskNode,
  packageFiles: ReadonlyArray<string>,
  repositoryFiles: ReadonlyArray<string>,
  inputs: ReadonlyArray<TaskInput>,
  cacheDirectory: string,
): ReadonlyArray<TaskInputFile> => {
  const defaults = packageFiles
    .filter((path) => !isIgnoredInputPath(path, cacheDirectory))
    .map((absolutePath) => {
      const relative = relativePath(node.package.directory, absolutePath);
      return { absolutePath, hashPath: relative, matchPath: relative };
    });
  const rootFiles = repositoryFiles
    .filter((path) => !isIgnoredInputPath(path, cacheDirectory))
    .map((absolutePath) => {
      const relative = relativePath(repository.root, absolutePath);
      return {
        absolutePath,
        hashPath: `${turboRootInputPrefix}${relative}`,
        matchPath: relative,
      };
    });
  const selected = new Map<string, TaskInputFile>();
  const matchingFiles = (pattern: string): ReadonlyArray<TaskInputFile> => {
    const rootRelative = pattern.startsWith(turboRootInputPrefix);
    const matcher = rootRelative
      ? pattern.slice(turboRootInputPrefix.length)
      : pattern;
    return (rootRelative ? rootFiles : defaults).filter((file) =>
      matchesGlob(file.matchPath, matcher),
    );
  };
  const include = (files: ReadonlyArray<TaskInputFile>): void => {
    for (const file of files) selected.set(file.absolutePath, file);
  };
  for (const input of inputs) {
    if (typeof input !== "string") {
      for (const glob of input.globs ?? []) {
        include(matchingFiles(glob));
      }
      if (input.withDefaults !== false) {
        include(defaults);
      }
      continue;
    }
    if (input === "$TURBO_DEFAULT$") {
      include(defaults);
    } else if (input.startsWith("!")) {
      for (const file of matchingFiles(input.slice(1)))
        selected.delete(file.absolutePath);
    } else {
      include(matchingFiles(input));
    }
  }
  return [...selected.values()].sort((left, right) =>
    left.hashPath.localeCompare(right.hashPath),
  );
};

export interface TaskHashResult {
  readonly hash: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly inputFiles: ReadonlyArray<string>;
}

const discoverFiles = (
  repository: RepositoryModel,
  directory: string,
  cacheDirectory: string,
): Effect.Effect<
  ReadonlyArray<string>,
  RepositoryError,
  FileSystemService | ProcessService
> =>
  Effect.gen(function* () {
    const processService = yield* ProcessService;
    const fileSystem = yield* FileSystemService;
    const relativeDirectory = relativePath(repository.root, directory);
    const git = yield* Effect.either(
      Effect.scoped(
        processService.run({
          command: "git",
          args: [
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
            relativeDirectory,
          ],
          cwd: repository.root,
        }),
      ),
    );
    if (git._tag === "Right" && git.right.exitCode === 0) {
      const discovered = git.right.stdout
        .split("\0")
        .filter(Boolean)
        .map((path) => joinPath(repository.root, path))
        .sort();
      const existing = yield* Effect.forEach(
        discovered,
        (path) =>
          fileSystem.exists(path).pipe(
            Effect.map((exists) => (exists ? path : undefined)),
            Effect.mapError(
              (error) => new RepositoryError({ path, message: error.message }),
            ),
          ),
        { concurrency: 8 },
      );
      return existing.filter(
        (path): path is string =>
          path !== undefined && !isIgnoredInputPath(path, cacheDirectory),
      );
    }
    return (yield* listRepositoryFiles(directory)).filter(
      (path) => !isIgnoredInputPath(path, cacheDirectory),
    );
  });

const owningLockfile = (
  repository: RepositoryModel,
  node: TaskNode,
): Effect.Effect<string | undefined, RepositoryError, FileSystemService> =>
  Effect.gen(function* () {
    if (node.package.manager !== "cargo" && node.package.manager !== "uv") {
      return repository.lockfile;
    }
    const fileSystem = yield* FileSystemService;
    const exists = (path: string) =>
      fileSystem
        .exists(path)
        .pipe(
          Effect.mapError(
            (error) => new RepositoryError({ path, message: error.message }),
          ),
        );
    if (node.package.manager === "cargo") {
      const directory =
        node.package.workspaceDirectory ?? node.package.directory;
      if (!isPathContained(repository.root, directory)) return undefined;
      const path = joinPath(directory, "Cargo.lock");
      return (yield* exists(path)) ? path : undefined;
    }
    let directory = node.package.directory;
    while (isPathContained(repository.root, directory)) {
      const path = joinPath(directory, "uv.lock");
      if (yield* exists(path)) return path;
      if (directory === repository.root) break;
      const parent = parentPath(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return undefined;
  });

const activeGlobalSettings = (repository: RepositoryModel) => {
  const root = repository.rootConfiguration.value;
  if (root.futureFlags?.globalConfiguration === true) {
    return {
      inputs: root.global?.inputs,
      env: root.global?.env,
      passThroughEnv: root.global?.passThroughEnv,
    };
  }
  return {
    inputs: root.globalDependencies,
    env: root.globalEnv,
    passThroughEnv: root.globalPassThroughEnv,
  };
};

export const hashTask = (
  repository: RepositoryModel,
  node: TaskNode,
  dependencyHashes: ReadonlyArray<string>,
  frameworkInference: boolean,
  passThroughArguments: ReadonlyArray<string>,
  cacheDirectory: string,
): Effect.Effect<
  TaskHashResult,
  RepositoryError,
  FileSystemService | EnvironmentService | DigestService | ProcessService
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const digest = yield* DigestService;
    const environmentService = yield* EnvironmentService;
    const environment = yield* environmentService.entries;
    const inputs = effectiveTaskInputs(repository, node);
    const packageFiles = yield* discoverFiles(
      repository,
      node.package.directory,
      cacheDirectory,
    );
    const repositoryFiles = usesTurboRootInput(inputs)
      ? yield* discoverFiles(repository, repository.root, cacheDirectory)
      : [];
    const inputFiles = taskInputFiles(
      repository,
      node,
      packageFiles,
      repositoryFiles,
      inputs,
      cacheDirectory,
    );
    const hashFile = (path: string, relative: string) =>
      fileSystem.metadata(path).pipe(
        Effect.flatMap((metadata) =>
          (metadata.kind === "symlink"
            ? fileSystem
                .readLink(path)
                .pipe(Effect.map((target) => new TextEncoder().encode(target)))
            : fileSystem.readBytes(path)
          ).pipe(
            Effect.map((bytes) => ({
              bytes,
              mode:
                metadata.kind === "symlink"
                  ? ("120000" as const)
                  : (metadata.mode & 0o111) !== 0
                    ? ("100755" as const)
                    : ("100644" as const),
            })),
          ),
        ),
        Effect.flatMap(({ bytes, mode }) =>
          digest
            .gitBlobSha1(bytes)
            .pipe(Effect.map((hash) => [relative, mode, hash] as const)),
        ),
        Effect.mapError(
          (error) => new RepositoryError({ path, message: error.message }),
        ),
      );
    const fileHashes = yield* Effect.forEach(
      inputFiles,
      (input) => hashFile(input.absolutePath, input.hashPath),
      { concurrency: 8 },
    );
    const globalSettings = activeGlobalSettings(repository);
    const hashedEnvironment = selectEnvironment(environment, [
      ...(globalSettings.env ?? []),
      ...(node.definition.env ?? []),
      ...(frameworkInference ? inferredEnvironmentPatterns(node) : []),
    ]);
    const lockfilePath = yield* owningLockfile(repository, node);
    const lockfileHash =
      lockfilePath === undefined
        ? null
        : yield* fileSystem.readBytes(lockfilePath).pipe(
            Effect.map(xxhash64Hex),
            Effect.mapError(
              (error) =>
                new RepositoryError({
                  path: lockfilePath,
                  message: error.message,
                }),
            ),
          );
    const globalDependencyPatterns =
      repository.rootConfiguration.value.futureFlags?.globalConfiguration ===
      true
        ? []
        : (globalSettings.inputs ?? []);
    const globalInputFiles =
      globalDependencyPatterns.length === 0
        ? []
        : selectByGlobs(
            (yield* discoverFiles(
              repository,
              repository.root,
              cacheDirectory,
            )).map((path) => relativePath(repository.root, path)),
            globalDependencyPatterns,
          );
    const globalFileHashes = yield* Effect.forEach(
      globalInputFiles,
      (relative) => {
        const path = joinPath(repository.root, relative);
        return hashFile(path, relative);
      },
      { concurrency: 8 },
    );
    const hash = xxhash64Hex(
      canonicalStringify({
        packageManager: `${repository.manager}@${repository.managerVersion ?? ""}`,
        lockfilePath:
          lockfilePath === undefined
            ? null
            : relativePath(repository.root, lockfilePath),
        lockfileHash,
        package: node.package.relativeDirectory,
        task: node.task,
        command: node.command,
        passThroughArguments,
        definition: node.definition,
        effectiveInputs: inputs,
        files: fileHashes,
        environment: hashedEnvironment,
        dependencies: [...dependencyHashes].sort(),
        globalDependencies: globalDependencyPatterns,
        globalFiles: globalFileHashes,
      }),
    );
    return {
      hash,
      environment: hashedEnvironment,
      inputFiles: inputFiles.map((input) => input.hashPath),
    };
  });

const strictBaselineEnvironment = [
  "CI",
  "COLORTERM",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "SYSTEMROOT",
  "TERM",
  "TMP",
  "TEMP",
  "TMPDIR",
  "USER",
  "USERNAME",
] as const;

export const taskEnvironment = (
  repository: RepositoryModel,
  node: TaskNode,
  source: Readonly<Record<string, string | undefined>>,
  mode: "loose" | "strict",
  frameworkInference: boolean,
): Readonly<Record<string, string | undefined>> => {
  if (mode === "loose") {
    return source;
  }
  const globalSettings = activeGlobalSettings(repository);
  return selectEnvironment(source, [
    ...strictBaselineEnvironment,
    ...(globalSettings.env ?? []),
    ...(globalSettings.passThroughEnv ?? []),
    ...(node.definition.env ?? []),
    ...(node.definition.passThroughEnv ?? []),
    ...(frameworkInference ? inferredEnvironmentPatterns(node) : []),
  ]);
};
