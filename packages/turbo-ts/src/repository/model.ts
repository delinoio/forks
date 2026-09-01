import { Effect } from "effect";
import { satisfies } from "semver";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { LoadedRootConfiguration } from "../config/runtime.js";
import { loadPackageConfiguration, mergePipeline } from "../config/runtime.js";
import { canMatchGlobDescendant, selectByGlobs } from "../core/glob.js";
import {
  baseName,
  isAbsolutePath,
  isPathContained,
  joinPath,
  normalizePath,
  parentPath,
  relativePath,
} from "../core/path.js";
import { RepositoryError } from "../effect/errors.js";
import { FileSystemService, ProcessService } from "../effect/services.js";
import type { Pipeline } from "../generated/configuration.js";

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
  readonly canonicalRelativeDirectory: string;
  readonly cachePathRestorable: boolean;
  readonly workspaceDirectory?: string;
  readonly manager: PackageManagerName;
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencyNames: ReadonlyArray<string>;
  readonly internalDependencies: ReadonlyArray<string>;
  readonly excludedTasks: ReadonlySet<string>;
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
  readonly packages: ReadonlyArray<RepositoryPackage>;
  readonly packagesByName: ReadonlyMap<string, RepositoryPackage>;
}

const workspaceTraversalIgnoredDirectories = new Set([
  ".git",
  ".turbo",
  ".venv",
  "node_modules",
]);

const comparableFilesystemPath = (path: string): string => {
  const normalized = normalizePath(path);
  return /^[A-Za-z]:/.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
};

const repositoryPathFromCanonical = (
  root: string,
  canonicalRoot: string,
  path: string,
): string | undefined => {
  const normalizedRoot = normalizePath(canonicalRoot).replace(/\/$/, "");
  const normalizedPath = normalizePath(path);
  const comparableRoot = comparableFilesystemPath(normalizedRoot);
  const comparablePath = comparableFilesystemPath(normalizedPath);
  if (comparablePath === comparableRoot) return normalizePath(root);
  if (!comparablePath.startsWith(`${comparableRoot}/`)) return undefined;
  return joinPath(root, normalizedPath.slice(normalizedRoot.length + 1));
};

const fileTraversalIgnoredDirectories = new Set([
  ".git",
  ".turbo",
  ".venv",
  "node_modules",
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
  patterns: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, RepositoryError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const positivePatterns = patterns.filter(
      (pattern) => !pattern.startsWith("!"),
    );
    const canonicalRoot = yield* fileSystem
      .realPath(root)
      .pipe(
        Effect.mapError(
          (error) =>
            new RepositoryError({ path: root, message: error.message }),
        ),
      );
    const directories: Array<string> = [root];
    const pending: Array<{
      readonly path: string;
      readonly ancestors: ReadonlySet<string>;
    }> = [
      {
        path: root,
        ancestors: new Set([comparableFilesystemPath(canonicalRoot)]),
      },
    ];
    while (pending.length > 0) {
      const current = pending.pop()!;
      const directory = current.path;
      const entries = yield* fileSystem
        .list(directory)
        .pipe(
          Effect.mapError(
            (error) =>
              new RepositoryError({ path: directory, message: error.message }),
          ),
        );
      for (const entry of entries) {
        if (
          (entry.kind !== "directory" && entry.kind !== "symlink") ||
          workspaceTraversalIgnoredDirectories.has(entry.name)
        ) {
          continue;
        }
        const path = joinPath(directory, entry.name);
        const relative = relativePath(root, path);
        if (
          !positivePatterns.some((pattern) =>
            canMatchGlobDescendant(relative, pattern),
          )
        ) {
          continue;
        }
        const resolved = yield* Effect.either(fileSystem.realPath(path));
        if (resolved._tag === "Left") {
          if (entry.kind === "symlink") continue;
          return yield* Effect.fail(
            new RepositoryError({ path, message: resolved.left.message }),
          );
        }
        if (!isPathContained(canonicalRoot, resolved.right)) continue;
        if (entry.kind === "symlink") {
          const targetMetadata = yield* fileSystem
            .metadata(resolved.right)
            .pipe(
              Effect.mapError(
                (error) =>
                  new RepositoryError({ path, message: error.message }),
              ),
            );
          if (targetMetadata.kind !== "directory") continue;
        }
        const identity = comparableFilesystemPath(resolved.right);
        if (current.ancestors.has(identity)) continue;
        directories.push(path);
        pending.push({
          path,
          ancestors: new Set([...current.ancestors, identity]),
        });
      }
    }
    const uniqueDirectories: Array<string> = [];
    const canonicalDirectories = new Set<string>();
    for (const directory of directories.sort()) {
      const canonicalDirectory = yield* fileSystem
        .realPath(directory)
        .pipe(
          Effect.mapError(
            (error) =>
              new RepositoryError({ path: directory, message: error.message }),
          ),
        );
      const identity = comparableFilesystemPath(canonicalDirectory);
      if (canonicalDirectories.has(identity)) continue;
      canonicalDirectories.add(identity);
      uniqueDirectories.push(directory);
    }
    return uniqueDirectories;
  });

