import { Effect } from "effect";
import { satisfies } from "semver";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { LoadedRootConfiguration } from "../config/runtime.js";
import { loadPackageConfiguration, mergePipeline } from "../config/runtime.js";
import { selectByGlobs } from "../core/glob.js";
import {
  baseName,
  isPathContained,
  joinPath,
  normalizePath,
  parentPath,
  relativePath,
} from "../core/path.js";
import { RepositoryError } from "../effect/errors.js";
import { FileSystemService, ProcessService } from "../effect/services.js";
import type { Pipeline } from "../generated/configuration.js";
import { type ParsedLockfile, parseLockfile } from "./lockfiles.js";

export const packageManagerNames = [
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "aube",
  "nub",
  "cargo",
  "uv",
] as const;

export type PackageManagerName = (typeof packageManagerNames)[number];

export interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly packageManager?: string;
  readonly devEngines?: {
    readonly packageManager?: {
      readonly name?: string;
      readonly version?: string;
    };
  };
  readonly workspaces?:
    | ReadonlyArray<string>
    | { readonly packages?: ReadonlyArray<string> };
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

export interface RepositoryPackage {
  readonly name: string;
  readonly directory: string;
  readonly relativeDirectory: string;
  readonly workspaceDirectory?: string;
  readonly manager: PackageManagerName;
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencyNames: ReadonlyArray<string>;
  readonly internalDependencies: ReadonlyArray<string>;
  readonly tasks: Readonly<Record<string, Pipeline>>;
  readonly manifest: PackageManifest;
}

export interface RepositoryModel {
  readonly root: string;
  readonly manager: PackageManagerName;
  readonly managerVersion?: string;
  readonly rootManifest: PackageManifest;
  readonly rootConfiguration: LoadedRootConfiguration;
  readonly rootPackage: RepositoryPackage;
  readonly lockfile?: string;
  readonly lockfileData?: ParsedLockfile;
  readonly packages: ReadonlyArray<RepositoryPackage>;
  readonly packagesByName: ReadonlyMap<string, RepositoryPackage>;
}

const ignoredDirectories = new Set([
  ".git",
  ".turbo",
  "dist",
  "node_modules",
  "target",
]);

const readJsonObject = (
  path: string,
): Effect.Effect<Record<string, unknown>, RepositoryError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const source = yield* fileSystem
      .readText(path)
      .pipe(
        Effect.mapError(
          (error) => new RepositoryError({ path, message: error.message }),
        ),
      );
    try {
      const value = JSON.parse(source) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError("manifest must be an object");
      }
      return value as Record<string, unknown>;
    } catch (cause) {
      return yield* Effect.fail(
        new RepositoryError({ path, message: String(cause) }),
      );
    }
  });

const decodeManifest = (value: Record<string, unknown>): PackageManifest => ({
  name: typeof value.name === "string" ? value.name : undefined,
  version: typeof value.version === "string" ? value.version : undefined,
  private: typeof value.private === "boolean" ? value.private : undefined,
  packageManager:
    typeof value.packageManager === "string" ? value.packageManager : undefined,
  devEngines:
    typeof value.devEngines === "object" &&
    value.devEngines !== null &&
    !Array.isArray(value.devEngines)
      ? {
          packageManager: (() => {
            const packageManager = (
              value.devEngines as { readonly packageManager?: unknown }
            ).packageManager;
            if (
              typeof packageManager !== "object" ||
              packageManager === null ||
              Array.isArray(packageManager)
            ) {
              return undefined;
            }
            const descriptor = packageManager as Record<string, unknown>;
            return {
              name:
                typeof descriptor.name === "string"
                  ? descriptor.name
                  : undefined,
              version:
                typeof descriptor.version === "string"
                  ? descriptor.version
                  : undefined,
            };
          })(),
        }
      : undefined,
  workspaces: Array.isArray(value.workspaces)
    ? value.workspaces.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : typeof value.workspaces === "object" && value.workspaces !== null
      ? {
          packages: Array.isArray(
            (value.workspaces as { readonly packages?: unknown }).packages,
          )
            ? (
                value.workspaces as {
                  readonly packages: ReadonlyArray<unknown>;
                }
              ).packages.filter(
                (entry): entry is string => typeof entry === "string",
              )
            : undefined,
        }
      : undefined,
  scripts: stringRecord(value.scripts),
  dependencies: stringRecord(value.dependencies),
  devDependencies: stringRecord(value.devDependencies),
  optionalDependencies: stringRecord(value.optionalDependencies),
  peerDependencies: stringRecord(value.peerDependencies),
});

