import { Effect } from "effect";
import { matchesGlob, selectByGlobs } from "../core/glob.js";
import { joinPath, relativePath } from "../core/path.js";
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

const taskInputFiles = (
  node: TaskNode,
  allFiles: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const defaults = allFiles
    .filter(
      (path) => !path.includes("/.turbo/") && !path.includes("/node_modules/"),
    )
    .map((path) => relativePath(node.package.directory, path));
  const inputs = node.definition.inputs;
  if (inputs === undefined || inputs === null || inputs.length === 0) {
    return defaults.sort();
  }
  const selected = new Set<string>();
  for (const input of inputs) {
    if (typeof input !== "string") {
      for (const glob of input.globs ?? []) {
        for (const file of defaults) {
          if (matchesGlob(file, glob)) {
            selected.add(file);
          }
        }
      }
      if (input.withDefaults !== false) {
        for (const file of defaults) {
          selected.add(file);
        }
      }
      continue;
    }
    if (input === "$TURBO_DEFAULT$") {
      for (const file of defaults) {
        selected.add(file);
      }
    } else if (input.startsWith("!")) {
      for (const file of selected) {
        if (matchesGlob(file, input.slice(1))) {
          selected.delete(file);
        }
      }
    } else {
      for (const file of defaults) {
        if (matchesGlob(file, input)) {
          selected.add(file);
        }
      }
    }
  }
  return [...selected].sort();
};

export interface TaskHashResult {
  readonly hash: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly inputFiles: ReadonlyArray<string>;
}

const discoverFiles = (
  repository: RepositoryModel,
  directory: string,
): Effect.Effect<
  ReadonlyArray<string>,
  RepositoryError,
  FileSystemService | ProcessService
> =>
  Effect.gen(function* () {
    const processService = yield* ProcessService;
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
      return git.right.stdout
        .split("\0")
        .filter(Boolean)
        .map((path) => joinPath(repository.root, path))
        .sort();
    }
    return yield* listRepositoryFiles(directory);
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
    const allFiles = yield* discoverFiles(repository, node.package.directory);
    const inputFiles = taskInputFiles(node, allFiles);
    const fileHashes = yield* Effect.forEach(
      inputFiles,
      (relative) =>
        fileSystem.readBytes(joinPath(node.package.directory, relative)).pipe(
          Effect.flatMap((bytes) => digest.gitBlobSha1(bytes)),
          Effect.map((hash) => [relative, hash] as const),
          Effect.mapError(
            (error) =>
              new RepositoryError({
                path: joinPath(node.package.directory, relative),
                message: error.message,
              }),
          ),
        ),
      { concurrency: 8 },
    );
    const globalSettings = activeGlobalSettings(repository);
    const hashedEnvironment = selectEnvironment(environment, [
      ...(globalSettings.env ?? []),
      ...(node.definition.env ?? []),
      ...(frameworkInference ? inferredEnvironmentPatterns(node) : []),
    ]);
    const lockfileHash =
      repository.lockfile === undefined
        ? null
        : yield* fileSystem.readBytes(repository.lockfile).pipe(
            Effect.map(xxhash64Hex),
            Effect.mapError(
              (error) =>
                new RepositoryError({
                  path: repository.lockfile!,
                  message: error.message,
                }),
            ),
          );
    const globalDependencyPatterns = globalSettings.inputs ?? [];
    const globalInputFiles =
      globalDependencyPatterns.length === 0
        ? []
        : selectByGlobs(
            (yield* discoverFiles(repository, repository.root)).map((path) =>
              relativePath(repository.root, path),
            ),
            globalDependencyPatterns,
          );
    const globalFileHashes = yield* Effect.forEach(
      globalInputFiles,
      (relative) =>
        fileSystem.readBytes(joinPath(repository.root, relative)).pipe(
          Effect.flatMap((bytes) => digest.gitBlobSha1(bytes)),
          Effect.map((hash) => [relative, hash] as const),
          Effect.mapError(
            (error) =>
              new RepositoryError({
                path: joinPath(repository.root, relative),
                message: error.message,
              }),
          ),
        ),
      { concurrency: 8 },
    );
    const hash = xxhash64Hex(
      canonicalStringify({
        packageManager: `${repository.manager}@${repository.managerVersion ?? ""}`,
        lockfileHash,
        package: node.package.relativeDirectory,
        task: node.task,
        command: node.command,
        definition: node.definition,
        files: fileHashes,
        environment: hashedEnvironment,
        dependencies: [...dependencyHashes].sort(),
        globalDependencies: globalDependencyPatterns,
        globalFiles: globalFileHashes,
      }),
    );
    return { hash, environment: hashedEnvironment, inputFiles };
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