const workspacePatterns = (
  root: string,
  manager: PackageManagerName,
  manifest: PackageManifest,
): Effect.Effect<ReadonlyArray<string>, RepositoryError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const pnpmWorkspacePath = joinPath(root, "pnpm-workspace.yaml");
    if (
      manager === "pnpm" &&
      (yield* fileSystem.exists(pnpmWorkspacePath).pipe(
        Effect.mapError(
          (error) =>
            new RepositoryError({
              path: pnpmWorkspacePath,
              message: error.message,
            }),
        ),
      ))
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
        const document = parseYaml(source) as unknown;
        if (
          typeof document !== "object" ||
          document === null ||
          Array.isArray(document)
        ) {
          throw new TypeError("workspace document must be an object");
        }
        const packages = (document as { readonly packages?: unknown }).packages;
        if (packages === undefined) {
          return [];
        }
        if (
          !Array.isArray(packages) ||
          packages.some((entry) => typeof entry !== "string")
        ) {
          throw new TypeError("packages must be an array of strings");
        }
        return packages as ReadonlyArray<string>;
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

const canonicalFilesystemIdentity = (
  path: string,
): Effect.Effect<string | undefined, never, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    return yield* fileSystem.realPath(path).pipe(
      Effect.map((resolved) => comparableFilesystemPath(resolved)),
      Effect.catchAll(() => Effect.succeed(undefined)),
    );
  });

const cachePathIsRestorable = (
  root: string,
  directory: string,
): Effect.Effect<boolean, RepositoryError, FileSystemService> =>
  Effect.gen(function* () {
    if (!isPathContained(root, directory)) return false;
    const fileSystem = yield* FileSystemService;
    let current = root;
    for (const segment of relativePath(root, directory).split("/")) {
      if (segment === "" || segment === ".") continue;
      current = joinPath(current, segment);
      const metadata = yield* fileSystem
        .metadata(current)
        .pipe(
          Effect.mapError(
            (error) =>
              new RepositoryError({ path: current, message: error.message }),
          ),
        );
      if (metadata.kind === "symlink") return false;
    }
    return true;
  });

const referencesWorkspacePackage = (
  _declaringDirectory: string,
  specification: string,
  target: {
    readonly directory: string;
    readonly manifest: PackageManifest;
  },
): Effect.Effect<boolean, never, FileSystemService> => {
  if (specification.startsWith("workspace:")) {
    const range = specification.slice("workspace:".length);
    if (range === "" || range === "*" || range === "^" || range === "~") {
      return Effect.succeed(true);
    }
    return Effect.succeed(
      target.manifest.version !== undefined &&
        satisfies(target.manifest.version, range),
    );
  }
  return Effect.succeed(
    target.manifest.version !== undefined &&
      satisfies(target.manifest.version, specification),
  );
};

const localPathSpecification = (
  declaringDirectory: string,
  specification: string,
): string | undefined => {
  const protocol = (["file:", "link:"] as const).find((candidate) =>
    specification.startsWith(candidate),
  );
  if (protocol === undefined) return undefined;
  const path = specification.slice(protocol.length);
  if (path === "") return undefined;
  return isAbsolutePath(path)
    ? normalizePath(path)
    : joinPath(declaringDirectory, path);
};

const pnpmWorkspaceAlias = (
  name: string,
  specification: string,
): { readonly name: string; readonly specification: string } => {
  if (!specification.startsWith("workspace:")) {
    return { name, specification };
  }
  const targetAndRange = specification.slice("workspace:".length);
  const separator = targetAndRange.lastIndexOf("@");
  if (separator <= 0 || separator === targetAndRange.length - 1) {
    return { name, specification };
  }
  const targetName = targetAndRange.slice(0, separator);
  if (targetName.startsWith("@") && !targetName.includes("/")) {
    return { name, specification };
  }
  return {
    name: targetName,
    specification: `workspace:${targetAndRange.slice(separator + 1)}`,
  };
};

