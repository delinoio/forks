import { Effect } from "effect";
import { loadRootConfiguration } from "../config/runtime.js";
import {
  isAbsolutePath,
  joinPath,
  normalizePath,
  relativePath,
} from "../core/path.js";
import { ConfigurationError } from "../effect/errors.js";
import {
  EnvironmentService,
  FileSystemService,
  ProcessService,
} from "../effect/services.js";
import {
  discoverRepository,
  type RepositoryModel,
  type RepositoryPackage,
} from "../repository/model.js";
import { discoverRepositoryRoot } from "../run/engine.js";

export interface WorkflowRepositoryOptions {
  readonly cwd?: string;
  readonly rootTurboJson?: string;
  readonly singlePackage?: boolean;
}

export const resolveWorkflowRepositoryRoot = (
  options: WorkflowRepositoryOptions,
): Effect.Effect<string, unknown, EnvironmentService | FileSystemService> =>
  Effect.gen(function* () {
    const environment = yield* EnvironmentService;
    const fileSystem = yield* FileSystemService;
    const processCwd = yield* environment.cwd;
    const requested =
      options.cwd === undefined
        ? processCwd
        : isAbsolutePath(options.cwd)
          ? options.cwd
          : joinPath(processCwd, options.cwd);
    const exists = yield* fileSystem
      .exists(requested)
      .pipe(
        Effect.mapError(
          (error) =>
            new ConfigurationError({ path: requested, message: error.message }),
        ),
      );
    if (!exists) {
      return yield* Effect.fail(
        new ConfigurationError({
          path: requested,
          message: "working directory does not exist",
        }),
      );
    }
    const canonical = yield* fileSystem
      .realPath(requested)
      .pipe(
        Effect.mapError(
          (error) =>
            new ConfigurationError({ path: requested, message: error.message }),
        ),
      );
    const metadata = yield* fileSystem
      .metadata(canonical)
      .pipe(
        Effect.mapError(
          (error) =>
            new ConfigurationError({ path: requested, message: error.message }),
        ),
      );
    if (metadata.kind !== "directory") {
      return yield* Effect.fail(
        new ConfigurationError({
          path: requested,
          message: "working directory is not a directory",
        }),
      );
    }
    return yield* discoverRepositoryRoot(canonical);
  });

export const loadWorkflowRepository = (
  options: WorkflowRepositoryOptions,
): Effect.Effect<
  RepositoryModel,
  unknown,
  EnvironmentService | FileSystemService | ProcessService
> =>
  Effect.gen(function* () {
    const root = yield* resolveWorkflowRepositoryRoot(options);
    const configuration = yield* loadRootConfiguration(
      root,
      options.rootTurboJson === undefined
        ? undefined
        : isAbsolutePath(options.rootTurboJson)
          ? options.rootTurboJson
          : joinPath(root, options.rootTurboJson),
    );
    return yield* discoverRepository(root, configuration, {
      singlePackage: options.singlePackage,
    });
  });

export const repositoryPackageManagerLabel = (
  repository: Pick<RepositoryModel, "manager">,
): string => (repository.manager === "pnpm" ? "pnpm9" : repository.manager);

export const repositoryGlobalInputPatterns = (
  repository: Pick<RepositoryModel, "rootConfiguration">,
): ReadonlyArray<string> =>
  repository.rootConfiguration.value.futureFlags?.globalConfiguration === true
    ? (repository.rootConfiguration.value.global?.inputs ?? [])
    : (repository.rootConfiguration.value.globalDependencies ?? []);

export const packagesOwningRepositoryPath = (
  packages: ReadonlyArray<RepositoryPackage>,
  path: string,
): ReadonlyArray<RepositoryPackage> => {
  const matches = packages.flatMap((packageModel) =>
    [
      ...new Set(
        [
          packageModel.relativeDirectory,
          packageModel.canonicalRelativeDirectory,
        ].map((directory) => directory.replace(/^\.\/?/, "")),
      ),
    ].flatMap((directory) =>
      directory !== "" &&
      (path === directory || path.startsWith(`${directory}/`))
        ? [{ packageModel, directory }]
        : [],
    ),
  );
  const longestDirectory = Math.max(
    0,
    ...matches.map(({ directory }) => directory.length),
  );
  const ownerIdentities = new Set(
    matches
      .filter(({ directory }) => directory.length === longestDirectory)
      .map(({ packageModel }) => packageModel.identity),
  );
  return packages.filter((packageModel) =>
    ownerIdentities.has(packageModel.identity),
  );
};

export const isInternalRepositoryPath = (
  root: string,
  path: string,
): boolean => {
  const windowsPathSeparators =
    /^[A-Za-z]:[\\/]/.test(root) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(root);
  const normalized = `/${normalizePath(
    relativePath(root, path, windowsPathSeparators),
    windowsPathSeparators,
  )}/`;
  const relative = windowsPathSeparators
    ? normalized.toLowerCase()
    : normalized;
  return ["/.git/", "/.turbo/", "/.venv/", "/node_modules/"].some((component) =>
    relative.includes(component),
  );
};
