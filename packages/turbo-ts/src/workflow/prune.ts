import { Effect } from "effect";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseJsonConfiguration } from "../config/runtime.js";
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
import { ConfigurationError } from "../effect/errors.js";
import {
  EnvironmentService,
  FileSystemService,
  ProcessService,
  TerminalService,
} from "../effect/services.js";
import {
  type GitIgnoreMatcher,
  loadGitIgnoreMatcher,
} from "../repository/git-ignore.js";
import { pruneLockfile } from "../repository/lockfiles.js";
import {
  listRepositoryFiles,
  type RepositoryModel,
  type RepositoryPackage,
} from "../repository/model.js";
import { loadWorkflowRepository } from "./repository.js";

export interface PruneOptions {
  readonly scopes: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly outputDirectory: string;
  readonly docker: boolean;
  readonly production: boolean;
  readonly useGitignore: boolean;
}

export const parsePruneArguments = (
  arguments_: ReadonlyArray<string>,
): PruneOptions => {
  const scopes: Array<string> = [];
  let cwd: string | undefined;
  let outputDirectory = "out";
  let docker = false;
  let production = false;
  let useGitignore = true;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    const takeValue = (): string => {
      const equals = argument.indexOf("=");
      if (equals !== -1) return argument.slice(equals + 1);
      const value = arguments_[++index];
      if (value === undefined || value.startsWith("-")) {
        throw new ConfigurationError({
          path: "<arguments>",
          message: `${argument} requires a value`,
        });
      }
      return value;
    };
    if (!argument.startsWith("-")) {
      scopes.push(argument);
      continue;
    }
    switch (argument.split("=", 1)[0]) {
      case "--cwd":
        cwd = takeValue();
        break;
      case "--out-dir":
        outputDirectory = takeValue();
        break;
      case "--docker":
        docker = true;
        break;
      case "--production":
        production = true;
        break;
      case "--use-gitignore":
        useGitignore = !argument.endsWith("=false");
        break;
      case "--no-color":
      case "--no-update-notifier":
        break;
      default:
        throw new ConfigurationError({
          path: "<arguments>",
          message: `unknown option: ${argument}`,
        });
    }
  }
  if (scopes.length === 0) {
    throw new ConfigurationError({
      path: "<arguments>",
      message: "at least one package scope is required",
    });
  }
  return {
    scopes,
    cwd,
    outputDirectory,
    docker,
    production,
    useGitignore,
  };
};

