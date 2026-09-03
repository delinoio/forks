import { Effect, Ref, Stream } from "effect";
import {
  canMatchGlobDescendant,
  matchesGlobsWithExclusions,
} from "../core/glob.js";
import { isPathContained, normalizePath, relativePath } from "../core/path.js";
import { FileWatcherService, TerminalService } from "../effect/services.js";
import {
  type GitIgnoreMatcher,
  loadGitIgnoreMatcher,
} from "../repository/git-ignore.js";
import type { RepositoryModel } from "../repository/model.js";
import { executeRun, type RunRequirements } from "../run/engine.js";
import { type ParsedRunOptions, parseRunArguments } from "../run/options.js";
import { loadWorkflowRepository } from "./repository.js";

export interface WatchOptions {
  readonly run: ParsedRunOptions;
  readonly writeCache: boolean;
}

export const parseWatchArguments = (
  arguments_: ReadonlyArray<string>,
): WatchOptions => {
  const writeCache = arguments_.includes("--experimental-write-cache");
  const runArguments = arguments_.filter(
    (argument) => argument !== "--experimental-write-cache",
  );
  const parsed = parseRunArguments(["run", ...runArguments]);
  return {
    writeCache,
    run: writeCache
      ? parsed
      : {
          ...parsed,
          cacheSpecification: parsed.cacheSpecification ?? "local:r,remote:r",
        },
  };
};

const ignoredWatchPath = (path: string): boolean => {
  const normalized = `/${normalizePath(path)}/`;
  return ["/.git/", "/.turbo/", "/node_modules/"].some((component) =>
    normalized.includes(component),
  );
};

const configuredOutputPath = (
  repository: RepositoryModel,
  path: string,
): boolean =>
  [repository.rootPackage, ...repository.packages].some((packageModel) => {
    if (!isPathContained(packageModel.directory, path)) return false;
    const relative = relativePath(packageModel.directory, path);
    return Object.values(packageModel.tasks).some((task) => {
      const outputs = task.outputs ?? [];
      return (
        matchesGlobsWithExclusions([relative], outputs) ||
        outputs.some(
          (output) =>
            !output.startsWith("!") && canMatchGlobDescendant(relative, output),
        )
      );
    });
  });

const isGitIgnorePath = (path: string): boolean =>
  normalizePath(path).split("/").at(-1) === ".gitignore";

export const executeWatch = (
  options: WatchOptions,
): Effect.Effect<number, unknown, FileWatcherService | RunRequirements> =>
  Effect.gen(function* () {
    const watcher = yield* FileWatcherService;
    const terminal = yield* TerminalService;
    const repository = yield* loadWorkflowRepository({
      cwd: options.run.cwd,
      rootTurboJson: options.run.rootTurboJson,
    });
    const ignoreMatcher = yield* Ref.make<GitIgnoreMatcher>(
      yield* loadGitIgnoreMatcher(repository.root),
    );
    const changes = watcher.watch(repository.root).pipe(
      Stream.filterEffect((change) =>
        Effect.gen(function* () {
          if (ignoredWatchPath(change.path)) return false;
          if (isGitIgnorePath(change.path)) {
            yield* Ref.set(
              ignoreMatcher,
              yield* loadGitIgnoreMatcher(repository.root),
            );
            return true;
          }
          const ignored = (yield* Ref.get(ignoreMatcher)).ignores(
            change.path,
            change.kind !== "modify",
          );
          return !ignored && !configuredOutputPath(repository, change.path);
        }),
      ),
      Stream.debounce("100 millis"),
      Stream.map((change) => change.path),
    );
    const triggers = Stream.concat(
      Stream.succeed<string | undefined>(undefined),
      changes,
    );
    yield* triggers.pipe(
      Stream.flatMap(
        (path) =>
          Stream.fromEffect(
            Effect.gen(function* () {
              if (path !== undefined) {
                yield* terminal.writeStdout(`\n• change detected: ${path}\n`);
              }
              return yield* executeRun(options.run).pipe(
                Effect.catchAll((cause) =>
                  terminal
                    .writeStderr(
                      `turbo-ts: watch run failed: ${String(cause)}\n`,
                    )
                    .pipe(Effect.as(1)),
                ),
              );
            }),
          ),
        { concurrency: "unbounded", switch: true },
      ),
      Stream.runDrain,
    );
    return 0;
  });