const stringRecord = (
  value: unknown,
): Readonly<Record<string, string>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : undefined;

export const managerFromIdentity = (
  identity: string,
):
  | { readonly name: PackageManagerName; readonly version?: string }
  | undefined => {
  const [name, version] = identity.split("@");
  return packageManagerNames.includes(name as PackageManagerName)
    ? { name: name as PackageManagerName, version }
    : undefined;
};

const discoverManager = (
  root: string,
  identity: string | undefined,
): Effect.Effect<
  { readonly name: PackageManagerName; readonly version?: string },
  RepositoryError,
  FileSystemService
> =>
  Effect.gen(function* () {
    if (identity !== undefined) {
      const manager = managerFromIdentity(identity);
      if (manager === undefined) {
        return yield* Effect.fail(
          new RepositoryError({
            path: joinPath(root, "package.json"),
            message: `unsupported package manager identity: ${identity}`,
          }),
        );
      }
      return manager;
    }
    const fileSystem = yield* FileSystemService;
    const markers: ReadonlyArray<
      readonly [PackageManagerName, ReadonlyArray<string>]
    > = [
      ["aube", ["aube.lock"]],
      ["nub", ["nub.lock"]],
      ["pnpm", ["pnpm-lock.yaml", "pnpm-workspace.yaml"]],
      ["yarn", ["yarn.lock", ".pnp.cjs"]],
      ["bun", ["bun.lock", "bun.lockb"]],
      ["npm", ["package-lock.json", "npm-shrinkwrap.json"]],
    ];
    for (const [name, files] of markers) {
      for (const file of files) {
        const path = joinPath(root, file);
        if (
          yield* fileSystem
            .exists(path)
            .pipe(
              Effect.mapError(
                (error) =>
                  new RepositoryError({ path, message: error.message }),
              ),
            )
        ) {
          return { name };
        }
      }
    }
    return { name: "npm" };
  });

const lockfilesByManager: Readonly<
  Record<PackageManagerName, ReadonlyArray<string>>
> = {
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock", ".pnp.cjs"],
  bun: ["bun.lock", "bun.lockb"],
  aube: [
    "aube.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
  ],
  nub: [
    "nub.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
  ],
  cargo: ["Cargo.lock"],
  uv: ["uv.lock"],
};

const findLockfile = (
  root: string,
  manager: PackageManagerName,
): Effect.Effect<string | undefined, RepositoryError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    for (const name of lockfilesByManager[manager]) {
      const path = joinPath(root, name);
      const exists = yield* fileSystem
        .exists(path)
        .pipe(
          Effect.mapError(
            (error) => new RepositoryError({ path, message: error.message }),
          ),
        );
      if (exists) {
        return path;
      }
    }
    return undefined;
  });

const walkDirectories = (
  root: string,
): Effect.Effect<ReadonlyArray<string>, RepositoryError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const directories: Array<string> = [root];
    const pending: Array<string> = [root];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      const entries = yield* fileSystem
        .list(directory)
        .pipe(
          Effect.mapError(
            (error) =>
              new RepositoryError({ path: directory, message: error.message }),
          ),
        );
      for (const entry of entries) {
        if (entry.kind !== "directory" || ignoredDirectories.has(entry.name)) {
          continue;
        }
        const path = joinPath(directory, entry.name);
        directories.push(path);
        pending.push(path);
      }
    }
    return directories.sort();
  });