const selectedPackages = (
  repository: RepositoryModel,
  scopes: ReadonlyArray<string>,
  production: boolean,
): ReadonlyArray<RepositoryPackage> => {
  const selected = new Map<string, RepositoryPackage>();
  const pending = scopes.flatMap((scope) => {
    const identityMatch = repository.packages.find(
      (candidate) => candidate.identity === scope,
    );
    const matches =
      identityMatch === undefined
        ? repository.packages.filter((candidate) => candidate.name === scope)
        : [identityMatch];
    if (matches.length === 0) {
      throw new ConfigurationError({
        path: "<arguments>",
        message: `package not found: ${scope}`,
      });
    }
    return matches;
  });
  const dependenciesOf = (packageModel: RepositoryPackage) =>
    production
      ? packageModel.productionInternalDependencies
      : packageModel.internalDependencies;
  for (const dependency of dependenciesOf(repository.rootPackage)) {
    const dependencyPackage = repository.packagesByIdentity.get(dependency);
    if (dependencyPackage !== undefined) pending.push(dependencyPackage);
  }
  while (pending.length > 0) {
    const packageModel = pending.pop()!;
    if (selected.has(packageModel.identity)) continue;
    selected.set(packageModel.identity, packageModel);
    for (const dependency of dependenciesOf(packageModel)) {
      const dependencyPackage = repository.packagesByIdentity.get(dependency);
      if (dependencyPackage !== undefined) pending.push(dependencyPackage);
    }
  }
  return [...selected.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
};

const ignoredDirectoryNames = new Set([
  ".git",
  ".turbo",
  ".venv",
  "node_modules",
]);

const copyTree = (
  source: string,
  destination: string,
  excludedRoot: string,
  allowedSymlinkRoots: ReadonlyArray<string>,
  ignoreMatcher?: GitIgnoreMatcher,
  excludedSourceRoots: ReadonlySet<string> = new Set(),
): Effect.Effect<void, unknown, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    if (isPathContained(excludedRoot, source)) return;
    if (excludedSourceRoots.has(normalizePath(source))) return;
    const sourceMetadata = yield* fileSystem.metadata(source);
    if (sourceMetadata.kind !== "directory") {
      return yield* Effect.fail(
        new ConfigurationError({
          path: source,
          message: "prune source must be a real directory",
        }),
      );
    }
    const entries = yield* fileSystem.list(source);
    yield* fileSystem.makeDirectory(destination);
    for (const entry of entries) {
      if (entry.kind === "directory" && ignoredDirectoryNames.has(entry.name)) {
        continue;
      }
      const sourcePath = joinPath(source, entry.name);
      const destinationPath = joinPath(destination, entry.name);
      if (excludedSourceRoots.has(normalizePath(sourcePath))) continue;
      if (ignoreMatcher?.ignores(sourcePath, entry.kind === "directory")) {
        continue;
      }
      if (entry.kind === "directory") {
        yield* copyTree(
          sourcePath,
          destinationPath,
          excludedRoot,
          allowedSymlinkRoots,
          ignoreMatcher,
          excludedSourceRoots,
        );
      } else if (entry.kind === "file") {
        yield* fileSystem.copyFile(sourcePath, destinationPath);
      } else if (entry.kind === "symlink") {
        const target = yield* fileSystem.readLink(sourcePath);
        const resolved = yield* fileSystem.realPath(sourcePath).pipe(
          Effect.mapError(
            (error) =>
              new ConfigurationError({
                path: sourcePath,
                message: `cannot resolve prune symlink: ${error.message}`,
              }),
          ),
        );
        if (
          isAbsolutePath(target) ||
          isPathContained(excludedRoot, resolved) ||
          [...excludedSourceRoots].some((root) =>
            isPathContained(root, resolved),
          ) ||
          !allowedSymlinkRoots.some((root) => isPathContained(root, resolved))
        ) {
          return yield* Effect.fail(
            new ConfigurationError({
              path: sourcePath,
              message:
                "prune symlink must use a relative target inside the selected package closure",
            }),
          );
        }
        yield* fileSystem.createSymlink(target, destinationPath);
      }
    }
  });

const canonicalOutputPath = (
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
            message: "unable to resolve prune output ancestry",
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

const copyIfPresent = (
  source: string,
  destination: string,
  repositoryRoot: string,
  excludedRoot: string,
  destinationRoot = parentPath(destination),
): Effect.Effect<void, unknown, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    if (!(yield* fileSystem.exists(source))) return;
    const metadata = yield* fileSystem.metadata(source);
    if (metadata.kind === "file") {
      yield* fileSystem.copyFile(source, destination);
      return;
    }
    if (metadata.kind === "symlink") {
      const target = yield* fileSystem.readLink(source);
      const resolved = yield* fileSystem.realPath(source).pipe(
        Effect.mapError(
          (error) =>
            new ConfigurationError({
              path: source,
              message: `cannot resolve prune root control symlink: ${error.message}`,
            }),
        ),
      );
      if (
        isAbsolutePath(target) ||
        isPathContained(excludedRoot, resolved) ||
        !isPathContained(repositoryRoot, resolved)
      ) {
        return yield* Effect.fail(
          new ConfigurationError({
            path: source,
            message:
              "prune root control symlink must use a relative target inside the repository",
          }),
        );
      }
      const targetMetadata = yield* fileSystem.metadata(resolved);
      if (targetMetadata.kind !== "file") {
        return yield* Effect.fail(
          new ConfigurationError({
            path: source,
            message: "prune root control symlink must target a regular file",
          }),
        );
      }
      const destinationTarget = joinPath(
        destinationRoot,
        relativePath(repositoryRoot, resolved),
      );
      yield* fileSystem.copyFile(resolved, destinationTarget);
      yield* fileSystem.createSymlink(
        relativePath(parentPath(destination), destinationTarget),
        destination,
      );
      return;
    }
    return yield* Effect.fail(
      new ConfigurationError({
        path: source,
        message: "prune root control must be a regular file or symlink",
      }),
    );
  });

