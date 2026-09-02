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
import type {
  PackageManagerName,
  RepositoryModel,
} from "../repository/model.js";
import {
  listRepositoryFiles,
  lockfileNamesByManager,
} from "../repository/model.js";
import { xxhash64Hex } from "./xxhash64.js";

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareCodeUnits(left, right))
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

const matchesEnvironmentPattern = (
  name: string,
  pattern: string,
  caseInsensitiveNames: boolean,
): boolean =>
  matchesGlob(
    caseInsensitiveNames ? name.toLowerCase() : name,
    caseInsensitiveNames ? pattern.toLowerCase() : pattern,
  );

export const selectEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  patterns: ReadonlyArray<string>,
  caseInsensitiveNames = false,
): Readonly<Record<string, string>> => {
  const selected = new Map<string, string>();
  for (const pattern of patterns) {
    const negative = pattern.startsWith("!");
    const matcher = negative ? pattern.slice(1) : pattern;
    for (const [name, value] of Object.entries(environment)) {
      if (
        value === undefined ||
        !matchesEnvironmentPattern(name, matcher, caseInsensitiveNames)
      ) {
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
    [...selected].sort(([left], [right]) => compareCodeUnits(left, right)),
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
  readonly gitMode?: GitTrackedMode;
  readonly hashResolvedSymlinkContents?: boolean;
}

type GitTrackedMode = "100644" | "100755" | "120000" | "160000";

interface DiscoveredFile {
  readonly absolutePath: string;
  readonly repositoryRelativePath: string;
  readonly gitMode: GitTrackedMode | undefined;
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

export const effectiveTaskInputs = (
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
  packageFiles: ReadonlyArray<DiscoveredFile>,
  repositoryFiles: ReadonlyArray<DiscoveredFile>,
  inputs: ReadonlyArray<TaskInput>,
  cacheDirectory: string,
  windowsPathSeparators: boolean,
): ReadonlyArray<TaskInputFile> => {
  const defaults = packageFiles
    .filter((file) => !isIgnoredInputPath(file.absolutePath, cacheDirectory))
    .map((file) => {
      const packagePrefix =
        node.package.relativeDirectory === "."
          ? ""
          : `${node.package.relativeDirectory}/`;
      const relative = file.repositoryRelativePath.slice(packagePrefix.length);
      return {
        ...file,
        hashPath: relative,
        matchPath: relative,
      };
    });
  const rootFiles = repositoryFiles
    .filter((file) => !isIgnoredInputPath(file.absolutePath, cacheDirectory))
    .map((file) => {
      const relative = file.repositoryRelativePath;
      return {
        ...file,
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
      matchesGlob(file.matchPath, matcher, windowsPathSeparators),
    );
  };
  const include = (files: ReadonlyArray<TaskInputFile>): void => {
    for (const file of files) selected.set(file.absolutePath, file);
  };
  for (const input of inputs) {
    if (typeof input !== "string") {
      if (input.withDefaults !== false) {
        include(defaults);
      }
      for (const glob of input.globs ?? []) {
        if (glob.startsWith("!")) {
          for (const file of matchingFiles(glob.slice(1))) {
            selected.delete(file.absolutePath);
          }
        } else {
          include(matchingFiles(glob));
        }
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

const ancestorDirectories = (
  repository: RepositoryModel,
  directory: string,
): ReadonlyArray<string> => {
  const directories: Array<string> = [];
  let current = directory;
  while (isPathContained(repository.root, current)) {
    directories.push(current);
    if (current === repository.root) break;
    const parent = parentPath(current);
    if (parent === current) break;
    current = parent;
  }
  return directories;
};

type JavaScriptPackageManagerName = Exclude<PackageManagerName, "cargo" | "uv">;

const repositoryControlNamesByJavaScriptManager = {
  npm: [],
  pnpm: ["pnpm-workspace.yaml", ".pnpmfile.cjs"],
  yarn: [".yarnrc", ".yarnrc.yml"],
  bun: ["bunfig.toml"],
  aube: ["aube-workspace.yaml", ".config/aube/config.toml"],
  nub: ["nub.jsonc"],
} as const satisfies Readonly<
  Record<JavaScriptPackageManagerName, ReadonlyArray<string>>
>;

const repositoryPackageManagerControlInputCandidates = (
  repository: RepositoryModel,
  node: TaskNode,
): ReadonlyArray<string> => {
  if (node.package.manager === "cargo" || node.package.manager === "uv") {
    return [];
  }
  const manager = repository.manager;
  if (manager === "cargo" || manager === "uv") return [];
  return [
    "package.json",
    ".npmrc",
    ...repositoryControlNamesByJavaScriptManager[manager],
  ].map((name) => joinPath(repository.root, name));
};

const cargoControlInputCandidates = (
  repository: RepositoryModel,
  node: TaskNode,
): ReadonlyArray<string> =>
  node.package.manager !== "cargo"
    ? []
    : [
        ...new Set(
          ancestorDirectories(repository, node.package.directory).flatMap(
            (directory) => [
              joinPath(directory, "Cargo.toml"),
              joinPath(directory, ".cargo/config"),
              joinPath(directory, ".cargo/config.toml"),
              joinPath(directory, "rust-toolchain"),
              joinPath(directory, "rust-toolchain.toml"),
            ],
          ),
        ),
      ];

const owningLockfileCandidates = (
  repository: RepositoryModel,
  node: TaskNode,
): ReadonlyArray<string> => {
  if (node.package.manager === "cargo") {
    const directory = node.package.workspaceDirectory ?? node.package.directory;
    return isPathContained(repository.root, directory)
      ? [joinPath(directory, "Cargo.lock")]
      : [];
  }
  if (node.package.manager === "uv") {
    return ancestorDirectories(repository, node.package.directory).map(
      (directory) => joinPath(directory, "uv.lock"),
    );
  }
  return lockfileNamesByManager[repository.manager].map((name) =>
    joinPath(repository.root, name),
  );
};

const gitLiteralPathspecEnvironment = {
  GIT_LITERAL_PATHSPECS: "1",
} as const;

export const decodeNullDelimitedGitOutput = (
  output: Uint8Array,
  path: string,
): ReadonlyArray<string> => {
  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(output)
      .split("\0")
      .filter(Boolean);
  } catch (cause) {
    throw new RepositoryError({
      path,
      message: `Git returned a path that is not valid UTF-8: ${String(cause)}`,
    });
  }
};

const decodeNullDelimitedGitOutputEffect = (
  output: Uint8Array,
  path: string,
): Effect.Effect<ReadonlyArray<string>, RepositoryError> =>
  Effect.try({
    try: () => decodeNullDelimitedGitOutput(output, path),
    catch: (cause) =>
      cause instanceof RepositoryError
        ? cause
        : new RepositoryError({ path, message: String(cause) }),
  });

const trackedGitModes = (
  repository: RepositoryModel,
  relativePaths: ReadonlyArray<string>,
): Effect.Effect<
  ReadonlyMap<string, GitTrackedMode>,
  RepositoryError,
  ProcessService
> =>
  Effect.gen(function* () {
    const modes = new Map<string, GitTrackedMode>();
    if (relativePaths.length === 0) return modes;
    const processService = yield* ProcessService;
    const result = yield* Effect.either(
      Effect.scoped(
        processService.runBytes({
          command: "git",
          args: [
            "ls-files",
            "--stage",
            "-z",
            "--cached",
            "--",
            ...new Set(relativePaths),
          ],
          cwd: repository.root,
          env: gitLiteralPathspecEnvironment,
        }),
      ),
    );
    if (result._tag === "Left" || result.right.exitCode !== 0) return modes;
    for (const entry of yield* decodeNullDelimitedGitOutputEffect(
      result.right.stdout,
      repository.root,
    )) {
      const match =
        /^(100644|100755|120000|160000) [0-9a-fA-F]+ 0\t([\s\S]+)$/.exec(entry);
      if (match?.[1] === undefined || match[2] === undefined) continue;
      modes.set(
        joinPath(repository.root, match[2]),
        match[1] as GitTrackedMode,
      );
    }
    return modes;
  });

export const implicitTaskInputCandidates = (
  repository: RepositoryModel,
  node: TaskNode,
): ReadonlyArray<string> => [
  ...new Set([
    joinPath(
      node.package.directory,
      node.package.manager === "cargo"
        ? "Cargo.toml"
        : node.package.manager === "uv"
          ? "pyproject.toml"
          : "package.json",
    ),
    ...(node.package.relativeDirectory === "."
      ? [repository.rootConfiguration.path]
      : [
          joinPath(node.package.directory, "turbo.json"),
          joinPath(node.package.directory, "turbo.jsonc"),
        ]),
    ...owningLockfileCandidates(repository, node),
    ...cargoControlInputCandidates(repository, node),
    ...repositoryPackageManagerControlInputCandidates(repository, node),
  ]),
];

const alwaysHashedControlInputCandidates = (
  repository: RepositoryModel,
  node: TaskNode,
): ReadonlyArray<string> =>
  node.package.manager === "cargo"
    ? cargoControlInputCandidates(repository, node)
    : node.package.manager === "uv"
      ? [joinPath(node.package.directory, "pyproject.toml")]
      : [
          joinPath(node.package.directory, "package.json"),
          ...repositoryPackageManagerControlInputCandidates(repository, node),
        ];

const alwaysHashedControlInputFiles = (
  repository: RepositoryModel,
  node: TaskNode,
  cacheDirectory: string,
  useTrackedGitModes: boolean,
): Effect.Effect<
  ReadonlyArray<TaskInputFile>,
  RepositoryError,
  FileSystemService | ProcessService
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const candidates = alwaysHashedControlInputCandidates(
      repository,
      node,
    ).filter((path) => !isIgnoredInputPath(path, cacheDirectory));
    const existing = yield* Effect.forEach(
      candidates,
      (path) =>
        fileSystem.exists(path).pipe(
          Effect.map((exists) => (exists ? path : undefined)),
          Effect.mapError(
            (error) => new RepositoryError({ path, message: error.message }),
          ),
        ),
      { concurrency: 8 },
    );
    const existingPaths = existing.filter(
      (path): path is string => path !== undefined,
    );
    const gitModes = useTrackedGitModes
      ? yield* trackedGitModes(
          repository,
          existingPaths.map((path) => relativePath(repository.root, path)),
        )
      : new Map<string, GitTrackedMode>();
    return existingPaths
      .map((absolutePath) => {
        const packageRelative = isPathContained(
          node.package.directory,
          absolutePath,
        );
        const matchPath = packageRelative
          ? relativePath(node.package.directory, absolutePath)
          : relativePath(repository.root, absolutePath);
        return {
          absolutePath,
          hashPath: packageRelative
            ? matchPath
            : `${turboRootInputPrefix}${matchPath}`,
          matchPath,
          gitMode: gitModes.get(absolutePath),
          hashResolvedSymlinkContents: true,
        };
      })
      .sort((left, right) => left.hashPath.localeCompare(right.hashPath));
  });

export interface TaskHashResult {
  readonly hash: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly inputFiles: ReadonlyArray<string>;
}

const discoverFiles = (
  repository: RepositoryModel,
  directory: string,
  cacheDirectory: string,
  windowsPathSeparators: boolean,
): Effect.Effect<
  ReadonlyArray<DiscoveredFile>,
  RepositoryError,
  FileSystemService | ProcessService
> =>
  Effect.gen(function* () {
    const processService = yield* ProcessService;
    const fileSystem = yield* FileSystemService;
    const relativeDirectory = relativePath(repository.root, directory);
    const gitModes = windowsPathSeparators
      ? yield* trackedGitModes(repository, [relativeDirectory])
      : new Map<string, GitTrackedMode>();
    const git = yield* Effect.either(
      Effect.scoped(
        processService.runBytes({
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
          env: gitLiteralPathspecEnvironment,
        }),
      ),
    );
    if (git._tag === "Right" && git.right.exitCode === 0) {
      const discovered = (yield* decodeNullDelimitedGitOutputEffect(
        git.right.stdout,
        repository.root,
      ))
        .map((path) => {
          const absolutePath = windowsPathSeparators
            ? joinPath(repository.root, path)
            : `${repository.root.endsWith("/") ? repository.root : `${repository.root}/`}${path}`;
          return {
            absolutePath,
            repositoryRelativePath: path,
            gitMode: gitModes.get(absolutePath),
          };
        })
        .sort((left, right) =>
          left.absolutePath.localeCompare(right.absolutePath),
        );
      const existing = yield* Effect.forEach(
        discovered,
        (file) =>
          fileSystem.exists(file.absolutePath).pipe(
            Effect.map((exists) => (exists ? file : undefined)),
            Effect.mapError(
              (error) =>
                new RepositoryError({
                  path: file.absolutePath,
                  message: error.message,
                }),
            ),
          ),
        { concurrency: 8 },
      );
      return existing.filter(
        (file): file is DiscoveredFile =>
          file !== undefined &&
          !isIgnoredInputPath(file.absolutePath, cacheDirectory),
      );
    }
    return (yield* listRepositoryFiles(directory, { windowsPathSeparators }))
      .filter((path) => !isIgnoredInputPath(path, cacheDirectory))
      .map((absolutePath) => ({
        absolutePath,
        repositoryRelativePath: relativePath(
          repository.root,
          absolutePath,
          windowsPathSeparators,
        ),
        gitMode: undefined,
      }));
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
    for (const path of owningLockfileCandidates(repository, node)) {
      if (yield* exists(path)) return path;
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
    const processService = yield* ProcessService;
    const environmentService = yield* EnvironmentService;
    const environment = yield* environmentService.entries;
    const platform = yield* environmentService.platform;
    const inputs = effectiveTaskInputs(repository, node);
    const packageFiles = yield* discoverFiles(
      repository,
      node.package.directory,
      cacheDirectory,
      platform === "win32",
    );
    const repositoryFiles = usesTurboRootInput(inputs)
      ? yield* discoverFiles(
          repository,
          repository.root,
          cacheDirectory,
          platform === "win32",
        )
      : [];
    const configuredInputFiles = taskInputFiles(
      repository,
      node,
      packageFiles,
      repositoryFiles,
      inputs,
      cacheDirectory,
      platform === "win32",
    );
    const inputFiles = [
      ...new Map(
        [
          ...configuredInputFiles,
          ...(yield* alwaysHashedControlInputFiles(
            repository,
            node,
            cacheDirectory,
            platform === "win32",
          )),
        ].map((input) => [input.absolutePath, input] as const),
      ).values(),
    ].sort((left, right) => compareCodeUnits(left.hashPath, right.hashPath));
    const gitlinkObjectId = (path: string) =>
      Effect.gen(function* () {
        const result = yield* Effect.scoped(
          processService.runBytes({
            command: "git",
            args: [
              "ls-files",
              "--stage",
              "-z",
              "--",
              relativePath(repository.root, path),
            ],
            cwd: repository.root,
            env: gitLiteralPathspecEnvironment,
          }),
        ).pipe(
          Effect.mapError(
            (error) => new RepositoryError({ path, message: error.message }),
          ),
        );
        const objectId = (yield* decodeNullDelimitedGitOutputEffect(
          result.stdout,
          path,
        )).flatMap((entry) => {
          const match = /^160000 ([0-9a-fA-F]+) 0\t/.exec(entry);
          return match?.[1] === undefined ? [] : [match[1]];
        })[0];
        if (result.exitCode !== 0) {
          return yield* Effect.fail(
            new RepositoryError({
              path,
              message:
                new TextDecoder().decode(result.stderr) ||
                "failed to inspect directory input in the Git index",
            }),
          );
        }
        return objectId;
      });
    const hashFile = (
      path: string,
      relative: string,
      gitMode?: GitTrackedMode,
      hashResolvedSymlinkContents = false,
    ) =>
      Effect.gen(function* () {
        const metadata = yield* fileSystem
          .metadata(path)
          .pipe(
            Effect.mapError(
              (error) => new RepositoryError({ path, message: error.message }),
            ),
          );
        if (metadata.kind === "directory") {
          if (gitMode !== undefined && gitMode !== "160000") return undefined;
          const objectId = yield* gitlinkObjectId(path);
          return objectId === undefined
            ? undefined
            : ([relative, "160000", objectId] as const);
        }
        const mode =
          gitMode ??
          (metadata.kind === "symlink"
            ? ("120000" as const)
            : (metadata.mode & 0o111) !== 0
              ? ("100755" as const)
              : ("100644" as const));
        const hash = yield* (
          metadata.kind === "symlink"
            ? fileSystem.readLink(path).pipe(
                Effect.map((target) => new TextEncoder().encode(target)),
                Effect.flatMap(digest.gitBlobSha1),
              )
            : digest.gitBlobSha1File(path)
        ).pipe(
          Effect.mapError(
            (error) => new RepositoryError({ path, message: error.message }),
          ),
        );
        if (metadata.kind === "symlink" && hashResolvedSymlinkContents) {
          const resolvedContentsHash = yield* digest
            .gitBlobSha1File(path)
            .pipe(
              Effect.mapError(
                (error) =>
                  new RepositoryError({ path, message: error.message }),
              ),
            );
          return [relative, mode, hash, resolvedContentsHash] as const;
        }
        return [relative, mode, hash] as const;
      });
    const hashedInputFiles = (yield* Effect.forEach(
      inputFiles,
      (input) =>
        hashFile(
          input.absolutePath,
          input.hashPath,
          input.gitMode,
          input.hashResolvedSymlinkContents,
        ).pipe(
          Effect.map((hash) =>
            hash === undefined ? undefined : { hash, input },
          ),
        ),
      { concurrency: 8 },
    )).filter(
      (entry): entry is NonNullable<typeof entry> => entry !== undefined,
    );
    const fileHashes = hashedInputFiles.map((entry) => entry.hash);
    const globalSettings = activeGlobalSettings(repository);
    const hashedEnvironment = selectEnvironment(
      environment,
      [
        ...(globalSettings.env ?? []),
        ...(node.definition.env ?? []),
        ...(frameworkInference ? inferredEnvironmentPatterns(node) : []),
      ],
      platform === "win32",
    );
    const lockfilePath = yield* owningLockfile(repository, node);
    const lockfileHash =
      lockfilePath === undefined
        ? null
        : yield* digest.xxhash64File(lockfilePath).pipe(
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
    const discoveredGlobalInputFiles =
      globalDependencyPatterns.length === 0
        ? []
        : yield* discoverFiles(
            repository,
            repository.root,
            cacheDirectory,
            platform === "win32",
          );
    const globalInputFilesByRelativePath = new Map(
      discoveredGlobalInputFiles.map((file) => [
        file.repositoryRelativePath,
        file,
      ]),
    );
    const globalInputFiles = selectByGlobs(
      [...globalInputFilesByRelativePath.keys()],
      globalDependencyPatterns,
      platform === "win32",
    );
    const globalFileHashes = (yield* Effect.forEach(
      globalInputFiles,
      (relative) => {
        const file = globalInputFilesByRelativePath.get(relative)!;
        return hashFile(file.absolutePath, relative, file.gitMode);
      },
      { concurrency: 8 },
    )).flatMap((hash) => (hash === undefined ? [] : [hash]));
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
      inputFiles: hashedInputFiles.map((entry) => entry.input.hashPath),
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
  caseInsensitiveNames = false,
): Readonly<Record<string, string | undefined>> => {
  if (mode === "loose") {
    return source;
  }
  const globalSettings = activeGlobalSettings(repository);
  return selectEnvironment(
    source,
    [
      ...strictBaselineEnvironment,
      ...(globalSettings.env ?? []),
      ...(globalSettings.passThroughEnv ?? []),
      ...(node.definition.env ?? []),
      ...(node.definition.passThroughEnv ?? []),
      ...(frameworkInference ? inferredEnvironmentPatterns(node) : []),
    ],
    caseInsensitiveNames,
  );
};