const workspacePatterns = (
  root: string,
  manifest: PackageManifest,
): Effect.Effect<ReadonlyArray<string>, RepositoryError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const pnpmWorkspacePath = joinPath(root, "pnpm-workspace.yaml");
    if (
      yield* fileSystem.exists(pnpmWorkspacePath).pipe(
        Effect.mapError(
          (error) =>
            new RepositoryError({
              path: pnpmWorkspacePath,
              message: error.message,
            }),
        ),
      )
    ) {
      const source = yield* fileSystem.readText(pnpmWorkspacePath).pipe(
        Effect.mapError(
          (error) =>
            new RepositoryError({
              path: pnpmWorkspacePath,
              message: error.message,
            }),
        ),
      );
      try {
        const document = parseYaml(source) as { readonly packages?: unknown };
        if (Array.isArray(document?.packages)) {
          return document.packages.filter(
            (entry): entry is string => typeof entry === "string",
          );
        }
      } catch (cause) {
        return yield* Effect.fail(
          new RepositoryError({
            path: pnpmWorkspacePath,
            message: String(cause),
          }),
        );
      }
    }
    if (Array.isArray(manifest.workspaces)) {
      return manifest.workspaces;
    }
    return manifest.workspaces !== undefined &&
      typeof manifest.workspaces === "object" &&
      "packages" in manifest.workspaces
      ? (manifest.workspaces.packages ?? [])
      : [];
  });

const dependencyEntries = (
  manifest: PackageManifest,
): ReadonlyArray<readonly [string, string]> => [
  ...Object.entries(manifest.dependencies ?? {}),
  ...Object.entries(manifest.devDependencies ?? {}),
  ...Object.entries(manifest.optionalDependencies ?? {}),
  ...Object.entries(manifest.peerDependencies ?? {}),
];

const dependencyNames = (manifest: PackageManifest): ReadonlyArray<string> =>
  [...new Set(dependencyEntries(manifest).map(([name]) => name))].sort();

const referencesWorkspaceVersion = (
  specification: string,
  version: string | undefined,
): boolean => {
  if (specification.startsWith("workspace:")) {
    const range = specification.slice("workspace:".length);
    if (range === "" || range === "*" || range === "^" || range === "~") {
      return true;
    }
    return version !== undefined && satisfies(version, range);
  }
  return version !== undefined && satisfies(version, specification);
};

const javascriptInternalDependencies = (
  manifest: PackageManifest,
  packagesByName: ReadonlyMap<string, { readonly manifest: PackageManifest }>,
): ReadonlyArray<string> =>
  [
    ...new Set(
      dependencyEntries(manifest).flatMap(([name, specification]) => {
        const target = packagesByName.get(name);
        return target !== undefined &&
          referencesWorkspaceVersion(specification, target.manifest.version)
          ? [name]
          : [];
      }),
    ),
  ].sort();

const polyglotScripts = (
  manager: "cargo" | "uv",
  entrypointNames: ReadonlyArray<string>,
): Readonly<Record<string, string>> =>
  manager === "cargo"
    ? {
        build: "cargo build",
        check: "cargo check",
        ...(entrypointNames.length > 0 ? { dev: "cargo run" } : {}),
        format: "cargo fmt",
        lint: "cargo clippy",
        ...(entrypointNames.length > 0 ? { run: "cargo run" } : {}),
        test: "cargo test",
      }
    : {
        build: "uv build",
        test: "uv run --frozen pytest",
      };

interface CargoPackageMetadata {
  readonly name: string;
  readonly dependencyNames: ReadonlyArray<string>;
  readonly entrypointNames: ReadonlyArray<string>;
  readonly targetDirectory?: string;
  readonly workspaceDirectory?: string;
}

export const parseCargoMetadata = (
  source: string,
  manifestPath: string,
): CargoPackageMetadata | undefined => {
  const document = JSON.parse(source) as {
    readonly workspace_root?: unknown;
    readonly target_directory?: unknown;
    readonly packages?: ReadonlyArray<{
      readonly name?: unknown;
      readonly manifest_path?: unknown;
      readonly dependencies?: ReadonlyArray<{ readonly name?: unknown }>;
      readonly targets?: ReadonlyArray<{
        readonly kind?: unknown;
        readonly name?: unknown;
      }>;
    }>;
  };
  const packageMetadata = document.packages?.find(
    (entry) =>
      typeof entry.manifest_path === "string" &&
      normalizePath(entry.manifest_path) === normalizePath(manifestPath),
  );
  if (
    packageMetadata === undefined ||
    typeof packageMetadata.name !== "string"
  ) {
    return undefined;
  }
  return {
    name: packageMetadata.name,
    dependencyNames: [
      ...new Set(
        (packageMetadata.dependencies ?? []).flatMap((dependency) =>
          typeof dependency.name === "string" ? [dependency.name] : [],
        ),
      ),
    ].sort(),
    entrypointNames: [
      ...new Set(
        (packageMetadata.targets ?? []).flatMap((target) =>
          Array.isArray(target.kind) &&
          target.kind.includes("bin") &&
          typeof target.name === "string"
            ? [target.name]
            : [],
        ),
      ),
    ].sort(),
    ...(typeof document.target_directory === "string"
      ? { targetDirectory: normalizePath(document.target_directory) }
      : {}),
    ...(typeof document.workspace_root === "string"
      ? { workspaceDirectory: normalizePath(document.workspace_root) }
      : {}),
  };
};

