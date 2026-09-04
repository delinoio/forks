import { Deferred, Effect, Queue, Stream } from "effect";
import { matchesGlobsWithExclusions } from "../core/glob.js";
import {
  isPathContained,
  joinPath,
  normalizePath,
  parentPath,
  relativePath,
} from "../core/path.js";
import { BoundaryError, ConfigurationError } from "../effect/errors.js";
import {
  ClockService,
  DaemonMethod,
  type DaemonMethod as DaemonMethodType,
  DaemonService,
  DigestService,
  EnvironmentService,
  FileSystemService,
  FileWatcherService,
  ProcessService,
  SignalService,
  SystemService,
  TerminalService,
} from "../effect/services.js";
import {
  loadWorkflowRepository,
  repositoryPackageManagerLabel,
} from "./repository.js";

type DaemonCommand =
  | "clean"
  | "logs"
  | "restart"
  | "start"
  | "status"
  | "stop"
  | "serve";

export interface DaemonOptions {
  readonly command: DaemonCommand;
  readonly cwd?: string;
  readonly idleMilliseconds: number;
  readonly json: boolean;
}

interface DaemonPaths {
  readonly hash: string;
  readonly stateDirectory: string;
  readonly socket: string;
  readonly pid: string;
  readonly lock: string;
  readonly activeLog: string;
  readonly log: string;
}

const durationMilliseconds = (value: string): number => {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(value);
  if (match === null) {
    throw new ConfigurationError({
      path: "<arguments>",
      message: `invalid idle time: ${value}`,
    });
  }
  const multiplier =
    match[2] === "ms"
      ? 1
      : match[2] === "s"
        ? 1_000
        : match[2] === "m"
          ? 60_000
          : match[2] === "d"
            ? 86_400_000
            : 3_600_000;
  return Number(match[1]) * multiplier;
};

export const parseDaemonArguments = (
  arguments_: ReadonlyArray<string>,
): DaemonOptions => {
  let command: DaemonCommand | undefined;
  let cwd: string | undefined;
  let idleMilliseconds = 4 * 60 * 60 * 1_000;
  let json = false;
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
      if (
        ![
          "clean",
          "logs",
          "restart",
          "start",
          "status",
          "stop",
          "serve",
        ].includes(argument) ||
        command !== undefined
      ) {
        throw new ConfigurationError({
          path: "<arguments>",
          message: `unexpected daemon argument: ${argument}`,
        });
      }
      command = argument as DaemonCommand;
      continue;
    }
    switch (argument.split("=", 1)[0]) {
      case "--cwd":
        cwd = takeValue();
        break;
      case "--idle-time":
        idleMilliseconds = durationMilliseconds(takeValue());
        break;
      case "--json":
        json = true;
        break;
      case "--no-color":
      case "--no-update-notifier":
        break;
      case "--turbo-json-path":
        takeValue();
        break;
      default:
        throw new ConfigurationError({
          path: "<arguments>",
          message: `unknown option: ${argument}`,
        });
    }
  }
  if (command === undefined) {
    throw new ConfigurationError({
      path: "<arguments>",
      message: "a daemon command is required",
    });
  }
  return { command, cwd, idleMilliseconds, json };
};

const daemonPaths = (
  root: string,
): Effect.Effect<DaemonPaths, BoundaryError, DigestService | SystemService> =>
  Effect.gen(function* () {
    const digest = yield* DigestService;
    const system = yield* SystemService;
    const information = yield* system.information;
    if (digest.sha256 === undefined) {
      return yield* Effect.fail(
        new BoundaryError({
          boundary: "daemon",
          message: "SHA-256 is unavailable",
          retryable: false,
        }),
      );
    }
    const hash = (yield* digest.sha256(root)).slice(0, 16);
    const stateDirectory = joinPath(
      information.temporaryDirectory,
      `turbod-${information.userIdentifier}`,
      hash,
    );
    const date = new Date().toISOString().slice(0, 10);
    return {
      hash,
      stateDirectory,
      socket: joinPath(stateDirectory, "turbod.sock"),
      pid: joinPath(stateDirectory, "turbod.pid"),
      lock: joinPath(stateDirectory, "turbod.lock"),
      activeLog: joinPath(stateDirectory, "turbod.log-path"),
      log: joinPath(root, ".turbo", "daemon", `${hash}-turbo.log.${date}`),
    };
  });

