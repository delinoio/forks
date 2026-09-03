import { Effect } from "effect";
import { loadRootConfiguration } from "../config/runtime.js";
import { isAbsolutePath, joinPath } from "../core/path.js";
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
  repository: RepositoryModel,
): string => {
  if (repository.manager === "pnpm") return "pnpm9";
  const major = repository.managerVersion?.match(/^\d+/)?.[0];
  return `${repository.manager}${major ?? ""}`;
};