const copyGlobalDependencyFiles = (
  repository: RepositoryModel,
  destinationRoot: string,
  excludedRoot: string,
  ignoreMatcher?: GitIgnoreMatcher,
): Effect.Effect<void, unknown, FileSystemService> =>
  Effect.gen(function* () {
    if (
      repository.rootConfiguration.value.futureFlags
        ?.pruneIncludesGlobalFiles !== true
    ) {
      return;
    }
    const patterns =
      repository.rootConfiguration.value.futureFlags?.globalConfiguration ===
      true
        ? (repository.rootConfiguration.value.global?.inputs ?? [])
        : (repository.rootConfiguration.value.globalDependencies ?? []);
    const positivePatterns = patterns.filter(
      (pattern) => !pattern.startsWith("!"),
    );
    if (positivePatterns.length === 0) return;
    const paths = yield* listRepositoryFiles(repository.root, {
      shouldTraverseDirectory: (relativeDirectory) =>
        positivePatterns.some((pattern) =>
          canMatchGlobDescendant(relativeDirectory, pattern),
        ),
    });
    const selected = selectByGlobs(
      paths.map((path) => relativePath(repository.root, path)),
      patterns,
    );
    for (const relative of selected) {
      const source = joinPath(repository.root, relative);
      if (ignoreMatcher?.ignores(source)) continue;
      yield* copyIfPresent(
        source,
        joinPath(destinationRoot, relative),
        repository.root,
        excludedRoot,
        destinationRoot,
      );
    }
  });

const writeManifest = (
  source: string,
  destination: string,
  production: boolean,
): Effect.Effect<void, unknown, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    if (!production) {
      yield* fileSystem.copyFile(source, destination);
      return;
    }
    const manifest = JSON.parse(yield* fileSystem.readText(source)) as Record<
      string,
      unknown
    >;
    delete manifest.devDependencies;
    yield* fileSystem.writeTextAtomic(
      destination,
      `${JSON.stringify(manifest, undefined, 2)}\n`,
      0o644,
    );
  });

const writeRootConfiguration = (
  source: string,
  destination: string,
): Effect.Effect<void, unknown, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    if (!(yield* fileSystem.exists(source))) return;
    const document = parseJsonConfiguration(
      yield* fileSystem.readText(source),
      source,
    );
    // The reference serializes the pruned root configuration without a final
    // newline while package-local configuration files remain byte copies.
    yield* fileSystem.writeTextAtomic(
      destination,
      JSON.stringify(document, undefined, 2),
      0o644,
    );
  });

const writeWorkspaceConfiguration = (
  source: string,
  destination: string,
): Effect.Effect<void, unknown, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    if (!(yield* fileSystem.exists(source))) return;
    const document = parseYaml(yield* fileSystem.readText(source)) as unknown;
    yield* fileSystem.writeTextAtomic(
      destination,
      stringifyYaml(document, {
        indentSeq: false,
        lineWidth: 0,
        singleQuote: true,
      }),
      0o644,
    );
  });

