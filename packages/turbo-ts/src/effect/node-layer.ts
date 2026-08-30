import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { Cause, Effect, Exit, Layer, Option, Ref } from "effect";
import { BoundaryError, ProcessExecutionError } from "./errors.js";
import {
  CacheService,
  ClockService,
  ConcurrencyService,
  CredentialService,
  DaemonService,
  deterministicRetryLayer,
  EnvironmentService,
  type FileSystemOperations,
  FileSystemService,
  GitService,
  HttpService,
  ObservabilityService,
  PackageManagerService,
  ProcessService,
  RandomnessService,
  SignalService,
  TelemetryService,
  TerminalService,
} from "./services.js";

const boundaryFailure = (boundary: string) => ({
  execute: (operation: string) =>
    Effect.fail(
      new BoundaryError({
        boundary,
        message: `${operation} is assigned to a later compatibility gate`,
        retryable: false,
      }),
    ),
});

const gracefulTerminationTimeoutMilliseconds = 1_000;

const filesystemError = (cause: unknown): BoundaryError =>
  new BoundaryError({
    boundary: "filesystem",
    message: String(cause),
    retryable: false,
  });

const processExecutionError = (
  command: string,
  cause: unknown,
): ProcessExecutionError =>
  new ProcessExecutionError({
    command,
    message: String(cause),
  });

const effectFromExit = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<A, E> =>
  Exit.isSuccess(exit)
    ? Effect.succeed(exit.value)
    : Effect.failCause(exit.cause);

export const makeWithTemporaryDirectory =
  (
    makeDirectory: () => Promise<string>,
    removeDirectory: (path: string) => Promise<void>,
  ): FileSystemOperations["withTemporaryDirectory"] =>
  (use) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const cleanupResult = yield* Ref.make<
          Option.Option<Exit.Exit<void, BoundaryError>>
        >(Option.none());
        const useResult = yield* Effect.scoped(
          Effect.acquireRelease(
            Effect.tryPromise({
              try: makeDirectory,
              catch: filesystemError,
            }),
            (path) =>
              Effect.exit(
                Effect.tryPromise({
                  try: () => removeDirectory(path),
                  catch: filesystemError,
                }),
              ).pipe(
                Effect.flatMap((exit) =>
                  Ref.set(cleanupResult, Option.some(exit)),
                ),
              ),
          ).pipe(
            Effect.flatMap((path) => restore(use(path))),
            Effect.exit,
          ),
        );
        const cleanup = yield* Ref.get(cleanupResult);
        if (Option.isSome(cleanup) && Exit.isFailure(cleanup.value)) {
          if (Exit.isFailure(useResult)) {
            return yield* Effect.failCause(
              Cause.sequential(useResult.cause, cleanup.value.cause),
            );
          }
          return yield* Effect.failCause(cleanup.value.cause);
        }
        return yield* effectFromExit(useResult);
      }),
    );

interface ScopedChildProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  readonly isClosed: () => boolean;
  readonly processGroupId: number | undefined;
}

const makeChildEnvironment = (
  overrides: Readonly<Record<string, string | undefined>> | undefined,
): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) {
      delete environment[name];
    } else {
      environment[name] = value;
    }
  }
  return environment;
};

const isChildRunning = (child: ChildProcessWithoutNullStreams): boolean =>
  child.exitCode === null && child.signalCode === null;

const isNoSuchProcessError = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ESRCH";

const signalChildProcess = (
  { child, processGroupId }: ScopedChildProcess,
  signal: NodeJS.Signals,
): void => {
  if (processGroupId !== undefined) {
    try {
      process.kill(-processGroupId, signal);
    } catch (cause) {
      if (!isNoSuchProcessError(cause)) {
        throw cause;
      }
    }
  } else if (isChildRunning(child)) {
    child.kill(signal);
  }
};

const waitForCloseUntil = (
  closed: Promise<void>,
  timeoutMilliseconds: number,
): Promise<boolean> =>
  new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMilliseconds);
    closed.then(() => {
      clearTimeout(timeout);
      resolve(true);
    });
  });

const terminateChild = ({
  child,
  closed,
  isClosed,
  processGroupId,
}: ScopedChildProcess): Effect.Effect<void> =>
  Effect.promise(async () => {
    const scopedChild = { child, closed, isClosed, processGroupId };
    if (!isClosed()) {
      signalChildProcess(scopedChild, "SIGTERM");
      const closedGracefully = await waitForCloseUntil(
        closed,
        gracefulTerminationTimeoutMilliseconds,
      );
      if (!closedGracefully && !isClosed()) {
        signalChildProcess(scopedChild, "SIGKILL");
      }
    }
    await closed;
  });

const fileSystemLayer = Layer.succeed(FileSystemService, {
  readText: (path) =>
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: filesystemError,
    }),
  writeText: (path, contents) =>
    Effect.tryPromise({
      try: () => writeFile(path, contents, "utf8"),
      catch: filesystemError,
    }),
  // Effect finalizers cannot fail in the typed error channel. Own the scope and
  // capture cleanup exits so callers still receive BoundaryError. This wrapper
  // can be removed if typed finalizer failures become representable directly.
  withTemporaryDirectory: makeWithTemporaryDirectory(
    () => mkdtemp(join(tmpdir(), "turbo-ts-")),
    (path) => rm(path, { force: true, recursive: true }),
  ),
});