const cargoPackageMetadata = (
  manifestPath: string,
): Effect.Effect<
  CargoPackageMetadata | undefined,
  RepositoryError,
  ProcessService
> =>
  Effect.gen(function* () {
    const processService = yield* ProcessService;
    const result = yield* Effect.scoped(
      processService.run({
        command: "cargo",
        args: [
          "metadata",
          "--format-version=1",
          "--no-deps",
          "--manifest-path",
          manifestPath,
        ],
        cwd: parentPath(manifestPath),
      }),
    ).pipe(
      Effect.mapError(
        (error) =>
          new RepositoryError({ path: manifestPath, message: error.message }),
      ),
    );
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        new RepositoryError({
          path: manifestPath,
          message: result.stderr || "cargo metadata failed",
        }),
      );
    }
    try {
      return parseCargoMetadata(result.stdout, manifestPath);
    } catch (cause) {
      return yield* Effect.fail(
        new RepositoryError({ path: manifestPath, message: String(cause) }),
      );
    }
  });

interface PythonProjectMetadata {
  readonly name?: string;
  readonly dependencyNames: ReadonlyArray<string>;
  readonly workspace?: {
    readonly members: ReadonlyArray<string>;
    readonly exclude: ReadonlyArray<string>;
  };
}

const recordValue = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const stringArrayValue = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const normalizePythonPackageName = (name: string): string =>
  name.toLowerCase().replace(/[-_.]+/g, "-");

const parsePythonProjectMetadata = (source: string): PythonProjectMetadata => {
  const document = recordValue(parseToml(source));
  const project = recordValue(document?.project);
  const optionalDependencies = recordValue(project?.["optional-dependencies"]);
  const dependencyGroups = recordValue(document?.["dependency-groups"]);
  const tool = recordValue(document?.tool);
  const uv = recordValue(tool?.uv);
  const workspace = recordValue(uv?.workspace);
  const requirements = [
    ...stringArrayValue(project?.dependencies),
    ...Object.values(optionalDependencies ?? {}).flatMap(stringArrayValue),
    ...Object.values(dependencyGroups ?? {}).flatMap(stringArrayValue),
    ...stringArrayValue(uv?.["dev-dependencies"]),
  ];
  const names = new Set<string>();
  for (const requirement of requirements) {
    const name = /^([A-Za-z0-9][A-Za-z0-9_.-]*)/.exec(requirement.trim())?.[1];
    if (name !== undefined) names.add(normalizePythonPackageName(name));
  }
  return {
    name: typeof project?.name === "string" ? project.name : undefined,
    dependencyNames: [...names].sort(),
    ...(workspace === undefined
      ? {}
      : {
          workspace: {
            members: stringArrayValue(workspace.members),
            exclude: stringArrayValue(workspace.exclude),
          },
        }),
  };
};

const uvTasks = (
  packageName: string,
  configured: Readonly<Record<string, Pipeline>>,
): Readonly<Record<string, Pipeline>> => {
  const buildDefaults: Pipeline = { cache: false };
  const tasks: Record<string, Pipeline> = {
    ...configured,
    build: mergePipeline(buildDefaults, configured.build ?? {}),
  };
  const qualifiedBuild = `${packageName}#build`;
  if (configured[qualifiedBuild] !== undefined) {
    tasks[qualifiedBuild] = mergePipeline(
      buildDefaults,
      configured[qualifiedBuild],
    );
  }
  return tasks;
};

