import { Effect, Stream } from "effect";
import { normalizePath } from "../core/path.js";
import { FileWatcherService, TerminalService } from "../effect/services.js";
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
    const changes = watcher.watch(repository.root).pipe(
      Stream.filter((change) => !ignoredWatchPath(change.path)),
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
