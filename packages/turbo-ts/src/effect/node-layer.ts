import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { BoundaryError, ProcessExecutionError } from "./errors.js";
import {
  CacheService,
  ClockService,
  ConcurrencyService,
  CredentialService,
  DaemonService,
  deterministicRetryLayer,
  EnvironmentService,
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

interface ScopedChildProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
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
}: ScopedChildProcess): Effect.Effect<void> =>
  Effect.promise(async () => {
    if (isChildRunning(child)) {
      child.kill("SIGTERM");
      const closedGracefully = await waitForCloseUntil(
        closed,
        gracefulTerminationTimeoutMilliseconds,
      );
      if (!closedGracefully && isChildRunning(child)) {
        child.kill("SIGKILL");
      }
    }
    await closed;
  });

const fileSystemLayer = Layer.succeed(FileSystemService, {
  readText: (path) =>
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) =>
        new BoundaryError({
          boundary: "filesystem",
          message: String(cause),
          retryable: false,
        }),
    }),
  writeText: (path, contents) =>
    Effect.tryPromise({
      try: () => writeFile(path, contents, "utf8"),
      catch: (cause) =>
        new BoundaryError({
          boundary: "filesystem",
          message: String(cause),
          retryable: false,
        }),
    }),
  temporaryDirectory: Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "turbo-ts-")),
      catch: (cause) =>
        new BoundaryError({
          boundary: "filesystem",
          message: String(cause),
          retryable: false,
        }),
    }),
    (path) => Effect.promise(() => rm(path, { force: true, recursive: true })),
  ),
});

const processLayer = Layer.succeed(ProcessService, {
  run: (request) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const child = spawn(request.command, [...request.args], {
          cwd: request.cwd,
          env: makeChildEnvironment(request.env),
          shell: false,
          stdio: "pipe",
        });
        const closed = new Promise<void>((resolve) => {
          child.once("close", () => resolve());
        });
        return { child, closed };
      }),
      ({ child }) =>
        Effect.async((resume) => {
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
          });
          child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
          });
          child.once("error", (cause) =>
            resume(
              Effect.fail(
                new ProcessExecutionError({
                  command: request.command,
                  message: String(cause),
                }),
              ),
            ),
          );
          child.once("close", (exitCode) =>
            resume(
              Effect.succeed({
                exitCode: exitCode ?? 1,
                stdout,
                stderr,
              }),
            ),
          );
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

const terminalLayer = Layer.succeed(TerminalService, {
  writeStdout: (text) =>
    Effect.try({
      try: () => {
        process.stdout.write(text);
      },
      catch: (cause) =>
        new BoundaryError({
          boundary: "terminal",
          message: String(cause),
          retryable: false,
        }),
    }),
  writeStderr: (text) =>
    Effect.try({
      try: () => {
        process.stderr.write(text);
      },
      catch: (cause) =>
        new BoundaryError({
          boundary: "terminal",
          message: String(cause),
          retryable: false,
        }),
    }),
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