const readPid = (
  path: string,
): Effect.Effect<number | undefined, never, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const exists = yield* fileSystem
      .exists(path)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) return undefined;
    const source = yield* fileSystem
      .readText(path)
      .pipe(Effect.orElseSucceed(() => ""));
    const pid = Number(source.trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  });

const isAlive = (
  pid: number | undefined,
): Effect.Effect<boolean, never, ProcessService> =>
  Effect.gen(function* () {
    if (pid === undefined) return false;
    const processService = yield* ProcessService;
    return processService.isProcessAlive === undefined
      ? true
      : yield* processService.isProcessAlive(pid);
  });

const cleanStaleState = (
  paths: DaemonPaths,
): Effect.Effect<void, never, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    yield* Effect.all([
      fileSystem.remove(paths.pid).pipe(Effect.ignore),
      fileSystem.remove(paths.socket).pipe(Effect.ignore),
      fileSystem.remove(paths.activeLog).pipe(Effect.ignore),
    ]);
  });

const readActiveLogPath = (
  paths: DaemonPaths,
): Effect.Effect<string | undefined, never, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const source = yield* fileSystem
      .readText(paths.activeLog)
      .pipe(Effect.orElseSucceed(() => ""));
    const candidate = normalizePath(source.trim());
    return candidate !== "" && isPathContained(parentPath(paths.log), candidate)
      ? candidate
      : undefined;
  });

const daemonRequest = (
  paths: DaemonPaths,
  method: DaemonMethodType,
  params?: unknown,
) =>
  Effect.gen(function* () {
    const daemon = yield* DaemonService;
    return yield* daemon.request(paths.socket, {
      id: `${method}-0`,
      method,
      params,
    });
  });

const daemonHealthy = (
  paths: DaemonPaths,
): Effect.Effect<
  boolean,
  never,
  DaemonService | FileSystemService | ProcessService
> =>
  Effect.gen(function* () {
    const pid = yield* readPid(paths.pid);
    if (!(yield* isAlive(pid))) return false;
    const hello = yield* daemonRequest(paths, DaemonMethod.hello, {
      version: "2.0.0",
    }).pipe(Effect.either);
    return hello._tag === "Right" && hello.right.error === undefined;
  });

export const daemonIsRunning = (
  root: string,
): Effect.Effect<
  boolean,
  never,
  | DaemonService
  | DigestService
  | FileSystemService
  | ProcessService
  | SystemService
> =>
  daemonPaths(root).pipe(
    Effect.flatMap(daemonHealthy),
    Effect.orElseSucceed(() => false),
  );

const staleStartLockMilliseconds = 30_000;

const acquireStartLock = (
  paths: DaemonPaths,
): Effect.Effect<string, BoundaryError, ClockService | FileSystemService> =>
  Effect.gen(function* () {
    const clock = yield* ClockService;
    const fileSystem = yield* FileSystemService;
    const now = yield* clock.now;
    const contents = `${now}\n`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (yield* fileSystem.createExclusiveFile(paths.lock, contents)) {
        return contents;
      }
      const observed = yield* fileSystem
        .readText(paths.lock)
        .pipe(Effect.either);
      if (observed._tag === "Left") continue;
      const timestamp = Number(observed.right.trim());
      if (
        Number.isFinite(timestamp) &&
        now - timestamp < staleStartLockMilliseconds
      ) {
        break;
      }
      yield* Effect.yieldNow();
      const confirmed = yield* fileSystem
        .readText(paths.lock)
        .pipe(Effect.either);
      if (confirmed._tag === "Left" || confirmed.right !== observed.right) {
        continue;
      }
      yield* fileSystem.remove(paths.lock).pipe(Effect.ignore);
    }
    return yield* Effect.fail(
      new BoundaryError({
        boundary: "daemon",
        message: "another daemon start is in progress",
        retryable: true,
      }),
    );
  });