const processLayer = Layer.succeed(ProcessService, {
  run: (request) =>
    Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          const ownsProcessGroup = process.platform !== "win32";
          const child = spawn(request.command, [...request.args], {
            cwd: request.cwd,
            detached: ownsProcessGroup,
            env: makeChildEnvironment(request.env),
            shell: false,
            stdio: "pipe",
          });
          let childClosed = false;
          const closed = new Promise<void>((resolve) => {
            child.once("close", () => {
              childClosed = true;
              resolve();
            });
          });
          return {
            child,
            closed,
            isClosed: () => childClosed,
            processGroupId: ownsProcessGroup ? child.pid : undefined,
          };
        },
        catch: (cause) => processExecutionError(request.command, cause),
      }),
      ({ child }) =>
        Effect.async((resume) => {
          let settled = false;
          let stdout = "";
          let stderr = "";
          const fail = (cause: unknown) => {
            if (settled) {
              return;
            }
            settled = true;
            resume(Effect.fail(processExecutionError(request.command, cause)));
          };
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
          });
          child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
          });
          child.once("error", fail);
          child.stdin.on("error", fail);
          child.once("close", (exitCode) => {
            if (settled) {
              return;
            }
            settled = true;
            resume(
              Effect.succeed({
                exitCode: exitCode ?? 1,
                stdout,
                stderr,
              }),
            );
          });
          if (request.stdin === undefined) {
            child.stdin.end();
          } else {
            child.stdin.end(request.stdin);
          }
        }),
      terminateChild,
    ),
});

const environmentLayer = Layer.succeed(EnvironmentService, {
  argv: Effect.sync(() => [...process.argv]),
  cwd: Effect.sync(() => process.cwd()),
  get: (name) => Effect.sync(() => process.env[name]),
  entries: Effect.sync(() => ({ ...process.env })),
});

const terminalError = (cause: unknown): BoundaryError =>
  new BoundaryError({
    boundary: "terminal",
    message: String(cause),
    retryable: false,
  });

export const makeTerminalWriter =
  (stream: Writable) =>
  (text: string): Effect.Effect<void, BoundaryError> =>
    Effect.async<void, BoundaryError>((resume) => {
      let settled = false;
      const fail = (cause: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        resume(Effect.fail(terminalError(cause)));
      };
      const onError = (cause: Error) => {
        fail(cause);
      };
      stream.once("error", onError);
      try {
        stream.write(text, (cause) => {
          if (settled || (cause !== undefined && cause !== null)) {
            return;
          }
          settled = true;
          stream.off("error", onError);
          resume(Effect.void);
        });
      } catch (cause) {
        stream.off("error", onError);
        fail(cause);
      }
    }).pipe(Effect.uninterruptible);

const terminalLayer = Layer.succeed(TerminalService, {
  writeStdout: makeTerminalWriter(process.stdout),
  writeStderr: makeTerminalWriter(process.stderr),
  colorEnabled: Effect.sync(
    () => process.env.NO_COLOR === undefined && process.stdout.isTTY === true,
  ),
});

const clockLayer = Layer.succeed(ClockService, {
  now: Effect.sync(() => Date.now()),
  sleep: (milliseconds) => Effect.sleep(`${milliseconds} millis`),
});

const randomnessLayer = Layer.succeed(RandomnessService, {
  uuidV7: Effect.try({
    try: () => {
      const bytes = new Uint8Array(16);
      let timestamp = Date.now();
      for (let index = 5; index >= 0; index -= 1) {
        bytes[index] = timestamp & 0xff;
        timestamp = Math.floor(timestamp / 256);
      }
      const entropy = randomBytes(10);
      bytes[6] = 0x70 | (entropy[0]! & 0x0f);
      bytes[7] = entropy[1]!;
      bytes[8] = 0x80 | (entropy[2]! & 0x3f);
      bytes.set(entropy.subarray(3), 9);
      const hexadecimal = [...bytes]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`;
    },
    catch: (cause) =>
      new BoundaryError({
        boundary: "randomness",
        message: String(cause),
        retryable: false,
      }),
  }),
});

export const nodeFoundationLayer = Layer.mergeAll(
  fileSystemLayer,
  processLayer,
  environmentLayer,
  terminalLayer,
  clockLayer,
  randomnessLayer,
  Layer.succeed(GitService, boundaryFailure("git")),
  Layer.succeed(PackageManagerService, boundaryFailure("package-manager")),
  Layer.succeed(SignalService, boundaryFailure("signals")),
  Layer.succeed(ConcurrencyService, boundaryFailure("concurrency")),
  Layer.succeed(HttpService, boundaryFailure("http")),
  Layer.succeed(CredentialService, boundaryFailure("credentials")),
  Layer.succeed(CacheService, boundaryFailure("cache")),
  Layer.succeed(DaemonService, boundaryFailure("daemon")),
  Layer.succeed(TelemetryService, boundaryFailure("telemetry")),
  Layer.succeed(ObservabilityService, boundaryFailure("observability")),
  deterministicRetryLayer,
);
