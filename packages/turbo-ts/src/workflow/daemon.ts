import { Deferred, Effect, Stream } from "effect";
import { joinPath, parentPath } from "../core/path.js";
import { BoundaryError, ConfigurationError } from "../effect/errors.js";
import {
  ClockService,
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
import { loadWorkflowRepository } from "./repository.js";

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
      fileSystem.remove(paths.lock).pipe(Effect.ignore),
    ]);
  });

const daemonRequest = (paths: DaemonPaths, method: string, params?: unknown) =>
  Effect.gen(function* () {
    const daemon = yield* DaemonService;
    return yield* daemon.request(paths.socket, {
      id: `${method}-0`,
      method,
      params,
    });
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
    const pid = yield* readPid(paths.pid);
    if (yield* isAlive(pid)) {
      const hello = yield* daemonRequest(paths, "Hello", {
        version: "2.0.0",
      }).pipe(Effect.either);
      if (hello._tag === "Right") {
        yield* terminal.writeStdout("✓ daemon is running\n");
        return;
      }
    }
    yield* cleanStaleState(paths);
    yield* fileSystem.makeDirectory(paths.stateDirectory);
    const clock = yield* ClockService;
    const startedAt = yield* clock.now;
    yield* fileSystem
      .setFileMetadata(paths.stateDirectory, 0o700, startedAt)
      .pipe(Effect.ignore);
    const ownsLock = yield* fileSystem.createExclusiveFile(
      paths.lock,
      `${startedAt}\n`,
    );
    if (!ownsLock) {
      return yield* Effect.fail(
        new BoundaryError({
          boundary: "daemon",
          message: "another daemon start is in progress",
          retryable: true,
        }),
      );
    }
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
      yield* fileSystem.remove(paths.lock).pipe(Effect.ignore);
      return yield* Effect.fail(
        new BoundaryError({
          boundary: "daemon",
          message: "detached process execution is unavailable",
          retryable: false,
        }),
      );
    }
    yield* processService
      .spawnDetached({
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
      })
      .pipe(
        Effect.tapError(() =>
          fileSystem.remove(paths.lock).pipe(Effect.ignore),
        ),
      );
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      yield* Effect.sleep("50 millis");
      const hello = yield* daemonRequest(paths, "Hello", {
        version: "2.0.0",
      }).pipe(Effect.either);
      if (hello._tag === "Right") {
        ready = true;
        break;
      }
    }
    yield* fileSystem.remove(paths.lock).pipe(Effect.ignore);
    if (!ready) {
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
    yield* daemonRequest(paths, "Shutdown").pipe(Effect.ignore);
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
): Effect.Effect<
  number,
  unknown,
  ClockService | DaemonService | FileSystemService | SystemService
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const clock = yield* ClockService;
      const daemon = yield* DaemonService;
      const fileSystem = yield* FileSystemService;
      const system = yield* SystemService;
      const information = yield* system.information;
      const shutdown = yield* Deferred.make<void>();
      const startedAt = yield* clock.now;
      yield* fileSystem.makeDirectory(paths.stateDirectory);
      yield* fileSystem.makeDirectory(parentPath(paths.log));
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
          yield* fileSystem.remove(paths.lock).pipe(Effect.ignore);
          const stoppedAt = yield* clock.now;
          yield* fileSystem
            .appendText(
              paths.log,
              `${new Date(stoppedAt).toISOString()} daemon stopped\n`,
            )
            .pipe(Effect.ignore);
        }),
      );
      const serve = Stream.runForEach(
        daemon.serve(paths.socket),
        (connection) =>
          Stream.runForEach(connection.requests, (request) =>
            Effect.gen(function* () {
              yield* fileSystem
                .appendText(
                  paths.log,
                  `${new Date(yield* clock.now).toISOString()} rpc=${request.method}\n`,
                )
                .pipe(Effect.ignore);
              const result =
                request.method === "Status"
                  ? {
                      logFile: paths.log.replace(/\.\d{4}-\d{2}-\d{2}$/, ""),
                      uptimeMilliseconds: Math.max(
                        0,
                        (yield* clock.now) - startedAt,
                      ),
                    }
                  : {};
              yield* connection.respond({ id: request.id, result });
              if (request.method === "Shutdown") {
                yield* Deferred.succeed(shutdown, undefined);
              }
            }),
          ),
      );
      yield* Effect.race(
        serve,
        Effect.race(
          Deferred.await(shutdown),
          clock.sleep(options.idleMilliseconds),
        ),
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
    if (options.command === "serve") return yield* serveDaemon(options, paths);
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
      return yield* Effect.scoped(
        Effect.gen(function* () {
          let contents = yield* fileSystem
            .readText(paths.log)
            .pipe(Effect.orElseSucceed(() => ""));
          yield* terminal.writeStdout(contents);
          const follow = watcher.watch(parentPath(paths.log)).pipe(
            Stream.filter((change) => change.path === paths.log),
            Stream.mapEffect(() =>
              fileSystem
                .readText(paths.log)
                .pipe(Effect.orElseSucceed(() => "")),
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
    const pid = yield* readPid(paths.pid);
    if (!(yield* isAlive(pid))) {
      yield* cleanStaleState(paths);
      yield* terminal.writeStderr(
        "x daemon is not running, run `turbo daemon start` to start it\n",
      );
      return 1;
    }
    const hello = yield* daemonRequest(paths, "Hello", { version: "2.0.0" });
    if (hello.error !== undefined) {
      return yield* Effect.fail(
        new BoundaryError({
          boundary: "daemon",
          message: hello.error,
          retryable: false,
        }),
      );
    }
    const status = yield* daemonRequest(paths, "Status");
    const result = status.result as {
      readonly logFile?: unknown;
      readonly uptimeMilliseconds?: unknown;
    };
    const uptime =
      typeof result.uptimeMilliseconds === "number"
        ? result.uptimeMilliseconds
        : 0;
    if (options.json) {
      yield* terminal.writeStdout(
        `${JSON.stringify(
          {
            uptime_ms: uptime,
            log_file: paths.log,
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
      `log file: ${paths.log}\nuptime: ${Math.floor(uptime / 1000)}s\npid file: ${paths.pid}\nsocket file: ${paths.socket}\n`,
    );
    return 0;
  });