const releaseStartLock = (
  paths: DaemonPaths,
  contents: string,
): Effect.Effect<void, never, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const current = yield* fileSystem.readText(paths.lock).pipe(Effect.either);
    if (current._tag === "Right" && current.right === contents) {
      yield* fileSystem.remove(paths.lock).pipe(Effect.ignore);
    }
  });

const startDaemon = (
  options: DaemonOptions,
  root: string,
  paths: DaemonPaths,
): Effect.Effect<
  void,
  unknown,
  | ClockService
  | DaemonService
  | EnvironmentService
  | FileSystemService
  | ProcessService
  | TerminalService
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const processService = yield* ProcessService;
    const environment = yield* EnvironmentService;
    const terminal = yield* TerminalService;
    if (yield* daemonHealthy(paths)) {
      yield* terminal.writeStdout("✓ daemon is running\n");
      return;
    }
    yield* fileSystem.makeDirectory(paths.stateDirectory);
    const clock = yield* ClockService;
    const startedAt = yield* clock.now;
    yield* fileSystem
      .setFileMetadata(paths.stateDirectory, 0o700, startedAt)
      .pipe(Effect.ignore);
    yield* Effect.acquireUseRelease(
      acquireStartLock(paths),
      () =>
        Effect.gen(function* () {
          if (yield* daemonHealthy(paths)) {
            yield* terminal.writeStdout("✓ daemon is running\n");
            return;
          }
          yield* cleanStaleState(paths);
          const argv = yield* environment.argv;
          const executable =
            environment.executablePath === undefined
              ? undefined
              : yield* environment.executablePath;
          if (
            executable === undefined ||
            argv[1] === undefined ||
            processService.spawnDetached === undefined
          ) {
            return yield* Effect.fail(
              new BoundaryError({
                boundary: "daemon",
                message: "detached process execution is unavailable",
                retryable: false,
              }),
            );
          }
          const childPid = yield* processService.spawnDetached({
            command: executable,
            args: [
              argv[1],
              "daemon",
              "serve",
              "--cwd",
              root,
              `--idle-time=${options.idleMilliseconds}ms`,
            ],
            cwd: root,
            inheritEnvironment: true,
          });
          let ready = false;
          for (let attempt = 0; attempt < 100; attempt += 1) {
            yield* Effect.sleep("50 millis");
            if (yield* daemonHealthy(paths)) {
              ready = true;
              break;
            }
          }
          if (!ready) {
            if (processService.terminateProcess !== undefined) {
              yield* processService
                .terminateProcess(childPid, true)
                .pipe(Effect.ignore);
            }
            yield* cleanStaleState(paths);
            return yield* Effect.fail(
              new BoundaryError({
                boundary: "daemon",
                message: "daemon did not become ready",
                retryable: true,
              }),
            );
          }
          yield* terminal.writeStdout("✓ daemon is running\n");
        }),
      (contents) => releaseStartLock(paths, contents),
    );
  });

const stopDaemon = (
  paths: DaemonPaths,
): Effect.Effect<
  void,
  never,
  | ClockService
  | DaemonService
  | FileSystemService
  | ProcessService
  | TerminalService