const cargoTasks = (
  root: string,
  packageName: string,
  metadata: CargoPackageMetadata | undefined,
  configured: Readonly<Record<string, Pipeline>>,
): Readonly<Record<string, Pipeline>> => {
  const outputPrefix =
    metadata?.targetDirectory !== undefined &&
    isPathContained(root, metadata.targetDirectory)
      ? `$TURBO_ROOT$/${relativePath(root, metadata.targetDirectory)}/debug`
      : undefined;
  const outputs =
    outputPrefix === undefined
      ? []
      : (metadata?.entrypointNames ?? []).flatMap((name) => [
          `${outputPrefix}/${name}`,
          `${outputPrefix}/${name}.exe`,
        ]);
  const buildDefaults: Pipeline =
    outputs.length === 0 ? { cache: false } : { outputs };
  const formatDefaults: Pipeline = { cache: false };
  const tasks: Record<string, Pipeline> = {
    ...configured,
    build: mergePipeline(buildDefaults, configured.build ?? {}),
    format: mergePipeline(formatDefaults, configured.format ?? {}),
  };
  const qualifiedBuild = `${packageName}#build`;
  if (configured[qualifiedBuild] !== undefined) {
    tasks[qualifiedBuild] = mergePipeline(
      buildDefaults,
      configured[qualifiedBuild],
    );
  }
  const qualifiedFormat = `${packageName}#format`;
  if (configured[qualifiedFormat] !== undefined) {
    tasks[qualifiedFormat] = mergePipeline(
      formatDefaults,
      configured[qualifiedFormat],
    );
  }
  return tasks;
};

export const discoverRepository = (
  root: string,
  rootConfiguration: LoadedRootConfiguration,
): Effect.Effect<
  RepositoryModel,
  RepositoryError,
  FileSystemService | ProcessService
