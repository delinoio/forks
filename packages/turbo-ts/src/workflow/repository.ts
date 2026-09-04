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
} from "../repository/model.js";
import { discoverRepositoryRoot } from "../run/engine.js";

export interface WorkflowRepositoryOptions {
  readonly cwd?: string;
  readonly rootTurboJson?: string;
}

export const loadWorkflowRepository = (
  options: WorkflowRepositoryOptions,
): Effect.Effect<
  RepositoryModel,
  unknown,
  EnvironmentService | FileSystemService | ProcessService
> =>
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
    const root = yield* discoverRepositoryRoot(canonical);
    const configuration = yield* loadRootConfiguration(
      root,
      options.rootTurboJson === undefined
        ? undefined
        : isAbsolutePath(options.rootTurboJson)
          ? options.rootTurboJson
          : joinPath(root, options.rootTurboJson),
    );
    return yield* discoverRepository(root, configuration);
  });

export const repositoryPackageManagerLabel = (
  repository: Pick<RepositoryModel, "manager">,
): string => (repository.manager === "pnpm" ? "pnpm9" : repository.manager);

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
  return ["/.git/", "/.turbo/", "/node_modules/"].some((component) =>
    relative.includes(component),
  );
};