> =>
  Effect.gen(function* () {
    const processService = yield* ProcessService;
    const terminal = yield* TerminalService;
    const pid = yield* readPid(paths.pid);
    if (!(yield* isAlive(pid))) {
      yield* cleanStaleState(paths);
      yield* terminal.writeStdout("✓ stopped daemon\n").pipe(Effect.ignore);
      return;
    }
    if (!(yield* daemonHealthy(paths))) {
      yield* cleanStaleState(paths);
      yield* terminal.writeStdout("✓ stopped daemon\n").pipe(Effect.ignore);
      return;
    }
    const shutdown = yield* daemonRequest(paths, DaemonMethod.shutdown).pipe(
      Effect.either,
    );
    if (shutdown._tag === "Left" || shutdown.right.error !== undefined) {
      yield* cleanStaleState(paths);
      yield* terminal.writeStdout("✓ stopped daemon\n").pipe(Effect.ignore);
      return;
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (!(yield* isAlive(pid))) break;
      yield* Effect.sleep("25 millis");
    }
    const remainsAlive = yield* isAlive(pid);
    if (
      remainsAlive &&
      pid !== undefined &&
      processService.terminateProcess !== undefined
    ) {
      yield* processService.terminateProcess(pid, true).pipe(Effect.ignore);
    }
    yield* cleanStaleState(paths);
    yield* terminal.writeStdout("✓ stopped daemon\n").pipe(Effect.ignore);
  });