export const executePrune = (
  options: PruneOptions,
): Effect.Effect<
  number,
  unknown,
  EnvironmentService | FileSystemService | ProcessService | TerminalService
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const terminal = yield* TerminalService;
    const repository = yield* loadWorkflowRepository(options);
    const packages = selectedPackages(
      repository,
      options.scopes,
      options.production,
    );
    for (const packageModel of packages) {
      const metadata = yield* fileSystem.metadata(packageModel.directory);
      if (
        metadata.kind !== "directory" ||
        packageModel.relativeDirectory !==
          packageModel.canonicalRelativeDirectory
      ) {
        return yield* Effect.fail(
          new ConfigurationError({
            path: packageModel.directory,
            message: `cannot prune symlinked workspace ${packageModel.name}`,
          }),
        );
      }
    }
    if (repository.lockfile === undefined) {
      return yield* Effect.fail(
        new ConfigurationError({
          path: repository.root,
          message: "Cannot prune without parsed lockfile.",
        }),
      );
    }
    const outputRoot = normalizePath(
      isAbsolutePath(options.outputDirectory)
        ? options.outputDirectory
        : joinPath(repository.root, options.outputDirectory),
    );
    const canonicalOutputRoot = yield* canonicalOutputPath(outputRoot);
    const ignoreMatcher = options.useGitignore
      ? yield* loadGitIgnoreMatcher(repository.root)
      : undefined;
    if (
      canonicalOutputRoot === normalizePath(repository.root) ||
      isPathContained(canonicalOutputRoot, repository.root)
    ) {
      return yield* Effect.fail(
        new ConfigurationError({
          path: outputRoot,
          message: "prune output must not contain the repository root",
        }),
      );
    }
    const protectedWorkspaceRoots = yield* Effect.forEach(
      [
        ...new Set(
          packages.flatMap((packageModel) => [
            packageModel.directory,
            packageModel.workspaceDirectory ?? packageModel.directory,
          ]),
        ),
      ],
      canonicalOutputPath,
    );
    if (
      protectedWorkspaceRoots.some((sourceRoot) =>
        isPathContained(canonicalOutputRoot, sourceRoot),
      )
    ) {
      return yield* Effect.fail(
        new ConfigurationError({
          path: outputRoot,
          message:
            "prune output must not contain a selected package or workspace control directory",
        }),
      );
    }
    if (yield* fileSystem.exists(outputRoot)) {
      const outputMetadata = yield* fileSystem.metadata(outputRoot);
      if (outputMetadata.kind === "symlink") {
        return yield* Effect.fail(
          new ConfigurationError({
            path: outputRoot,
            message: "prune output must not be a symlink",
          }),
        );
      }
    }
    yield* fileSystem.remove(outputRoot);
    const fullRoot = options.docker ? joinPath(outputRoot, "full") : outputRoot;
    const jsonRoot = options.docker ? joinPath(outputRoot, "json") : outputRoot;
    const installationRoots = options.docker
      ? [fullRoot, jsonRoot]
      : [fullRoot];
    yield* fileSystem.makeDirectory(fullRoot);
    yield* fileSystem.makeDirectory(jsonRoot);
    yield* terminal.writeStdout(
      `Generating pruned monorepo for ${options.scopes.join(", ")} in ${outputRoot}\n`,
    );
    yield* copyGlobalDependencyFiles(
      repository,
      fullRoot,
      canonicalOutputRoot,
      ignoreMatcher,
    );
    const rootFiles = [
      ".gitignore",
      ".npmrc",
      ".pnpmfile.cjs",
      ".pnp.cjs",
      ".yarnrc",
      ".yarnrc.yml",
      "bunfig.toml",
      "package.json",
      "pnpm-workspace.yaml",
      "turbo.json",
      "turbo.jsonc",
    ];
    for (const name of rootFiles) {
      const source = joinPath(repository.root, name);
      if (name === "package.json") {
        yield* writeManifest(
          source,
          joinPath(fullRoot, name),
          options.production,
        );
        if (options.docker) {
          yield* writeManifest(
            source,
            joinPath(jsonRoot, name),
            options.production,
          );
        }
      } else if (name === "turbo.json" || name === "turbo.jsonc") {
        yield* writeRootConfiguration(source, joinPath(fullRoot, name));
      } else if (name === "pnpm-workspace.yaml") {
        yield* writeWorkspaceConfiguration(source, joinPath(fullRoot, name));
        if (options.docker) {
          yield* writeWorkspaceConfiguration(source, joinPath(jsonRoot, name));
        }
      } else {
        yield* copyIfPresent(
          source,
          joinPath(fullRoot, name),
          repository.root,
          canonicalOutputRoot,
        );
        if (
          options.docker &&
          [
            ".npmrc",
            ".pnpmfile.cjs",
            ".pnp.cjs",
            ".yarnrc",
            ".yarnrc.yml",
            "bunfig.toml",
          ].includes(name)
        ) {
          yield* copyIfPresent(
            source,
            joinPath(jsonRoot, name),
            repository.root,
            canonicalOutputRoot,
          );
        }
      }
    }
    const yarnDirectory = joinPath(repository.root, ".yarn");
    if (yield* fileSystem.exists(yarnDirectory)) {
      const metadata = yield* fileSystem.metadata(yarnDirectory);
      if (metadata.kind !== "directory") {
        return yield* Effect.fail(
          new ConfigurationError({
            path: yarnDirectory,
            message: ".yarn must be a real directory for prune",
          }),
        );
      }
      for (const root of installationRoots) {
        yield* copyTree(
          yarnDirectory,
          joinPath(root, ".yarn"),
          canonicalOutputRoot,
          [yarnDirectory],
          ignoreMatcher,
        );
      }
    }
    const yarnExecutable = repository.packageManagerExecutableInput;
    if (
      yarnExecutable !== undefined &&
      !isPathContained(yarnDirectory, yarnExecutable)
    ) {
      for (const root of installationRoots) {
        yield* copyIfPresent(
          yarnExecutable,
          joinPath(root, relativePath(repository.root, yarnExecutable)),
          repository.root,
          canonicalOutputRoot,
          root,
        );
      }
    }
    const ecosystemWorkspaceControls = new Map<string, ReadonlyArray<string>>();
    for (const packageModel of packages) {
      if (packageModel.manager !== "cargo" && packageModel.manager !== "uv") {
        continue;
      }
      const workspaceDirectory =
        packageModel.workspaceDirectory ?? packageModel.directory;
      const key = `${packageModel.manager}\0${workspaceDirectory}`;
      ecosystemWorkspaceControls.set(
        key,
        packageModel.manager === "cargo"
          ? [
              joinPath(workspaceDirectory, "Cargo.toml"),
              joinPath(workspaceDirectory, "Cargo.lock"),
            ]
          : [
              joinPath(workspaceDirectory, "pyproject.toml"),
              joinPath(workspaceDirectory, "uv.lock"),
            ],
      );
    }
    for (const controls of ecosystemWorkspaceControls.values()) {
      for (const source of controls) {
        yield* copyIfPresent(
          source,
          joinPath(fullRoot, relativePath(repository.root, source)),
          repository.root,
          canonicalOutputRoot,
          fullRoot,
        );
      }
    }
    const selectedPackageRoots = packages.map(
      (packageModel) => packageModel.directory,
    );
    const selectedCanonicalPackageRoots = new Set(
      packages.map((packageModel) =>
        normalizePath(
          joinPath(repository.root, packageModel.canonicalRelativeDirectory),
        ),
      ),
    );
    const excludedPackageRoots = new Set(
      repository.packages.flatMap((packageModel) => {
        const logicalRoot = normalizePath(packageModel.directory);
        const canonicalRoot = normalizePath(
          joinPath(repository.root, packageModel.canonicalRelativeDirectory),
        );
        return selectedCanonicalPackageRoots.has(canonicalRoot)
          ? []
          : [logicalRoot, canonicalRoot];
      }),
    );
    for (const packageModel of packages) {
      yield* copyTree(
        packageModel.directory,
        joinPath(fullRoot, packageModel.relativeDirectory),
        canonicalOutputRoot,
        selectedPackageRoots,
        ignoreMatcher,
        excludedPackageRoots,
      );
      yield* terminal.writeStdout(` - Added ${packageModel.name}\n`);
    }
    for (const packageModel of packages) {
      if (packageModel.manager === "cargo" || packageModel.manager === "uv") {
        continue;
      }
      const sourceManifest = joinPath(packageModel.directory, "package.json");
      if (options.production) {
        yield* writeManifest(
          sourceManifest,
          joinPath(fullRoot, packageModel.relativeDirectory, "package.json"),
          true,
        );
      }
      if (options.docker) {
        yield* writeManifest(
          sourceManifest,
          joinPath(jsonRoot, packageModel.relativeDirectory, "package.json"),
          options.production,
        );
      }
    }
    const lockfileContents = yield* fileSystem.readBytes(repository.lockfile);
    const prunedLockfile = pruneLockfile(
      repository.lockfile,
      lockfileContents,
      new Set(packages.map((packageModel) => packageModel.relativeDirectory)),
      {
        production: options.production,
        manifests: [
          repository.rootManifest,
          ...packages.map((packageModel) => packageModel.manifest),
        ],
      },
    );
    const lockfileName = repository.lockfile.slice(
      repository.lockfile.lastIndexOf("/") + 1,
    );
    yield* fileSystem.writeBytes(
      joinPath(outputRoot, lockfileName),
      prunedLockfile,
    );
    if (options.docker) {
      yield* fileSystem.writeBytes(
        joinPath(jsonRoot, lockfileName),
        prunedLockfile,
      );
    }
    return 0;
  });
