import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  spawn,
} from "node:child_process";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { zstdCompress, zstdDecompress } from "node:zlib";
import { Cause, Effect, Exit, Layer, Option, Ref } from "effect";
import { BoundaryError, ProcessExecutionError } from "./errors.js";
import {
  CacheService,
  ClockService,
  CompressionService,
  ConcurrencyService,
  CredentialService,
  DaemonService,
  DigestService,
  deterministicRetryLayer,
  EnvironmentService,
  type FileSystemOperations,
  FileSystemService,
  GitService,
  HttpService,
  ObservabilityService,
  type OutputChunkHandler,
  PackageManagerService,
  ProcessService,
  RandomnessService,
  SignalService,
  SigningService,
  TelemetryService,
  type TerminalOperations,
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

const isMissingFileError = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";

const metadataKind = (
  metadata: Awaited<ReturnType<typeof lstat>>,
): "directory" | "file" | "symlink" | "other" =>
  metadata.isDirectory()
    ? "directory"
    : metadata.isFile()
      ? "file"
      : metadata.isSymbolicLink()
        ? "symlink"
        : "other";

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
  readonly child: ChildProcess;
  readonly closed: Promise<void>;
  readonly isClosed: () => boolean;
  readonly processGroupId: number | undefined;
  readonly capturesOutput: boolean;
}