const serveDaemon = (
  options: DaemonOptions,
  paths: DaemonPaths,
  repository: import("../repository/model.js").RepositoryModel,
): Effect.Effect<
  number,
  unknown,
  | ClockService
  | DaemonService
  | EnvironmentService
  | FileSystemService
  | FileWatcherService
  | ProcessService
  | SystemService
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const clock = yield* ClockService;
      const daemon = yield* DaemonService;
      const fileSystem = yield* FileSystemService;
      const fileWatcher = yield* FileWatcherService;
      const system = yield* SystemService;
      const information = yield* system.information;
      const shutdown = yield* Deferred.make<void>();
      const activity = yield* Queue.sliding<void>(1);
      const outputRegistrations = new Map<
        string,
        {
          readonly outputGlobs: ReadonlyArray<string>;
          readonly outputExclusionGlobs: ReadonlyArray<string>;
          readonly changedOutputGlobs: Set<string>;
        }
      >();
      const startedAt = yield* clock.now;
      yield* fileSystem.makeDirectory(paths.stateDirectory);
      yield* fileSystem.makeDirectory(parentPath(paths.log));
      yield* fileSystem.writeTextAtomic(paths.activeLog, `${paths.log}\n`);
      yield* fileSystem.writeTextAtomic(
        paths.pid,
        `${information.processIdentifier}`,
      );
      yield* fileSystem
        .setFileMetadata(paths.pid, 0o644, startedAt)
        .pipe(Effect.ignore);
      yield* fileSystem.appendText(
        paths.log,
        `${new Date(startedAt).toISOString()} daemon started pid=${information.processIdentifier}\n`,
      );
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* fileSystem.remove(paths.pid).pipe(Effect.ignore);
          const stoppedAt = yield* clock.now;
          yield* fileSystem
            .appendText(
              paths.log,
              `${new Date(stoppedAt).toISOString()} daemon stopped\n`,
            )
            .pipe(Effect.ignore);
        }),
      );
      const repositoryChanges = fileWatcher.watch(repository.root).pipe(
        Stream.filter((change) => {
          const normalized = `/${normalizePath(change.path)}/`;
          return !["/.git/", "/.turbo/", "/node_modules/"].some((component) =>
            normalized.includes(component),
          );
        }),
        Stream.runForEach((change) =>
          Effect.gen(function* () {
            const relative = relativePath(repository.root, change.path);
            for (const registration of outputRegistrations.values()) {
              const patterns = [
                ...registration.outputGlobs,
                ...registration.outputExclusionGlobs.map((glob) => `!${glob}`),
              ];
              if (!matchesGlobsWithExclusions([relative], patterns)) {
                continue;
              }
              for (const glob of registration.outputGlobs) {
                if (matchesGlobsWithExclusions([relative], [glob])) {
                  registration.changedOutputGlobs.add(glob);
                }
              }
            }
            yield* Queue.offer(activity, undefined);
          }),
        ),
      );
      yield* Effect.forkScoped(repositoryChanges);
      const serve = Stream.runForEach(
        daemon.serve(paths.socket),
        (connection) =>
          Stream.runForEach(connection.requests, (request) =>
            Effect.gen(function* () {
              yield* Queue.offer(activity, undefined);
              yield* fileSystem
                .appendText(
                  paths.log,
                  `${new Date(yield* clock.now).toISOString()} rpc=${request.method}\n`,
                )
                .pipe(Effect.ignore);
              const result = yield* (() => {
                if (request.method === DaemonMethod.status) {
                  return Effect.gen(function* () {
                    return {
                      logFile: paths.log.replace(/\.\d{4}-\d{2}-\d{2}$/, ""),
                      uptimeMilliseconds: Math.max(
                        0,
                        (yield* clock.now) - startedAt,
                      ),
                    };
                  });
                }
                if (request.method === DaemonMethod.discoverPackages) {
                  return loadWorkflowRepository({
                    cwd: repository.root,
                  }).pipe(
                    Effect.map((currentRepository) => ({
                      packages: currentRepository.packages
                        .map((packageModel) => ({
                          name: packageModel.name,
                          path: packageModel.relativeDirectory,
                        }))
                        .sort((left, right) =>
                          left.name.localeCompare(right.name),
                        ),
                      packageManager:
                        repositoryPackageManagerLabel(currentRepository),
                    })),
                  );
                }
                if (request.method === DaemonMethod.notifyOutputsWritten) {
                  const params = request.params as {
                    readonly hash?: unknown;
                    readonly outputGlobs?: unknown;
                    readonly outputExclusionGlobs?: unknown;
                  };
                  if (typeof params.hash !== "string" || params.hash === "") {
                    return Effect.fail(
                      new BoundaryError({
                        boundary: "daemon",
                        message: "NotifyOutputsWritten requires a hash",
                        retryable: false,
                      }),
                    );
                  }
                  outputRegistrations.set(params.hash, {
                    outputGlobs: Array.isArray(params.outputGlobs)
                      ? params.outputGlobs.filter(
                          (value): value is string => typeof value === "string",
                        )
                      : [],
                    outputExclusionGlobs: Array.isArray(
                      params.outputExclusionGlobs,
                    )
                      ? params.outputExclusionGlobs.filter(
                          (value): value is string => typeof value === "string",
                        )
                      : [],
                    changedOutputGlobs: new Set(),
                  });
                  return Effect.succeed({});
                }
                if (request.method === DaemonMethod.getChangedOutputs) {
                  const params = request.params as {
                    readonly hashes?: unknown;
                  };
                  const hashes = Array.isArray(params.hashes)
                    ? params.hashes.filter(
                        (value): value is string => typeof value === "string",
                      )
                    : [];
                  const changedOutputs = hashes.flatMap((hash) => {
                    const registration = outputRegistrations.get(hash);
                    if (registration === undefined) return [];
                    const changedOutputGlobs = [
                      ...registration.changedOutputGlobs,
                    ].sort();
                    registration.changedOutputGlobs.clear();
                    return [{ hash, changedOutputGlobs }];
                  });
                  return Effect.succeed({ changedOutputs });
                }
                return Effect.succeed({});
              })().pipe(Effect.either);
              if (result._tag === "Left") {
                yield* connection.respond({
                  id: request.id,
                  error:
                    result.left instanceof Error
                      ? result.left.message
                      : String(result.left),
                });
              } else {
                yield* connection.respond({
                  id: request.id,
                  result: result.right,
                });
              }
              if (request.method === DaemonMethod.shutdown) {
                yield* Deferred.succeed(shutdown, undefined);
              }
            }),
          ),
      );
      const waitForIdle = Effect.gen(function* () {
        while (true) {
          const outcome = yield* Effect.race(
            Queue.take(activity).pipe(Effect.as("activity" as const)),
            clock
              .sleep(options.idleMilliseconds)
              .pipe(Effect.as("idle" as const)),
          );
          if (outcome === "idle") return;
        }
      });
      yield* Effect.race(
        serve,
        Effect.race(Deferred.await(shutdown), waitForIdle),
      );
      return 0;
    }),
  );

export const executeDaemon = (
  options: DaemonOptions,
): Effect.Effect<
  number,
  unknown,
  | ClockService
  | DaemonService
  | DigestService
  | EnvironmentService
  | FileSystemService
  | FileWatcherService
  | ProcessService
  | SignalService
  | SystemService
  | TerminalService