const javascriptInternalDependencies = (
  declaringDirectory: string,
  manifest: PackageManifest,
  manager: PackageManagerName,
  packagesByName: ReadonlyMap<
    string,
    { readonly directory: string; readonly manifest: PackageManifest }
  >,
): Effect.Effect<ReadonlyArray<string>, never, FileSystemService> =>
  Effect.gen(function* () {
    const packagesByFilesystemIdentity = new Map(
      (yield* Effect.forEach(
        [...packagesByName],
        ([name, target]) =>
          canonicalFilesystemIdentity(target.directory).pipe(
            Effect.map((identity) =>
              identity === undefined ? undefined : ([identity, name] as const),
            ),
          ),
        { concurrency: 8 },
      )).filter(
        (entry): entry is readonly [string, string] => entry !== undefined,
      ),
    );
    const declaringFilesystemIdentity =
      yield* canonicalFilesystemIdentity(declaringDirectory);
    const declaringPackageName =
      declaringFilesystemIdentity === undefined
        ? undefined
        : packagesByFilesystemIdentity.get(declaringFilesystemIdentity);
    const references = yield* Effect.forEach(
      dependencyEntries(manifest),
      ([name, specification]) => {
        const localPath = localPathSpecification(
          declaringDirectory,
          specification,
        );
        if (localPath !== undefined) {
          return canonicalFilesystemIdentity(localPath).pipe(
            Effect.map((identity) =>
              identity === undefined
                ? undefined
                : packagesByFilesystemIdentity.get(identity),
            ),
          );
        }
        const reference =
          manager === "pnpm"
            ? pnpmWorkspaceAlias(name, specification)
            : { name, specification };
        const target = packagesByName.get(reference.name);
        return target === undefined
          ? Effect.succeed(undefined)
          : referencesWorkspacePackage(
              declaringDirectory,
              reference.specification,
              target,
            ).pipe(
              Effect.map((matches) => (matches ? reference.name : undefined)),
            );
      },
      { concurrency: 8 },
    );
    return [
      ...new Set(
        references.filter(
          (name): name is string =>
            name !== undefined && name !== declaringPackageName,
        ),
      ),
    ].sort();
  });

const polyglotScripts = (
  manager: "cargo" | "uv",
  entrypointNames: ReadonlyArray<string>,
): Readonly<Record<string, string>> =>
  manager === "cargo"
    ? {
        build: "cargo build",
        check: "cargo check",
        ...(entrypointNames.length === 1 ? { dev: "cargo run" } : {}),
        format: "cargo fmt",
        lint: "cargo clippy",
        ...(entrypointNames.length === 1 ? { run: "cargo run" } : {}),
        test: "cargo test",
      }
    : {
        build: "uv build",
        test: "uv run --frozen pytest",
      };

interface CargoPackageMetadata {
  readonly name: string;
  readonly dependencies: ReadonlyArray<CargoDependencyMetadata>;
  readonly dependencyNames: ReadonlyArray<string>;
  readonly entrypointNames: ReadonlyArray<string>;
  readonly hasLibraryTarget: boolean;
  readonly targetDirectory?: string;
  readonly workspaceDirectory?: string;
}

interface CargoWorkspacePackageMetadata extends CargoPackageMetadata {
  readonly manifestPath: string;
}

interface CargoWorkspaceMetadata {
  readonly directory: string;
  readonly packages: ReadonlyArray<CargoWorkspacePackageMetadata>;
}

interface CargoDependencyMetadata {
  readonly name: string;
  readonly path?: string;
  readonly source?: string;
}

interface RepositoryPackageDraft
  extends Omit<RepositoryPackage, "internalDependencies"> {
  readonly cargoDependencies: ReadonlyArray<CargoDependencyMetadata>;
  readonly uvDependencySources?: ReadonlyMap<
    string,
    ReadonlyArray<PythonDependencySource>
  >;
}