export const makeChildEnvironment = (
  inherited: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string | undefined>> | undefined,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv => {
  const environment = { ...inherited };
  for (const [name, value] of Object.entries(overrides ?? {})) {
    const normalizedName = platform === "win32" ? name.toLowerCase() : name;
    for (const inheritedName of Object.keys(environment)) {
      const normalizedInheritedName =
        platform === "win32" ? inheritedName.toLowerCase() : inheritedName;
      if (normalizedInheritedName === normalizedName) {
        delete environment[inheritedName];
      }
    }
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
};

const isChildRunning = (child: ChildProcess): boolean =>
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
  capturesOutput,
}: ScopedChildProcess): Effect.Effect<void> =>
  Effect.promise(async () => {
    const scopedChild = {
      child,
      closed,
      isClosed,
      processGroupId,
      capturesOutput,
    };
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
  readBytes: (path) =>
    Effect.tryPromise({
      try: async () => new Uint8Array(await readFile(path)),
      catch: filesystemError,
    }),
  readLink: (path) =>
    Effect.tryPromise({
      try: () => readlink(path),
      catch: filesystemError,
    }),
  exists: (path) =>
    Effect.tryPromise({
      try: async () => {
        try {
          await lstat(path);
          return true;
        } catch (cause) {
          if (isMissingFileError(cause)) {
            return false;
          }
          throw cause;
        }
      },
      catch: filesystemError,
    }),
  list: (path) =>
    Effect.tryPromise({
      try: async () =>
        (await readdir(path, { withFileTypes: true })).map((entry) => ({
          name: entry.name,
          kind: entry.isDirectory()
            ? ("directory" as const)
            : entry.isFile()
              ? ("file" as const)
              : entry.isSymbolicLink()
                ? ("symlink" as const)
                : ("other" as const),
        })),
      catch: filesystemError,
    }),
  metadata: (path) =>
    Effect.tryPromise({
      try: async () => {
        const metadata = await lstat(path);
        return {
          kind: metadataKind(metadata),
          mode: metadata.mode & 0o777,
          modifiedMilliseconds: metadata.mtimeMs,
          size: metadata.size,
        };
      },
      catch: filesystemError,
    }),
  makeDirectory: (path) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(path, { recursive: true });
      },
      catch: filesystemError,
    }),
  createExclusiveFile: (path, contents) =>
    Effect.tryPromise({
      try: async () => {
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          handle = await open(path, "wx", 0o600);
          await handle.writeFile(contents, "utf8");
          await handle.close();
          handle = undefined;
          return true;
        } catch (cause) {
          if (handle !== undefined) {
            await handle.close().catch(() => undefined);
            await rm(path, { force: true }).catch(() => undefined);
          }
          if (
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            cause.code === "EEXIST"
          ) {
            return false;
          }
          throw cause;
        }
      },
      catch: filesystemError,
    }),
  writeText: (path, contents) =>
    Effect.tryPromise({
      try: () => writeFile(path, contents, "utf8"),
      catch: filesystemError,
    }),
  appendText: (path, contents) =>
    Effect.tryPromise({
      try: () => appendFile(path, contents, "utf8"),
      catch: filesystemError,
    }),
  writeBytes: (path, contents) =>
    Effect.tryPromise({
      try: () => writeFile(path, contents),
      catch: filesystemError,
    }),
  createSymlink: (target, path) =>
    Effect.tryPromise({
      try: () => symlink(target, path),
      catch: filesystemError,
    }),
  setFileMetadata: (path, mode, modifiedMilliseconds) =>
    Effect.tryPromise({
      try: async () => {
        await chmod(path, mode & 0o777);
        const modified = new Date(modifiedMilliseconds);
        await utimes(path, modified, modified);
      },
      catch: filesystemError,
    }),
  rename: (source, destination) =>
    Effect.tryPromise({
      try: () => rename(source, destination),
      catch: filesystemError,
    }),
  remove: (path) =>
    Effect.tryPromise({
      try: () => rm(path, { force: true, recursive: true }),
      catch: filesystemError,
    }),
  realPath: (path) =>
    Effect.tryPromise({
      try: () => realpath(path),
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

interface ChildProcessIo {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly onceClose: (listener: (exitCode: number | null) => void) => void;
  readonly onceError: (listener: (cause: Error) => void) => void;
}

export const collectChildProcessOutput = (
  child: ChildProcessIo,
  command: string,
  stdin: string | undefined,
  inheritStdin = false,
  onOutputChunk?: OutputChunkHandler,
  maxCapturedOutputCharacters?: number,
): Effect.Effect<
  {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly combinedOutput: string;
  },
  ProcessExecutionError
> =>
  Effect.async((resume) => {
    let settled = false;
    let closeReceived = false;
    let closeExitCode: number | null = null;
    let outputSinkPending = false;
    let closeCompletionScheduled = false;
    let stdout = "";
    let stderr = "";
    let combinedOutput = "";
    const appendCapturedOutput = (current: string, chunk: string): string => {
      const output = current + chunk;
      return maxCapturedOutputCharacters === undefined
        ? output
        : output.slice(
            Math.max(0, output.length - maxCapturedOutputCharacters),
          );
    };
    const stopInheritedInput = () => {
      if (inheritStdin) {
        process.stdin.unpipe(child.stdin);
      }
    };
    const fail = (cause: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      stopInheritedInput();
      resume(Effect.fail(processExecutionError(command, cause)));
    };
    const completeClose = () => {
      if (settled || !closeReceived || outputSinkPending) return;
      settled = true;
      stopInheritedInput();
      resume(
        Effect.succeed({
          exitCode: closeExitCode ?? 1,
          stdout,
          stderr,
          combinedOutput,
        }),
      );
    };
    const completeCloseAfterBufferedOutput = () => {
      if (
        settled ||
        !closeReceived ||
        outputSinkPending ||
        closeCompletionScheduled
      ) {
        return;
      }
      closeCompletionScheduled = true;
      setImmediate(() => {
        closeCompletionScheduled = false;
        completeClose();
      });
    };
    const emitOutput = (chunk: string) => {
      if (onOutputChunk === undefined) return;
      try {
        const completion: unknown = onOutputChunk(chunk);
        if (
          completion === null ||
          (typeof completion !== "object" &&
            typeof completion !== "function") ||
          typeof (completion as PromiseLike<void>).then !== "function"
        ) {
          return;
        }
        outputSinkPending = true;
        child.stdout.pause();
        child.stderr.pause();
        Promise.resolve(completion).then(() => {
          outputSinkPending = false;
          if (settled) return;
          child.stdout.resume();
          child.stderr.resume();
          completeCloseAfterBufferedOutput();
        }, fail);
      } catch (cause) {
        fail(cause);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      stdout = appendCapturedOutput(stdout, chunk);
      combinedOutput = appendCapturedOutput(combinedOutput, chunk);
      emitOutput(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      if (settled) return;
      stderr = appendCapturedOutput(stderr, chunk);
      combinedOutput = appendCapturedOutput(combinedOutput, chunk);
      emitOutput(chunk);
    });
    child.onceError(fail);
    child.stdin.on("error", fail);
    child.stdout.once("error", fail);
    child.stderr.once("error", fail);
    child.onceClose((exitCode) => {
      closeReceived = true;
      closeExitCode = exitCode;
      if (outputSinkPending) {
        return;
      }
      completeClose();
    });
    if (inheritStdin) {
      process.stdin.pipe(child.stdin);
    } else if (stdin === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(stdin);
    }
    return Effect.sync(() => {
      settled = true;
      stopInheritedInput();
      child.stdout.pause();
      child.stderr.pause();
    });
  });

const waitForInheritedChild = (
  child: Pick<ChildProcessIo, "onceClose" | "onceError">,
  command: string,
): Effect.Effect<
  {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly combinedOutput: string;
  },
  ProcessExecutionError
> =>
  Effect.async((resume) => {
    let settled = false;
    child.onceError((cause) => {
      if (settled) return;
      settled = true;
      resume(Effect.fail(processExecutionError(command, cause)));
    });
    child.onceClose((exitCode) => {
      if (settled) return;
      settled = true;
      resume(
        Effect.succeed({
          exitCode: exitCode ?? 1,
          stdout: "",
          stderr: "",
          combinedOutput: "",
        }),
      );
    });
  });

const processLayer = Layer.succeed(ProcessService, {
  run: (request) =>
    Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          const ownsProcessGroup = process.platform !== "win32";
          const capturesOutput = request.stdio !== "inherit";
          const child = spawn(request.command, [...request.args], {
            cwd: request.cwd,
            detached: ownsProcessGroup,
            env: makeChildEnvironment(
              request.inheritEnvironment === false ? {} : process.env,
              request.env,
              process.platform,
            ),
            shell: false,
            stdio: capturesOutput ? "pipe" : "inherit",
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
            capturesOutput,
          };
        },
        catch: (cause) => processExecutionError(request.command, cause),
      }),
      ({ child, capturesOutput }) => {
        const lifecycle = {
          onceClose: (listener: (exitCode: number | null) => void) => {
            child.once("close", listener);
          },
          onceError: (listener: (cause: Error) => void) => {
            child.once("error", listener);
          },
        };
        if (!capturesOutput) {
          return waitForInheritedChild(lifecycle, request.command);
        }
        return collectChildProcessOutput(
          {
            stdin: child.stdin!,
            stdout: child.stdout!,
            stderr: child.stderr!,
            ...lifecycle,
          },
          request.command,
          request.stdin,
          false,
          request.onOutputChunk,
          request.maxCapturedOutputCharacters,
        );
      },
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
            fail(cause);
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
      return Effect.sync(() => {
        settled = true;
        stream.off("error", onError);
      });
    });

interface TerminalStream extends Writable {
  readonly isTTY?: boolean;
}

export const makeTerminalOperations = (
  stdout: TerminalStream,
  stderr: TerminalStream,
  noColor: () => string | undefined,
): TerminalOperations => ({
  writeStdout: makeTerminalWriter(stdout),
  writeStderr: makeTerminalWriter(stderr),
  stdoutColorEnabled: Effect.sync(
    () => noColor() === undefined && stdout.isTTY === true,
  ),
  stderrColorEnabled: Effect.sync(
    () => noColor() === undefined && stderr.isTTY === true,
  ),
});

const terminalLayer = Layer.succeed(
  TerminalService,
  makeTerminalOperations(
    process.stdout,
    process.stderr,
    () => process.env.NO_COLOR,
  ),
);

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

const compressionError = (cause: unknown): BoundaryError =>
  new BoundaryError({
    boundary: "compression",
    message: String(cause),
    retryable: false,
  });

class HttpResponseBodyLimitError extends Error {}

const readResponseBody = async (
  response: Response,
  maxBytes: number | undefined,
): Promise<Uint8Array> => {
  const contentLength = response.headers.get("content-length");
  if (
    maxBytes !== undefined &&
    contentLength !== null &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > maxBytes
  ) {
    await response.body?.cancel();
    throw new HttpResponseBodyLimitError(
      `HTTP response body exceeds the ${maxBytes} byte limit`,
    );
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.length;
      if (maxBytes !== undefined && length > maxBytes) {
        await reader.cancel();
        throw new HttpResponseBodyLimitError(
          `HTTP response body exceeds the ${maxBytes} byte limit`,
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
};

const compressionLayer = Layer.succeed(CompressionService, {
  compressZstd: (contents) =>
    Effect.tryPromise({
      try: async () =>
        new Uint8Array(await promisify(zstdCompress)(Buffer.from(contents))),
      catch: compressionError,
    }),
  decompressZstd: (contents, maxOutputBytes) =>
    Effect.tryPromise({
      try: async () =>
        new Uint8Array(
          await promisify(zstdDecompress)(
            Buffer.from(contents),
            maxOutputBytes === undefined
              ? undefined
              : { maxOutputLength: maxOutputBytes },
          ),
        ),
      catch: compressionError,
    }),
});

const httpLayer = Layer.succeed(HttpService, {
  request: (request) =>
    Effect.tryPromise({
      try: async (interruptionSignal) => {
        const controller = new AbortController();
        const timeout =
          request.timeoutMilliseconds === undefined ||
          request.timeoutMilliseconds === 0
            ? undefined
            : setTimeout(() => controller.abort(), request.timeoutMilliseconds);
        const signal =
          timeout === undefined
            ? interruptionSignal
            : AbortSignal.any([interruptionSignal, controller.signal]);
        try {
          const response = await fetch(request.url, {
            method: request.method,
            headers: request.headers,
            body:
              request.body === undefined
                ? undefined
                : typeof request.body === "string"
                  ? request.body
                  : Buffer.from(request.body),
            redirect: "follow",
            signal,
          });
          return {
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body: await readResponseBody(
              response,
              request.maxResponseBodyBytes,
            ),
          };
        } finally {
          if (timeout !== undefined) {
            clearTimeout(timeout);
          }
        }
      },
      catch: (cause) =>
        new BoundaryError({
          boundary: "http",
          message: String(cause),
          retryable: !(cause instanceof HttpResponseBodyLimitError),
        }),
    }),
});

const signingLayer = Layer.succeed(SigningService, {
  hmacSha256: (key, contents) =>
    Effect.try({
      try: () => createHmac("sha256", key).update(contents).digest("hex"),
      catch: (cause) =>
        new BoundaryError({
          boundary: "signing",
          message: String(cause),
          retryable: false,
        }),
    }),
  equal: (left, right) =>
    Effect.sync(() => {
      const leftBytes = Buffer.from(left);
      const rightBytes = Buffer.from(right);
      return (
        leftBytes.length === rightBytes.length &&
        timingSafeEqual(leftBytes, rightBytes)
      );
    }),
});

const digestLayer = Layer.succeed(DigestService, {
  gitBlobSha1: (contents) =>
    Effect.try({
      try: () =>
        createHash("sha1")
          .update(`blob ${contents.length}\0`)
          .update(contents)
          .digest("hex"),
      catch: (cause) =>
        new BoundaryError({
          boundary: "digest",
          message: String(cause),
          retryable: false,
        }),
    }),
});

const concurrencyLayer = Layer.succeed(ConcurrencyService, {
  availableParallelism: Effect.sync(availableParallelism),
});

export const nodeFoundationLayer = Layer.mergeAll(
  fileSystemLayer,
  processLayer,
  environmentLayer,
  terminalLayer,
  clockLayer,
  randomnessLayer,
  compressionLayer,
  httpLayer,
  signingLayer,
  digestLayer,
  Layer.succeed(GitService, boundaryFailure("git")),
  Layer.succeed(PackageManagerService, boundaryFailure("package-manager")),
  Layer.succeed(SignalService, boundaryFailure("signals")),
  concurrencyLayer,
  Layer.succeed(CredentialService, boundaryFailure("credentials")),
  Layer.succeed(CacheService, boundaryFailure("cache")),
  Layer.succeed(DaemonService, boundaryFailure("daemon")),
  Layer.succeed(TelemetryService, boundaryFailure("telemetry")),
  Layer.succeed(ObservabilityService, boundaryFailure("observability")),
  deterministicRetryLayer,
);