> =>
  Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const fileSystem = yield* FileSystemService;
    const repository = yield* loadWorkflowRepository(options);
    const paths = yield* daemonPaths(repository.root);
    if (options.command === "serve") {
      return yield* serveDaemon(options, paths, repository);
    }
    if (options.command === "stop") {
      yield* stopDaemon(paths);
      return 0;
    }
    if (options.command === "clean") {
      yield* stopDaemon(paths);
      yield* fileSystem.remove(paths.stateDirectory).pipe(Effect.ignore);
      return 0;
    }
    if (options.command === "restart") {
      yield* stopDaemon(paths);
      yield* startDaemon(options, repository.root, paths);
      return 0;
    }
    if (options.command === "start") {
      yield* startDaemon(options, repository.root, paths);
      return 0;
    }
    if (options.command === "logs") {
      const watcher = yield* FileWatcherService;
      const signals = yield* SignalService;
      if (!(yield* daemonHealthy(paths))) {
        yield* cleanStaleState(paths);
        yield* terminal.writeStderr(
          "x daemon is not running, run `turbo daemon start` to start it\n",
        );
        return 1;
      }
      const status = yield* daemonRequest(paths, DaemonMethod.status).pipe(
        Effect.either,
      );
      if (status._tag === "Left" || status.right.error !== undefined) {
        yield* cleanStaleState(paths);
        yield* terminal.writeStderr(
          "x daemon is not running, run `turbo daemon start` to start it\n",
        );
        return 1;
      }
      const logPath = (yield* readActiveLogPath(paths)) ?? paths.log;
      return yield* Effect.scoped(
        Effect.gen(function* () {
          let contents = yield* fileSystem
            .readText(logPath)
            .pipe(Effect.orElseSucceed(() => ""));
          yield* terminal.writeStdout(contents);
          const follow = watcher.watch(parentPath(logPath)).pipe(
            Stream.filter((change) => change.path === logPath),
            Stream.mapEffect(() =>
              fileSystem.readText(logPath).pipe(Effect.orElseSucceed(() => "")),
            ),
            Stream.mapEffect((updated) => {
              const offset = updated.startsWith(contents) ? contents.length : 0;
              const appended = updated.slice(offset);
              contents = updated;
              return appended === ""
                ? Effect.void
                : terminal.writeStdout(appended);
            }),
            Stream.runDrain,
          );
          yield* Effect.race(follow, Stream.runHead(signals.signals));
          return 0;
        }),
      );
    }
    if (!(yield* daemonHealthy(paths))) {
      yield* cleanStaleState(paths);
      yield* terminal.writeStderr(
        "x daemon is not running, run `turbo daemon start` to start it\n",
      );
      return 1;
    }
    const status = yield* daemonRequest(paths, DaemonMethod.status).pipe(
      Effect.either,
    );
    if (status._tag === "Left" || status.right.error !== undefined) {
      yield* cleanStaleState(paths);
      yield* terminal.writeStderr(
        "x daemon is not running, run `turbo daemon start` to start it\n",
      );
      return 1;
    }
    const result = status.right.result as {
      readonly logFile?: unknown;
      readonly uptimeMilliseconds?: unknown;
    };
    const uptime =
      typeof result.uptimeMilliseconds === "number"
        ? result.uptimeMilliseconds
        : 0;
    const logPath = (yield* readActiveLogPath(paths)) ?? paths.log;
    if (options.json) {
      yield* terminal.writeStdout(
        `${JSON.stringify(
          {
            uptime_ms: uptime,
            log_file: logPath,
            pid_file: paths.pid,
            sock_file: paths.socket,
          },
          undefined,
          2,
        )}\n`,
      );
      return 0;
    }
    yield* terminal.writeStdout(
      `log file: ${logPath}\nuptime: ${Math.floor(uptime / 1000)}s\npid file: ${paths.pid}\nsocket file: ${paths.socket}\n`,
    );
    return 0;
  });