export const parseCargoMetadata = (
  source: string,
  manifestPath: string,
): CargoPackageMetadata | undefined => {
  const document = JSON.parse(source) as {
    readonly workspace_root?: unknown;
    readonly workspace_members?: ReadonlyArray<unknown>;
    readonly target_directory?: unknown;
    readonly packages?: ReadonlyArray<{
      readonly id?: unknown;
      readonly name?: unknown;
      readonly manifest_path?: unknown;
      readonly dependencies?: ReadonlyArray<{
        readonly name?: unknown;
        readonly path?: unknown;
        readonly source?: unknown;
      }>;
      readonly targets?: ReadonlyArray<{
        readonly kind?: unknown;
        readonly name?: unknown;
      }>;
    }>;
  };
  const workspaceDirectory =
    typeof document.workspace_root === "string"
      ? normalizePath(document.workspace_root)
      : parentPath(manifestPath);
  const workspaceMembers = new Set(
    (document.workspace_members ?? []).filter(
      (member): member is string => typeof member === "string",
    ),
  );
  const packages = (document.packages ?? []).flatMap((packageMetadata) => {
    if (
      typeof packageMetadata.name !== "string" ||
      typeof packageMetadata.manifest_path !== "string" ||
      (workspaceMembers.size > 0 &&
        (typeof packageMetadata.id !== "string" ||
          !workspaceMembers.has(packageMetadata.id)))
    ) {
      return [];
    }
    const dependencies = [
      ...new Map(
        (packageMetadata.dependencies ?? []).flatMap((dependency) => {
          if (typeof dependency.name !== "string") return [];
          const value: CargoDependencyMetadata = {
            name: dependency.name,
            ...(typeof dependency.path === "string"
              ? { path: normalizePath(dependency.path) }
              : {}),
            ...(typeof dependency.source === "string"
              ? { source: dependency.source }
              : {}),
          };
          return [
            [
              `${value.name}\0${value.source ?? ""}\0${value.path ?? ""}`,
              value,
            ] as const,
          ];
        }),
      ).values(),
    ].sort((left, right) =>
      `${left.name}\0${left.source ?? ""}\0${left.path ?? ""}`.localeCompare(
        `${right.name}\0${right.source ?? ""}\0${right.path ?? ""}`,
      ),
    );
    return [
      {
        name: packageMetadata.name,
        manifestPath: normalizePath(packageMetadata.manifest_path),
        dependencies,
        dependencyNames: [
          ...new Set(dependencies.map((dependency) => dependency.name)),
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
        hasLibraryTarget: (packageMetadata.targets ?? []).some(
          (target) =>
            Array.isArray(target.kind) &&
            target.kind.some(
              (kind) =>
                typeof kind === "string" &&
                (kind === "lib" ||
                  kind === "proc-macro" ||
                  kind.endsWith("lib")),
            ),
        ),
        ...(typeof document.target_directory === "string"
          ? { targetDirectory: normalizePath(document.target_directory) }
          : {}),
        workspaceDirectory,
      } satisfies CargoWorkspacePackageMetadata,
    ];
  });
  const packageMetadata = packages.find(
    (entry) => entry.manifestPath === normalizePath(manifestPath),
  );
  if (packageMetadata === undefined) {
    return undefined;
  }
  const { manifestPath: _manifestPath, ...metadata } = packageMetadata;
  return metadata;
};

const parseCargoWorkspaceMetadata = (
  source: string,
): CargoWorkspaceMetadata => {
  const document = JSON.parse(source) as {
    readonly workspace_root?: unknown;
    readonly workspace_members?: ReadonlyArray<unknown>;
    readonly packages?: ReadonlyArray<{
      readonly id?: unknown;
      readonly manifest_path?: unknown;
    }>;
  };
  if (typeof document.workspace_root !== "string") {
    throw new TypeError("cargo metadata is missing workspace_root");
  }
  const directory = normalizePath(document.workspace_root);
  const packages = (document.packages ?? []).flatMap((entry) => {
    if (typeof entry.manifest_path !== "string") return [];
    const metadata = parseCargoMetadata(source, entry.manifest_path);
    return metadata === undefined
      ? []
      : [
          {
            ...metadata,
            manifestPath: normalizePath(entry.manifest_path),
          } satisfies CargoWorkspacePackageMetadata,
        ];
  });
  return { directory, packages };
};

const cargoWorkspaceMetadata = (
  manifestPath: string,
): Effect.Effect<CargoWorkspaceMetadata, RepositoryError, ProcessService> =>
  Effect.gen(function* () {
    const processService = yield* ProcessService;
    const result = yield* Effect.scoped(
      processService.run({
        command: "cargo",
        args: [
          "metadata",
          "--format-version=1",
          "--no-deps",
          "--locked",
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
      return parseCargoWorkspaceMetadata(result.stdout);
    } catch (cause) {
      return yield* Effect.fail(
        new RepositoryError({ path: manifestPath, message: String(cause) }),
      );
    }
  });

interface PythonProjectMetadata {
  readonly name?: string;
  readonly dependencyNames: ReadonlyArray<string>;
  readonly dependencySources: ReadonlyMap<
    string,
    ReadonlyArray<PythonDependencySource>
  >;
  readonly workspace?: {
    readonly members: ReadonlyArray<string>;
    readonly exclude: ReadonlyArray<string>;
  };
}

interface PythonDependencySource {
  readonly workspace: boolean;
  readonly path?: string;
}

const recordValue = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const cargoConfigurationBuildTargetConfigured = (
  configurationDirectory: string,
): Effect.Effect<boolean, RepositoryError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const legacyPath = joinPath(configurationDirectory, "config");
    const modernPath = joinPath(configurationDirectory, "config.toml");
    const legacyExists = yield* fileSystem
      .exists(legacyPath)
      .pipe(
        Effect.mapError(
          (error) =>
            new RepositoryError({ path: legacyPath, message: error.message }),
        ),
      );
    const modernExists = legacyExists
      ? false
      : yield* fileSystem.exists(modernPath).pipe(
          Effect.mapError(
            (error) =>
              new RepositoryError({
                path: modernPath,
                message: error.message,
              }),
          ),
        );
    const path = legacyExists
      ? legacyPath
      : modernExists
        ? modernPath
        : undefined;
    if (path === undefined) return false;
    const source = yield* fileSystem
      .readText(path)
      .pipe(
        Effect.mapError(
          (error) => new RepositoryError({ path, message: error.message }),
        ),
      );
    try {
      const document = recordValue(parseToml(source));
      return recordValue(document?.build)?.target !== undefined;
    } catch (cause) {
      return yield* Effect.fail(
        new RepositoryError({ path, message: String(cause) }),
      );
    }
  });

const cargoBuildTargetConfigured = (
  directory: string,
): Effect.Effect<boolean, RepositoryError, FileSystemService> =>
  Effect.gen(function* () {
    let current = normalizePath(directory);
    while (true) {
      if (
        yield* cargoConfigurationBuildTargetConfigured(
          joinPath(current, ".cargo"),
        )
      ) {
        return true;
      }
      const parent = parentPath(current);
      if (parent === current) return false;
      current = parent;
    }
  });

const configuredEnvironmentValue = (
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

export const cargoHomeBuildTargetConfigured = (
  executionDirectory: string,
  environment: Readonly<Record<string, string | undefined>>,
  caseInsensitiveEnvironmentNames: boolean,
): Effect.Effect<boolean, RepositoryError, FileSystemService> => {
  const configuredCargoHome = configuredEnvironmentValue(
    environment,
    "CARGO_HOME",
    caseInsensitiveEnvironmentNames,
  );
  const home = configuredEnvironmentValue(
    environment,
    "HOME",
    caseInsensitiveEnvironmentNames,
  );
  const userHome = caseInsensitiveEnvironmentNames
    ? (configuredEnvironmentValue(environment, "USERPROFILE", true) ?? home)
    : home;
  const cargoHome =
    configuredCargoHome ??
    (userHome === undefined ? undefined : joinPath(userHome, ".cargo"));
  if (cargoHome === undefined || cargoHome === "") {
    return Effect.succeed(false);
  }
  const resolvedCargoHome = isAbsolutePath(cargoHome)
    ? normalizePath(cargoHome)
    : joinPath(executionDirectory, cargoHome);
  return cargoConfigurationBuildTargetConfigured(resolvedCargoHome);
};

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
  const sources = recordValue(uv?.sources);
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
  const dependencySources = new Map<
    string,
    ReadonlyArray<PythonDependencySource>
  >();
  for (const [name, source] of Object.entries(sources ?? {})) {
    const declarations = (Array.isArray(source) ? source : [source])
      .map(recordValue)
      .filter(
        (entry): entry is Readonly<Record<string, unknown>> =>
          entry !== undefined,
      )
      .map((entry) => ({
        workspace: entry.workspace === true,
        ...(typeof entry.path === "string" ? { path: entry.path } : {}),
      }));
    dependencySources.set(normalizePythonPackageName(name), declarations);
  }
  return {
    name: typeof project?.name === "string" ? project.name : undefined,
    dependencyNames: [...names].sort(),
    dependencySources,
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
  excludedTasks: ReadonlySet<string>,
): Readonly<Record<string, Pipeline>> => {
  const buildDefaults: Pipeline = { cache: false };
  const tasks: Record<string, Pipeline> = { ...configured };
  if (!excludedTasks.has("build")) {
    tasks.build = mergePipeline(buildDefaults, configured.build ?? {});
  }
  const qualifiedBuild = `${packageName}#build`;
  if (!excludedTasks.has("build") && configured[qualifiedBuild] !== undefined) {
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
  excludedTasks: ReadonlySet<string>,
  configuredBuildTarget: boolean,
  hasCollidingBuildOutput: boolean,
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
    metadata?.hasLibraryTarget === true || outputs.length === 0
      ? { cache: false }
      : { outputs };
  const executionDefaults: Pipeline = { cache: false };
  const formatDefaults: Pipeline = { cache: false };
  const buildTask = (configuredTask: Pipeline): Pipeline => {
    const merged = mergePipeline(buildDefaults, configuredTask);
    return configuredBuildTarget || hasCollidingBuildOutput
      ? { ...merged, cache: false }
      : merged;
  };
  const tasks: Record<string, Pipeline> = { ...configured };
  if (!excludedTasks.has("build")) {
    tasks.build = buildTask(configured.build ?? {});
  }
  if (!excludedTasks.has("format")) {
    tasks.format = mergePipeline(formatDefaults, configured.format ?? {});
  }
  if (metadata?.entrypointNames.length === 1) {
    for (const task of ["dev", "run"] as const) {
      if (!excludedTasks.has(task)) {
        tasks[task] = mergePipeline(executionDefaults, configured[task] ?? {});
      }
      const qualifiedTask = `${packageName}#${task}`;
      if (!excludedTasks.has(task) && configured[qualifiedTask] !== undefined) {
        tasks[qualifiedTask] = mergePipeline(
          executionDefaults,
          configured[qualifiedTask],
        );
      }
    }
  }
  const qualifiedBuild = `${packageName}#build`;
  if (!excludedTasks.has("build") && configured[qualifiedBuild] !== undefined) {
    tasks[qualifiedBuild] = buildTask(configured[qualifiedBuild]);
  }
  const qualifiedFormat = `${packageName}#format`;
  if (
    !excludedTasks.has("format") &&
    configured[qualifiedFormat] !== undefined
  ) {
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
    const fileSystem = yield* FileSystemService;
    const canonicalRepositoryRoot = yield* fileSystem.realPath(root).pipe(
      Effect.map(normalizePath),
      Effect.mapError(
        (error) => new RepositoryError({ path: root, message: error.message }),
      ),
    );
    const canonicalRelativeDirectory = (directory: string) =>
      fileSystem.realPath(directory).pipe(
        Effect.map((resolved) =>
          relativePath(canonicalRepositoryRoot, normalizePath(resolved)),
        ),
        Effect.mapError(
          (error) =>
            new RepositoryError({ path: directory, message: error.message }),
        ),
      );
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
    const patterns = yield* workspacePatterns(
      root,
      managerIdentity.name,
      rootManifest,
    );
    const workspaceDirectories = yield* walkDirectories(root, patterns);
    const candidateDirectoryPaths = new Set(
      selectByGlobs(
        workspaceDirectories
          .map((directory) => relativePath(root, directory))
          .filter((relative) => relative !== "."),
        patterns,
      ),
    );
    const candidateDirectories = workspaceDirectories.filter((directory) =>
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
          const packageConfiguration = yield* loadPackageConfiguration(
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
            canonicalRelativeDirectory:
              yield* canonicalRelativeDirectory(directory),
            cachePathRestorable: yield* cachePathIsRestorable(root, directory),
            manager: managerIdentity.name,
            scripts: manifest.scripts ?? {},
            cargoDependencies:
              [] satisfies ReadonlyArray<CargoDependencyMetadata>,
            dependencyNames: dependencyNames(manifest),
            excludedTasks: packageConfiguration.excludedTasks,
            tasks: packageConfiguration.tasks,
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
    const directories =
      cargoEnabled || pythonEnabled
        ? yield* walkDirectories(root, ["**"])
        : workspaceDirectories;
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
    const configuredTasks = (rootConfiguration.value.tasks ?? {}) as Readonly<
      Record<string, Pipeline>
    >;
    const polyglotDirectories = directories.filter(
      (directory) => !javascriptDirectories.has(directory),
    );
    const cargoManifestPaths = cargoEnabled
      ? (yield* Effect.forEach(
          polyglotDirectories,
          (directory) =>
            Effect.gen(function* () {
              const fileSystem = yield* FileSystemService;
              const path = joinPath(directory, "Cargo.toml");
              const exists = yield* fileSystem
                .exists(path)
                .pipe(
                  Effect.mapError(
                    (error) =>
                      new RepositoryError({ path, message: error.message }),
                  ),
                );
              return exists ? path : undefined;
            }),
          { concurrency: 1 },
        )).filter((path): path is string => path !== undefined)
      : [];
    const canonicalPath = (path: string) =>
      fileSystem.realPath(path).pipe(
        Effect.map(normalizePath),
        Effect.mapError(
          (error) => new RepositoryError({ path, message: error.message }),
        ),
      );
    const canonicalRoot = canonicalRepositoryRoot;
    const cargoManifestPathsByIdentity = new Map(
      yield* Effect.forEach(
        cargoManifestPaths,
        (path) =>
          canonicalPath(path).pipe(
            Effect.map(
              (canonical) =>
                [comparableFilesystemPath(canonical), path] as const,
            ),
          ),
        { concurrency: 8 },
      ),
    );
    const cargoPackages = new Map<string, CargoWorkspacePackageMetadata>();
    const claimedCargoWorkspaceDirectories: Array<string> = [];
    for (const manifestPath of cargoManifestPaths) {
      const canonicalManifestPath = yield* canonicalPath(manifestPath);
      if (
        claimedCargoWorkspaceDirectories.some((directory) =>
          isPathContained(directory, parentPath(canonicalManifestPath)),
        )
      ) {
        continue;
      }
      const metadata = yield* cargoWorkspaceMetadata(manifestPath);
      const canonicalWorkspaceDirectory = yield* canonicalPath(
        metadata.directory,
      );
      claimedCargoWorkspaceDirectories.push(canonicalWorkspaceDirectory);
      for (const packageMetadata of metadata.packages) {
        const canonicalPackageManifestPath = yield* canonicalPath(
          packageMetadata.manifestPath,
        );
        const repositoryManifestPath = cargoManifestPathsByIdentity.get(
          comparableFilesystemPath(canonicalPackageManifestPath),
        );
        if (repositoryManifestPath === undefined) continue;
        const canonicalPackageWorkspaceDirectory = yield* canonicalPath(
          packageMetadata.workspaceDirectory ?? metadata.directory,
        );
        const workspaceDirectory = repositoryPathFromCanonical(
          root,
          canonicalRoot,
          canonicalPackageWorkspaceDirectory,
        );
        const dependencies = packageMetadata.dependencies.map((dependency) => ({
          ...dependency,
          ...(dependency.path === undefined
            ? {}
            : {
                path:
                  repositoryPathFromCanonical(
                    root,
                    canonicalRoot,
                    dependency.path,
                  ) ?? normalizePath(dependency.path),
              }),
        }));
        const targetDirectory =
          packageMetadata.targetDirectory === undefined
            ? undefined
            : (repositoryPathFromCanonical(
                root,
                canonicalRoot,
                packageMetadata.targetDirectory,
              ) ?? normalizePath(packageMetadata.targetDirectory));
        const {
          dependencies: _dependencies,
          manifestPath: _manifestPath,
          targetDirectory: _targetDirectory,
          workspaceDirectory: _workspaceDirectory,
          ...rest
        } = packageMetadata;
        cargoPackages.set(repositoryManifestPath, {
          ...rest,
          dependencies,
          manifestPath: repositoryManifestPath,
          ...(targetDirectory === undefined ? {} : { targetDirectory }),
          ...(workspaceDirectory === undefined ? {} : { workspaceDirectory }),
        });
      }
    }
    const cargoBuildOutputOwners = new Map<string, Set<string>>();
    for (const metadata of cargoPackages.values()) {
      if (
        metadata.targetDirectory === undefined ||
        !isPathContained(root, metadata.targetDirectory)
      ) {
        continue;
      }
      for (const entrypointName of metadata.entrypointNames) {
        const output = comparableFilesystemPath(
          joinPath(metadata.targetDirectory, "debug", entrypointName),
        );
        const owners = cargoBuildOutputOwners.get(output) ?? new Set<string>();
        owners.add(metadata.manifestPath);
        cargoBuildOutputOwners.set(output, owners);
      }
    }
    const cargoManifestsWithCollidingBuildOutputs = new Set(
      [...cargoBuildOutputOwners.values()]
        .filter((owners) => owners.size > 1)
        .flatMap((owners) => [...owners]),
    );
    const cargoDrafts: ReadonlyArray<RepositoryPackageDraft> =
      yield* Effect.forEach(
        [...cargoPackages.values()].sort((left, right) =>
          left.manifestPath.localeCompare(right.manifestPath),
        ),
        (metadata) =>
          Effect.gen(function* () {
            const directory = parentPath(metadata.manifestPath);
            const configuredBuildTarget =
              yield* cargoBuildTargetConfigured(directory);
            const packageConfiguration =
              directory === root
                ? {
                    excludedTasks: new Set<string>(),
                    tasks: configuredTasks,
                  }
                : yield* loadPackageConfiguration(
                    directory,
                    metadata.name,
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
              name: metadata.name,
              directory,
              relativeDirectory: relativePath(root, directory),
              canonicalRelativeDirectory:
                yield* canonicalRelativeDirectory(directory),
              cachePathRestorable: yield* cachePathIsRestorable(
                root,
                directory,
              ),
              workspaceDirectory: metadata.workspaceDirectory,
              manager: "cargo" as const,
              scripts: polyglotScripts("cargo", metadata.entrypointNames),
              cargoDependencies: metadata.dependencies,
              dependencyNames: metadata.dependencyNames,
              excludedTasks: packageConfiguration.excludedTasks,
              tasks: cargoTasks(
                root,
                metadata.name,
                metadata,
                packageConfiguration.tasks,
                packageConfiguration.excludedTasks,
                configuredBuildTarget,
                cargoManifestsWithCollidingBuildOutputs.has(
                  metadata.manifestPath,
                ),
              ),
              manifest: {
                name: metadata.name,
                private: true,
              } satisfies PackageManifest,
            };
          }),
        { concurrency: 8 },
      );
    const uvDrafts = yield* Effect.forEach(
      polyglotDirectories.filter((directory) =>
        pythonWorkspaceDirectories.has(directory),
      ),
      (directory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystemService;
          const path = joinPath(directory, "pyproject.toml");
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
            return undefined;
          }
          const source = yield* fileSystem
            .readText(path)
            .pipe(
              Effect.mapError(
                (error) =>
                  new RepositoryError({ path, message: error.message }),
              ),
            );
          let metadata: PythonProjectMetadata;
          try {
            metadata = parsePythonProjectMetadata(source);
          } catch (cause) {
            return yield* Effect.fail(
              new RepositoryError({ path, message: String(cause) }),
            );
          }
          if (metadata.name === undefined) {
            return undefined;
          }
          const packageConfiguration =
            directory === root
              ? {
                  excludedTasks: new Set<string>(),
                  tasks: configuredTasks,
                }
              : yield* loadPackageConfiguration(
                  directory,
                  metadata.name,
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
            name: metadata.name,
            directory,
            relativeDirectory: relativePath(root, directory),
            canonicalRelativeDirectory:
              yield* canonicalRelativeDirectory(directory),
            cachePathRestorable: yield* cachePathIsRestorable(root, directory),
            manager: "uv" as const,
            scripts: polyglotScripts("uv", []),
            cargoDependencies:
              [] satisfies ReadonlyArray<CargoDependencyMetadata>,
            dependencyNames: metadata.dependencyNames,
            excludedTasks: packageConfiguration.excludedTasks,
            uvDependencySources: metadata.dependencySources,
            tasks: uvTasks(
              metadata.name,
              packageConfiguration.tasks,
              packageConfiguration.excludedTasks,
            ),
            manifest: {
              name: metadata.name,
              private: true,
            } satisfies PackageManifest,
          };
        }),
      { concurrency: 1 },
    );
    const drafts: ReadonlyArray<RepositoryPackageDraft> = [
      ...javascriptDrafts,
      ...cargoDrafts,
      ...uvDrafts.filter(
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
    const javascriptDraftsByName = new Map(
      javascriptDrafts.map(
        (packageDraft) => [packageDraft.name, packageDraft] as const,
      ),
    );
    const javascriptInternalDependenciesByDirectory = new Map(
      yield* Effect.forEach(
        [
          ...javascriptDrafts.map(({ directory, manifest }) => ({
            directory,
            manifest,
          })),
          { directory: root, manifest: rootManifest },
        ],
        ({ directory, manifest }) =>
          javascriptInternalDependencies(
            directory,
            manifest,
            managerIdentity.name,
            javascriptDraftsByName,
          ).pipe(
            Effect.map(
              (internalDependencies) =>
                [normalizePath(directory), internalDependencies] as const,
            ),
          ),
        { concurrency: 8 },
      ),
    );
    const cargoDraftsByDirectory = new Map(
      drafts
        .filter((packageDraft) => packageDraft.manager === "cargo")
        .map(
          (packageDraft) =>
            [normalizePath(packageDraft.directory), packageDraft] as const,
        ),
    );
    const uvFilesystemIdentitiesByName = new Map(
      yield* Effect.forEach(
        drafts.filter((packageDraft) => packageDraft.manager === "uv"),
        (packageDraft) =>
          canonicalFilesystemIdentity(packageDraft.directory).pipe(
            Effect.map((identity) => [packageDraft.name, identity] as const),
          ),
        { concurrency: 8 },
      ),
    );
    const uvInternalDependenciesByName = new Map(
      yield* Effect.forEach(
        drafts.filter((packageDraft) => packageDraft.manager === "uv"),
        (packageDraft) =>
          Effect.forEach(
            packageDraft.dependencyNames,
            (name) =>
              Effect.gen(function* () {
                const resolved = uvNames.get(normalizePythonPackageName(name));
                const target =
                  resolved === undefined
                    ? undefined
                    : draftsByName.get(resolved);
                if (target === undefined || target.manager !== "uv") {
                  return undefined;
                }
                const sources =
                  packageDraft.uvDependencySources?.get(
                    normalizePythonPackageName(name),
                  ) ?? [];
                if (sources.some((source) => source.workspace)) {
                  return target.name;
                }
                const targetIdentity = uvFilesystemIdentitiesByName.get(
                  target.name,
                );
                if (targetIdentity === undefined) {
                  return undefined;
                }
                const sourceIdentities = yield* Effect.forEach(
                  sources.flatMap((source) =>
                    source.path === undefined ? [] : [source.path],
                  ),
                  (path) =>
                    canonicalFilesystemIdentity(
                      joinPath(packageDraft.directory, path),
                    ),
                  { concurrency: 8 },
                );
                return sourceIdentities.includes(targetIdentity)
                  ? target.name
                  : undefined;
              }),
            { concurrency: 8 },
          ).pipe(
            Effect.map(
              (internalDependencies) =>
                [
                  packageDraft.name,
                  internalDependencies.filter(
                    (name): name is string => name !== undefined,
                  ),
                ] as const,
            ),
          ),
        { concurrency: 8 },
      ),
    );
    const packages: ReadonlyArray<RepositoryPackage> = drafts
      .map(({ cargoDependencies, ...packageDraft }) => ({
        ...packageDraft,
        internalDependencies:
          packageDraft.manager === "uv"
            ? (uvInternalDependenciesByName.get(packageDraft.name) ?? [])
            : packageDraft.manager === "cargo"
              ? cargoDependencies.flatMap((dependency) => {
                  if (
                    dependency.source !== undefined ||
                    dependency.path === undefined
                  ) {
                    return [];
                  }
                  const target = cargoDraftsByDirectory.get(dependency.path);
                  return target !== undefined &&
                    target.name === dependency.name &&
                    packageDraft.workspaceDirectory !== undefined &&
                    target.workspaceDirectory ===
                      packageDraft.workspaceDirectory
                    ? [target.name]
                    : [];
                })
              : (javascriptInternalDependenciesByDirectory.get(
                  normalizePath(packageDraft.directory),
                ) ?? []),
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
      canonicalRelativeDirectory: ".",
      cachePathRestorable: true,
      manager: managerIdentity.name,
      scripts: rootManifest.scripts ?? {},
      dependencyNames: dependencyNames(rootManifest),
      internalDependencies:
        javascriptInternalDependenciesByDirectory.get(normalizePath(root)) ??
        [],
      excludedTasks: new Set<string>(),
      tasks: rootTasks,
      manifest: rootManifest,
    };
    const lockfile = yield* findLockfile(root, managerIdentity.name);
    return {
      root,
      manager: managerIdentity.name,
      managerVersion: managerIdentity.version,
      rootManifest,
      rootConfiguration,
      rootPackage,
      lockfile,
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
    readonly includeDirectories?: boolean;
    readonly shouldTraverseDirectory?: (relativeDirectory: string) => boolean;
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
        if (entry.kind === "directory") {
          const path = joinPath(current, entry.name);
          if (
            (options.ignoredDirectories ?? fileTraversalIgnoredDirectories).has(
              entry.name,
            ) ||
            options.shouldTraverseDirectory?.(relativePath(directory, path)) ===
              false
          ) {
            continue;
          }
          if (options.includeDirectories === true) {
            files.push(path);
          }
          pending.push(path);
        } else if (entry.kind === "file" || entry.kind === "symlink") {
          files.push(joinPath(current, entry.name));
        }
      }
    }
    return files.sort();
  });