> =>
  Effect.gen(function* () {
    const rootManifestPath = joinPath(root, "package.json");
    const rootManifest = decodeManifest(
      yield* readJsonObject(rootManifestPath),
    );
    const devEngineManager = rootManifest.devEngines?.packageManager;
    const declaredManager =
      devEngineManager?.name === undefined
        ? rootManifest.packageManager
        : `${devEngineManager.name}${
            devEngineManager.version === undefined
              ? ""
              : `@${devEngineManager.version}`
          }`;
    const managerIdentity = yield* discoverManager(root, declaredManager);
    const patterns = yield* workspacePatterns(root, rootManifest);
    const directories = yield* walkDirectories(root);
    const candidateDirectoryPaths = new Set(
      selectByGlobs(
        directories
          .map((directory) => relativePath(root, directory))
          .filter((relative) => relative !== "."),
        patterns,
      ),
    );
    const candidateDirectories = directories.filter((directory) =>
      candidateDirectoryPaths.has(relativePath(root, directory)),
    );
    const packageDrafts = yield* Effect.forEach(
      candidateDirectories,
      (directory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystemService;
          const manifestPath = joinPath(directory, "package.json");
          if (
            !(yield* fileSystem.exists(manifestPath).pipe(
              Effect.mapError(
                (error) =>
                  new RepositoryError({
                    path: manifestPath,
                    message: error.message,
                  }),
              ),
            ))
          ) {
            return undefined;
          }
          const manifest = decodeManifest(yield* readJsonObject(manifestPath));
          const name = manifest.name ?? baseName(directory);
          const tasks = yield* loadPackageConfiguration(
            directory,
            name,
            rootConfiguration,
          ).pipe(
            Effect.mapError(
              (error) =>
                new RepositoryError({
                  path: error.path,
                  message: error.message,
                }),
            ),
          );
          return {
            name,
            directory,
            relativeDirectory: relativePath(root, directory),
            manager: managerIdentity.name,
            scripts: manifest.scripts ?? {},
            dependencyNames: dependencyNames(manifest),
            tasks,
            manifest,
          };
        }),
      { concurrency: 1 },
    );
    const javascriptDrafts = packageDrafts.filter(
      (entry): entry is NonNullable<typeof entry> => entry !== undefined,
    );
    const javascriptDirectories = new Set(
      javascriptDrafts.map((entry) => entry.directory),
    );
    const cargoEnabled =
      rootConfiguration.value.futureFlags?.experimentalCargoWorkspaces === true;
    const pythonEnabled =
      rootConfiguration.value.futureFlags?.experimentalPythonWorkspaces ===
      true;
    const pythonWorkspaceDirectories = new Set<string>();
    if (pythonEnabled) {
      const fileSystem = yield* FileSystemService;
      const rootPythonProjectPath = joinPath(root, "pyproject.toml");
      if (
        yield* fileSystem.exists(rootPythonProjectPath).pipe(
          Effect.mapError(
            (error) =>
              new RepositoryError({
                path: rootPythonProjectPath,
                message: error.message,
              }),
          ),
        )
      ) {
        const source = yield* fileSystem.readText(rootPythonProjectPath).pipe(
          Effect.mapError(
            (error) =>
              new RepositoryError({
                path: rootPythonProjectPath,
                message: error.message,
              }),
          ),
        );
        let metadata: PythonProjectMetadata;
        try {
          metadata = parsePythonProjectMetadata(source);
        } catch (cause) {
          return yield* Effect.fail(
            new RepositoryError({
              path: rootPythonProjectPath,
              message: String(cause),
            }),
          );
        }
        if (metadata.workspace !== undefined) {
          pythonWorkspaceDirectories.add(root);
          const memberDirectories = selectByGlobs(
            directories
              .map((directory) => relativePath(root, directory))
              .filter((relative) => relative !== "."),
            metadata.workspace.members,
          );
          const excludedDirectories = new Set(
            selectByGlobs(memberDirectories, metadata.workspace.exclude),
          );
          for (const relative of memberDirectories) {
            if (!excludedDirectories.has(relative)) {
              pythonWorkspaceDirectories.add(joinPath(root, relative));
            }
          }
        }
      }
    }
    const polyglotDrafts = yield* Effect.forEach(
      directories.filter((directory) => !javascriptDirectories.has(directory)),
      (directory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystemService;
          const candidates = [
            ...(cargoEnabled
              ? [{ file: "Cargo.toml", manager: "cargo" as const }]
              : []),
            ...(pythonWorkspaceDirectories.has(directory)
              ? [{ file: "pyproject.toml", manager: "uv" as const }]
              : []),
          ];
          for (const candidate of candidates) {
            const path = joinPath(directory, candidate.file);
            if (
              !(yield* fileSystem
                .exists(path)
                .pipe(
                  Effect.mapError(
                    (error) =>
                      new RepositoryError({ path, message: error.message }),
                  ),
                ))
            ) {
              continue;
            }
            const source = yield* fileSystem
              .readText(path)
              .pipe(
                Effect.mapError(
                  (error) =>
                    new RepositoryError({ path, message: error.message }),
                ),
              );
            const cargoMetadata =
              candidate.manager === "cargo"
                ? yield* cargoPackageMetadata(path)
                : undefined;
            let pythonMetadata: PythonProjectMetadata | undefined;
            if (candidate.manager === "uv") {
              try {
                pythonMetadata = parsePythonProjectMetadata(source);
              } catch (cause) {
                return yield* Effect.fail(
                  new RepositoryError({ path, message: String(cause) }),
                );
              }
            }
            const name =
              candidate.manager === "cargo"
                ? cargoMetadata?.name
                : pythonMetadata?.name;
            if (name === undefined) {
              continue;
            }
            const configuredTasks = (rootConfiguration.value.tasks ??
              {}) as Readonly<Record<string, Pipeline>>;
            return {
              name,
              directory,
              relativeDirectory: relativePath(root, directory),
              workspaceDirectory: cargoMetadata?.workspaceDirectory,
              manager: candidate.manager,
              scripts: polyglotScripts(
                candidate.manager,
                cargoMetadata?.entrypointNames ?? [],
              ),
              dependencyNames:
                candidate.manager === "cargo"
                  ? (cargoMetadata?.dependencyNames ?? [])
                  : (pythonMetadata?.dependencyNames ?? []),
              tasks:
                candidate.manager === "cargo"
                  ? cargoTasks(root, name, cargoMetadata, configuredTasks)
                  : uvTasks(name, configuredTasks),
              manifest: { name, private: true } satisfies PackageManifest,
            };
          }
          return undefined;
        }),
      { concurrency: 1 },
    );
    const drafts = [
      ...javascriptDrafts,
      ...polyglotDrafts.filter(
        (entry): entry is NonNullable<typeof entry> => entry !== undefined,
      ),
    ];
    const names = new Set<string>();
    const uvNames = new Map<string, string>();
    for (const packageDraft of drafts) {
      if (names.has(packageDraft.name)) {
        return yield* Effect.fail(
          new RepositoryError({
            path: packageDraft.directory,
            message: `duplicate package name: ${packageDraft.name}`,
          }),
        );
      }
      names.add(packageDraft.name);
      if (packageDraft.manager === "uv") {
        const identity = normalizePythonPackageName(packageDraft.name);
        const existing = uvNames.get(identity);
        if (existing !== undefined) {
          return yield* Effect.fail(
            new RepositoryError({
              path: packageDraft.directory,
              message: `duplicate uv package identity: ${existing} and ${packageDraft.name}`,
            }),
          );
        }
        uvNames.set(identity, packageDraft.name);
      }
    }
    const draftsByName = new Map(
      drafts.map((packageDraft) => [packageDraft.name, packageDraft] as const),
    );
    const packages: ReadonlyArray<RepositoryPackage> = drafts
      .map((packageDraft) => ({
        ...packageDraft,
        internalDependencies:
          packageDraft.manager === "uv"
            ? packageDraft.dependencyNames.flatMap((name) => {
                const resolved = uvNames.get(normalizePythonPackageName(name));
                return resolved === undefined ? [] : [resolved];
              })
            : packageDraft.manager === "cargo"
              ? packageDraft.dependencyNames.filter((name) => names.has(name))
              : javascriptInternalDependencies(
                  packageDraft.manifest,
                  draftsByName,
                ),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const rootTasks = Object.fromEntries(
      Object.entries(rootConfiguration.value.tasks ?? {}).flatMap(
        ([name, definition]) =>
          name.startsWith("//#") && name.length > 3
            ? [[name.slice(3), definition] as const]
            : [],
      ),
    );
    const rootPackage: RepositoryPackage = {
      name: "//",
      directory: root,
      relativeDirectory: ".",
      manager: managerIdentity.name,
      scripts: rootManifest.scripts ?? {},
      dependencyNames: dependencyNames(rootManifest),
      internalDependencies: javascriptInternalDependencies(
        rootManifest,
        draftsByName,
      ),
      tasks: rootTasks,
      manifest: rootManifest,
    };
    const lockfile = yield* findLockfile(root, managerIdentity.name);
    let lockfileData: ParsedLockfile | undefined;
    if (lockfile !== undefined) {
      const fileSystem = yield* FileSystemService;
      const contents = yield* fileSystem
        .readBytes(lockfile)
        .pipe(
          Effect.mapError(
            (error) =>
              new RepositoryError({ path: lockfile, message: error.message }),
          ),
        );
      try {
        lockfileData = parseLockfile(lockfile, contents);
      } catch (cause) {
        return yield* Effect.fail(
          new RepositoryError({ path: lockfile, message: String(cause) }),
        );
      }
    }
    return {
      root,
      manager: managerIdentity.name,
      managerVersion: managerIdentity.version,
      rootManifest,
      rootConfiguration,
      rootPackage,
      lockfile,
      lockfileData,
      packages,
      packagesByName: new Map<string, RepositoryPackage>([
        [rootPackage.name, rootPackage],
        ...packages.map((entry) => [entry.name, entry] as const),
      ]),
    };
  });

export const listRepositoryFiles = (
  directory: string,
  options: {
    readonly ignoredDirectories?: ReadonlySet<string>;
  } = {},
): Effect.Effect<ReadonlyArray<string>, RepositoryError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const files: Array<string> = [];
    const pending = [directory];
    while (pending.length > 0) {
      const current = pending.pop()!;
      const entries = yield* fileSystem
        .list(current)
        .pipe(
          Effect.mapError(
            (error) =>
              new RepositoryError({ path: current, message: error.message }),
          ),
        );
      for (const entry of entries) {
        if (
          entry.kind === "directory" &&
          !(options.ignoredDirectories ?? ignoredDirectories).has(entry.name)
        ) {
          pending.push(joinPath(current, entry.name));
        } else if (entry.kind === "file" || entry.kind === "symlink") {
          files.push(joinPath(current, entry.name));
        }
      }
    }
    return files.sort();
  });
