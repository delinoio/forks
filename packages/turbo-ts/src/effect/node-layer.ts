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
import { createReadStream, createWriteStream } from "node:fs";
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
import { Readable, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createZstdDecompress, zstdCompress, zstdDecompress } from "node:zlib";
import { Cause, Effect, Exit, Layer, Option, Ref, Stream } from "effect";
import { createXxhash64 } from "../hash/xxhash64.js";
import { BoundaryError, ProcessExecutionError } from "./errors.js";
import {
  type BinaryExecutionRequest,
  CacheService,
  ClockService,
  CompressionService,
  ConcurrencyService,
  CredentialService,
  DaemonService,
  DigestService,
  deterministicRetryLayer,
  EnvironmentService,
  type ExecutionRequest,
  ExitStatusService,
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
  readonly windowsProcessTracker: WindowsProcessTracker | undefined;
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

interface SpawnInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly windowsVerbatimArguments: boolean;
}

const windowsPackageManagerCommands = new Set(["npm", "pnpm", "yarn"]);
const windowsCommandFilePattern = /\.(?:bat|cmd)$/i;
const windowsCommandMetacharacters = /([()\][%!^"`<>&|;, *?])/g;

// Windows cannot execute command files through spawn without a command
// interpreter. Keep this adapter limited to .cmd/.bat files and escape every
// argv token; it can be removed if Node gains direct, argv-preserving support.
const escapeWindowsCommandMetacharacters = (value: string): string =>
  value.replace(windowsCommandMetacharacters, "^$1");

const quoteWindowsCommandArgument = (value: string): string => {
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += `${"\\".repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
      continue;
    }
    quoted += `${"\\".repeat(backslashes)}${character}`;
    backslashes = 0;
  }
  quoted += `${"\\".repeat(backslashes * 2)}"`;
  return quoted;
};

export const resolveSpawnInvocation = (
  command: string,
  args: ReadonlyArray<string>,
  platform: NodeJS.Platform,
  commandInterpreter = "cmd.exe",
): SpawnInvocation => {
  if (platform !== "win32") {
    return { command, args, windowsVerbatimArguments: false };
  }
  const commandName = command.toLowerCase();
  const resolvedCommand = windowsPackageManagerCommands.has(commandName)
    ? `${command}.cmd`
    : command;
  if (!windowsCommandFilePattern.test(resolvedCommand)) {
    return {
      command: resolvedCommand,
      args,
      windowsVerbatimArguments: false,
    };
  }
  const escapedArguments = args.map((argument) => {
    const escaped = escapeWindowsCommandMetacharacters(
      quoteWindowsCommandArgument(argument),
    );
    return escapeWindowsCommandMetacharacters(escaped);
  });
  const commandLine = [
    escapeWindowsCommandMetacharacters(resolvedCommand),
    ...escapedArguments,
  ].join(" ");
  return {
    command: commandInterpreter,
    args: ["/d", "/s", "/v:off", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
};

const configuredWindowsCommandInterpreter = (): string =>
  Object.entries(process.env).find(
    ([name, value]) => name.toLowerCase() === "comspec" && value !== undefined,
  )?.[1] ?? "cmd.exe";

export const windowsProcessTreeTerminationInvocation = (
  processId: number,
): { readonly command: string; readonly args: ReadonlyArray<string> } => ({
  command: "taskkill.exe",
  args: ["/pid", String(processId), "/t", "/f"],
});

interface WindowsProcessRecord {
  readonly generation: number;
  readonly processId: number;
  readonly parentProcessId: number | undefined;
  parentGeneration: number | undefined;
  live: boolean;
  tracked: boolean;
}

export interface WindowsProcessTreeState {
  readonly registerRoot: (processId: number) => void;
  readonly recordStart: (processId: number, parentProcessId: number) => void;
  readonly recordStop: (processId: number) => void;
  readonly liveDescendantProcessIds: () => ReadonlyArray<number>;
}

export const makeWindowsProcessTreeState = (): WindowsProcessTreeState => {
  let nextGeneration = 1;
  let rootGeneration: number | undefined;
  const records = new Map<number, WindowsProcessRecord>();
  const latestGenerationByProcessId = new Map<number, number>();
  const pendingChildrenByParentProcessId = new Map<number, Set<number>>();

  const propagateTracked = (generation: number): void => {
    const pending = [...records.values()].filter(
      (record) => record.parentGeneration === generation,
    );
    for (const child of pending) {
      if (!child.tracked) {
        child.tracked = true;
        propagateTracked(child.generation);
      }
    }
  };

  const attachPendingChildren = (record: WindowsProcessRecord): void => {
    const pending = pendingChildrenByParentProcessId.get(record.processId);
    if (pending === undefined) return;
    pendingChildrenByParentProcessId.delete(record.processId);
    for (const childGeneration of pending) {
      const child = records.get(childGeneration);
      if (child === undefined || !child.live) continue;
      child.parentGeneration = record.generation;
      if (record.tracked) {
        child.tracked = true;
        propagateTracked(child.generation);
      }
    }
  };

  const recordStart = (
    processId: number,
    parentProcessId: number,
  ): WindowsProcessRecord => {
    const currentGeneration = latestGenerationByProcessId.get(processId);
    const current =
      currentGeneration === undefined
        ? undefined
        : records.get(currentGeneration);
    if (current?.live === true) {
      return current;
    }
    const parentGeneration = latestGenerationByProcessId.get(parentProcessId);
    const parent =
      parentGeneration === undefined
        ? undefined
        : records.get(parentGeneration);
    const record: WindowsProcessRecord = {
      generation: nextGeneration,
      processId,
      parentProcessId,
      parentGeneration: parent?.live === true ? parent.generation : undefined,
      live: true,
      tracked: parent?.live === true && parent.tracked,
    };
    nextGeneration += 1;
    records.set(record.generation, record);
    latestGenerationByProcessId.set(processId, record.generation);
    if (record.parentGeneration === undefined) {
      const pending =
        pendingChildrenByParentProcessId.get(parentProcessId) ?? new Set();
      pending.add(record.generation);
      pendingChildrenByParentProcessId.set(parentProcessId, pending);
    }
    attachPendingChildren(record);
    return record;
  };

  return {
    registerRoot: (processId) => {
      const currentGeneration = latestGenerationByProcessId.get(processId);
      const current =
        currentGeneration === undefined
          ? undefined
          : records.get(currentGeneration);
      const root =
        current?.live === true ? current : recordStart(processId, process.ppid);
      root.tracked = true;
      rootGeneration = root.generation;
      propagateTracked(root.generation);
    },
    recordStart: (processId, parentProcessId) => {
      recordStart(processId, parentProcessId);
    },
    recordStop: (processId) => {
      const generation = latestGenerationByProcessId.get(processId);
      const record =
        generation === undefined ? undefined : records.get(generation);
      if (record !== undefined) record.live = false;
    },
    liveDescendantProcessIds: () =>
      [...records.values()]
        .filter(
          (record) =>
            record.live &&
            record.tracked &&
            record.generation !== rootGeneration,
        )
        .sort((left, right) => right.generation - left.generation)
        .map((record) => record.processId),
  };
};

interface WindowsProcessTracker {
  readonly state: WindowsProcessTreeState;
  readonly failed: () => boolean;
  readonly waitForActivityToSettle: (
    minimumMilliseconds: number,
    maximumMilliseconds: number,
  ) => Promise<void>;
  readonly close: () => Promise<void>;
}

const windowsProcessTrackerStartupTimeoutMilliseconds = 5_000;
const windowsProcessTrackerQuietMilliseconds = 50;
const windowsProcessTrackerInitialDrainMilliseconds = 250;

// Node does not expose Windows job objects. Keep a scoped process-event
// subscriber alive before task spawn so descendants remain identifiable after
// their wrapper exits. This can be removed when Node exposes equivalent
// process-tree ownership without a native runtime dependency.
const windowsProcessTrackerScript = [
  "$ErrorActionPreference = 'Stop'",
  "$start = Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -SourceIdentifier turboTsProcessStart",
  "$stop = Register-CimIndicationEvent -ClassName Win32_ProcessStopTrace -SourceIdentifier turboTsProcessStop",
  "[Console]::Out.WriteLine('READY')",
  "while ($true) {",
  "  $event = Wait-Event",
  "  $value = $event.SourceEventArgs.NewEvent",
  "  if ($event.SourceIdentifier -eq 'turboTsProcessStart') {",
  "    [Console]::Out.WriteLine(('S`t{0}`t{1}' -f $value.ProcessID, $value.ParentProcessID))",
  "  } elseif ($event.SourceIdentifier -eq 'turboTsProcessStop') {",
  "    [Console]::Out.WriteLine(('X`t{0}' -f $value.ProcessID))",
  "  }",
  "  Remove-Event -EventIdentifier $event.EventIdentifier",
  "}",
].join("\n");

const startWindowsProcessTracker = (): Promise<WindowsProcessTracker> =>
  new Promise((resolve, reject) => {
    const state = makeWindowsProcessTreeState();
    let output = "";
    let ready = false;
    let closed = false;
    let failed = false;
    let activity = 0;
    let settled = false;
    let tracker: ChildProcess;
    try {
      tracker = spawn(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          windowsProcessTrackerScript,
        ],
        {
          shell: false,
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        },
      );
    } catch (cause) {
      reject(cause);
      return;
    }
    const startupTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      tracker.kill();
      reject(new Error("Windows process tracker did not become ready"));
    }, windowsProcessTrackerStartupTimeoutMilliseconds);
    const closePromise = new Promise<void>((closeResolve) => {
      tracker.once("close", () => {
        closed = true;
        failed = ready;
        closeResolve();
        if (!settled) {
          settled = true;
          clearTimeout(startupTimeout);
          reject(new Error("Windows process tracker exited before startup"));
        }
      });
    });
    tracker.once("error", (cause) => {
      failed = true;
      if (!settled) {
        settled = true;
        clearTimeout(startupTimeout);
        reject(cause);
      }
    });
    const processLine = (line: string): void => {
      if (line === "READY") {
        ready = true;
        if (!settled) {
          settled = true;
          clearTimeout(startupTimeout);
          resolve({
            state,
            failed: () => failed,
            waitForActivityToSettle: async (
              minimumMilliseconds,
              maximumMilliseconds,
            ) => {
              const started = Date.now();
              let observedActivity = activity;
              let quietSince = started;
              while (Date.now() - started < maximumMilliseconds) {
                await new Promise((settleActivity) =>
                  setTimeout(settleActivity, 10),
                );
                if (activity !== observedActivity) {
                  observedActivity = activity;
                  quietSince = Date.now();
                }
                if (
                  Date.now() - started >= minimumMilliseconds &&
                  Date.now() - quietSince >=
                    windowsProcessTrackerQuietMilliseconds
                ) {
                  return;
                }
              }
            },
            close: async () => {
              if (!closed) tracker.kill();
              await closePromise;
            },
          });
        }
        return;
      }
      const [kind, processIdText, parentProcessIdText] = line.split("\t");
      const processId = Number(processIdText);
      if (!Number.isSafeInteger(processId) || processId <= 0) return;
      if (kind === "S") {
        const parentProcessId = Number(parentProcessIdText);
        if (!Number.isSafeInteger(parentProcessId) || parentProcessId < 0) {
          return;
        }
        state.recordStart(processId, parentProcessId);
        activity += 1;
      } else if (kind === "X") {
        state.recordStop(processId);
        activity += 1;
      }
    };
    tracker.stdout!.on("data", (chunk: Buffer | string) => {
      output += String(chunk);
      let lineBreak = output.indexOf("\n");
      while (lineBreak !== -1) {
        const line = output.slice(0, lineBreak).replace(/\r$/, "");
        output = output.slice(lineBreak + 1);
        processLine(line);
        lineBreak = output.indexOf("\n");
      }
    });
  });

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

const terminateWindowsProcessTree = (processId: number): Promise<boolean> =>
  new Promise((resolve) => {
    const invocation = windowsProcessTreeTerminationInvocation(processId);
    let settled = false;
    const complete = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    let termination: ChildProcess;
    try {
      termination = spawn(invocation.command, [...invocation.args], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    const timeout = setTimeout(() => {
      termination.kill();
      complete(false);
    }, gracefulTerminationTimeoutMilliseconds);
    termination.once("error", () => complete(false));
    termination.once("close", (exitCode) => complete(exitCode === 0));
  });

const isProcessGroupRunning = (processGroupId: number): boolean => {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (cause) {
    if (isNoSuchProcessError(cause)) {
      return false;
    }
    throw cause;
  }
};

const waitForProcessGroupExitUntil = async (
  processGroupId: number,
  timeoutMilliseconds: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMilliseconds;
  while (isProcessGroupRunning(processGroupId)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return false;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(10, remaining)),
    );
  }
  return true;
};

const terminateChild = ({
  child,
  closed,
  isClosed,
  processGroupId,
  windowsProcessTracker,
  capturesOutput,
}: ScopedChildProcess): Effect.Effect<void> =>
  Effect.promise(async () => {
    const scopedChild = {
      child,
      closed,
      isClosed,
      processGroupId,
      windowsProcessTracker,
      capturesOutput,
    };
    let windowsTreeCleanupFailed = false;
    if (processGroupId !== undefined) {
      signalChildProcess(scopedChild, "SIGTERM");
      const groupClosedGracefully = await waitForProcessGroupExitUntil(
        processGroupId,
        gracefulTerminationTimeoutMilliseconds,
      );
      if (!groupClosedGracefully) {
        signalChildProcess(scopedChild, "SIGKILL");
      }
    } else if (windowsProcessTracker !== undefined) {
      try {
        await windowsProcessTracker.waitForActivityToSettle(
          windowsProcessTrackerInitialDrainMilliseconds,
          gracefulTerminationTimeoutMilliseconds,
        );
        const processIds = [
          ...(!isClosed() && child.pid !== undefined ? [child.pid] : []),
          ...windowsProcessTracker.state.liveDescendantProcessIds(),
        ];
        for (const processId of new Set(processIds)) {
          await terminateWindowsProcessTree(processId);
        }
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
        await windowsProcessTracker.waitForActivityToSettle(
          0,
          windowsProcessTrackerQuietMilliseconds * 2,
        );
        windowsTreeCleanupFailed ||=
          windowsProcessTracker.failed() ||
          windowsProcessTracker.state.liveDescendantProcessIds().length > 0;
      } finally {
        await windowsProcessTracker.close();
      }
    } else if (!isClosed()) {
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
    if (windowsTreeCleanupFailed) {
      throw new Error("failed to terminate the complete Windows process tree");
    }
  });

const fileSystemLayer = Layer.succeed(FileSystemService, {
  readText: (path) =>
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: filesystemError,
    }),
  readTextChunks: (path) =>
    Stream.acquireRelease(
      Effect.sync(() =>
        createReadStream(path, {
          encoding: "utf8",
          highWaterMark: 64 * 1024,
        }),
      ),
      (stream) => Effect.sync(() => stream.destroy()),
    ).pipe(
      Stream.flatMap((stream) =>
        Stream.fromAsyncIterable(stream, filesystemError),
      ),
      Stream.map((chunk) => String(chunk)),
    ),
  readBytes: (path) =>
    Effect.tryPromise({
      try: async () => new Uint8Array(await readFile(path)),
      catch: filesystemError,
    }),
  readBytesRange: (path, offset, length) =>
    Effect.tryPromise({
      try: async () => {
        const handle = await open(path, "r");
        try {
          const contents = Buffer.alloc(length);
          let total = 0;
          while (total < length) {
            const result = await handle.read(
              contents,
              total,
              length - total,
              offset + total,
            );
            if (result.bytesRead === 0) break;
            total += result.bytesRead;
          }
          return new Uint8Array(contents.subarray(0, total));
        } finally {
          await handle.close();
        }
      },
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
  copyBytesRange: (source, offset, length, destination) =>
    Effect.tryPromise({
      try: async (signal) => {
        let copied = 0;
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            copied += chunk.length;
            callback(null, chunk);
          },
        });
        const input =
          length === 0
            ? Readable.from([])
            : createReadStream(source, {
                start: offset,
                end: offset + length - 1,
                highWaterMark: 64 * 1024,
              });
        await pipeline(input, counter, createWriteStream(destination), {
          signal,
        });
        if (copied !== length) {
          throw new TypeError(
            `source range is truncated: expected ${length} bytes, copied ${copied}`,
          );
        }
      },
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
    let pendingOutputSinks = 0;
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
      if (settled || !closeReceived || pendingOutputSinks > 0) return;
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
        pendingOutputSinks > 0 ||
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
        pendingOutputSinks += 1;
        child.stdout.pause();
        child.stderr.pause();
        Promise.resolve(completion).then(() => {
          pendingOutputSinks -= 1;
          if (settled) return;
          if (pendingOutputSinks === 0) {
            child.stdout.resume();
            child.stderr.resume();
            completeCloseAfterBufferedOutput();
          }
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
      if (pendingOutputSinks > 0) {
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

export const collectChildProcessBytes = (
  child: ChildProcessIo,
  command: string,
  stdin: string | undefined,
): Effect.Effect<
  {
    readonly exitCode: number;
    readonly stdout: Uint8Array;
    readonly stderr: Uint8Array;
  },
  ProcessExecutionError
> =>
  Effect.async((resume) => {
    let settled = false;
    let closeReceived = false;
    let closeExitCode: number | null = null;
    let stdoutEnded = child.stdout.readableEnded;
    let stderrEnded = child.stderr.readableEnded;
    const stdout: Array<Buffer> = [];
    const stderr: Array<Buffer> = [];
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      resume(Effect.fail(processExecutionError(command, cause)));
    };
    const complete = () => {
      if (settled || !closeReceived || !stdoutEnded || !stderrEnded) return;
      settled = true;
      resume(
        Effect.succeed({
          exitCode: closeExitCode ?? 1,
          stdout: new Uint8Array(Buffer.concat(stdout)),
          stderr: new Uint8Array(Buffer.concat(stderr)),
        }),
      );
    };
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (!settled) stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (!settled) stderr.push(Buffer.from(chunk));
    });
    child.onceError(fail);
    child.stdin.on("error", fail);
    child.stdout.once("error", fail);
    child.stderr.once("error", fail);
    child.stdout.once("end", () => {
      stdoutEnded = true;
      complete();
    });
    child.stderr.once("end", () => {
      stderrEnded = true;
      complete();
    });
    child.onceClose((exitCode) => {
      closeReceived = true;
      closeExitCode = exitCode;
      complete();
    });
    if (stdin === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(stdin);
    }
    return Effect.sync(() => {
      settled = true;
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

const acquireChildProcess = (
  request: ExecutionRequest | BinaryExecutionRequest,
  capturesOutput: boolean,
): Effect.Effect<ScopedChildProcess, ProcessExecutionError> =>
  Effect.tryPromise({
    try: async () => {
      const ownsProcessGroup = process.platform !== "win32";
      const windowsProcessTracker = ownsProcessGroup
        ? undefined
        : await startWindowsProcessTracker();
      const invocation = resolveSpawnInvocation(
        request.command,
        request.args,
        process.platform,
        configuredWindowsCommandInterpreter(),
      );
      let child: ChildProcess;
      try {
        child = spawn(invocation.command, [...invocation.args], {
          cwd: request.cwd,
          detached: ownsProcessGroup,
          env: makeChildEnvironment(
            request.inheritEnvironment === false ? {} : process.env,
            request.env,
            process.platform,
          ),
          shell: false,
          stdio: capturesOutput ? "pipe" : "inherit",
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        });
      } catch (cause) {
        await windowsProcessTracker?.close();
        throw cause;
      }
      if (windowsProcessTracker !== undefined) {
        if (child.pid === undefined) {
          await windowsProcessTracker.close();
          throw new Error("Windows task process has no process identifier");
        }
        windowsProcessTracker.state.registerRoot(child.pid);
      }
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
        windowsProcessTracker,
        capturesOutput,
      };
    },
    catch: (cause) => processExecutionError(request.command, cause),
  });

const processLayer = Layer.succeed(ProcessService, {
  run: (request) =>
    Effect.acquireUseRelease(
      acquireChildProcess(request, request.stdio !== "inherit"),
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
  runBytes: (request) =>
    Effect.acquireUseRelease(
      acquireChildProcess(request, true),
      ({ child }) =>
        collectChildProcessBytes(
          {
            stdin: child.stdin!,
            stdout: child.stdout!,
            stderr: child.stderr!,
            onceClose: (listener) => child.once("close", listener),
            onceError: (listener) => child.once("error", listener),
          },
          request.command,
          request.stdin,
        ),
      terminateChild,
    ),
});

const environmentLayer = Layer.succeed(EnvironmentService, {
  argv: Effect.sync(() => [...process.argv]),
  cwd: Effect.sync(() => process.cwd()),
  platform: Effect.succeed(process.platform),
  get: (name) => Effect.sync(() => process.env[name]),
  entries: Effect.sync(() => ({ ...process.env })),
});

const exitStatusLayer = Layer.succeed(ExitStatusService, {
  set: (code) =>
    Effect.sync(() => {
      process.exitCode = code;
    }),
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

type TerminalStream = Writable;

export const makeTerminalOperations = (
  stdout: TerminalStream,
  stderr: TerminalStream,
  noColor: () => string | undefined,
): TerminalOperations => ({
  writeStdout: makeTerminalWriter(stdout),
  writeStderr: makeTerminalWriter(stderr),
  stdoutColorEnabled: Effect.sync(() => noColor() === undefined),
  stderrColorEnabled: Effect.sync(() => noColor() === undefined),
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

class CompressionOutputLimitError extends Error {}

const validateResponseContentLength = async (
  response: Response,
  maxBytes: number | undefined,
): Promise<void> => {
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
};

const readResponseBody = async (
  response: Response,
  maxBytes: number | undefined,
): Promise<Uint8Array> => {
  await validateResponseContentLength(response, maxBytes);
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

const writeResponseBodyToFile = async (
  response: Response,
  destination: string,
  maxBytes: number | undefined,
  signal: AbortSignal,
): Promise<void> => {
  await validateResponseContentLength(response, maxBytes);
  if (response.body === null) {
    await writeFile(destination, new Uint8Array());
    return;
  }
  let length = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      length += chunk.length;
      if (maxBytes !== undefined && length > maxBytes) {
        callback(
          new HttpResponseBodyLimitError(
            `HTTP response body exceeds the ${maxBytes} byte limit`,
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      limiter,
      createWriteStream(destination, { flags: "w" }),
      { signal },
    );
  } catch (cause) {
    await rm(destination, { force: true }).catch(() => undefined);
    throw cause;
  }
};

const decompressZstdStreamToFile = async (
  source: Readable,
  destination: string,
  maxOutputBytes: number | undefined,
  signal: AbortSignal,
): Promise<void> => {
  let outputBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      outputBytes += chunk.length;
      if (maxOutputBytes !== undefined && outputBytes > maxOutputBytes) {
        callback(
          new CompressionOutputLimitError(
            `decompressed output exceeds the ${maxOutputBytes} byte limit`,
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    source,
    createZstdDecompress(),
    limiter,
    createWriteStream(destination, { flags: "wx" }),
    { signal },
  );
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
  decompressZstdToFile: (contents, destination, maxOutputBytes) =>
    Effect.tryPromise({
      try: (signal) =>
        decompressZstdStreamToFile(
          Readable.from([Buffer.from(contents)]),
          destination,
          maxOutputBytes,
          signal,
        ),
      catch: compressionError,
    }),
  decompressZstdFileToFile: (source, destination, maxOutputBytes) =>
    Effect.tryPromise({
      try: (signal) =>
        decompressZstdStreamToFile(
          createReadStream(source),
          destination,
          maxOutputBytes,
          signal,
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
  downloadToFile: (request, destination) =>
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
            redirect: "follow",
            signal,
          });
          await writeResponseBodyToFile(
            response,
            destination,
            request.maxResponseBodyBytes,
            signal,
          );
          return {
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
          };
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
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
  hmacSha256File: (key, path) =>
    Effect.tryPromise({
      try: async (signal) => {
        const hmac = createHmac("sha256", key);
        const stream = createReadStream(path, { signal });
        try {
          for await (const chunk of stream) hmac.update(chunk);
        } finally {
          stream.destroy();
        }
        return hmac.digest("hex");
      },
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
  gitBlobSha1File: (path) =>
    Effect.scoped(
      Effect.acquireRelease(
        Effect.tryPromise({
          try: () => open(path, "r"),
          catch: (cause) =>
            new BoundaryError({
              boundary: "digest",
              message: String(cause),
              retryable: false,
            }),
        }),
        (handle) => Effect.promise(() => handle.close()).pipe(Effect.ignore),
      ).pipe(
        Effect.flatMap((handle) =>
          Effect.tryPromise({
            try: async (signal) => {
              const metadata = await handle.stat();
              const hash = createHash("sha1").update(`blob ${metadata.size}\0`);
              const stream = handle.createReadStream({
                autoClose: false,
                signal,
              });
              let bytesRead = 0;
              try {
                for await (const chunk of stream) {
                  bytesRead += chunk.length;
                  hash.update(chunk);
                }
              } finally {
                stream.destroy();
              }
              if (bytesRead !== metadata.size) {
                throw new Error("file size changed while hashing");
              }
              return hash.digest("hex");
            },
            catch: (cause) =>
              new BoundaryError({
                boundary: "digest",
                message: String(cause),
                retryable: false,
              }),
          }),
        ),
      ),
    ),
  xxhash64File: (path) =>
    Effect.scoped(
      Effect.acquireRelease(
        Effect.tryPromise({
          try: () => open(path, "r"),
          catch: (cause) =>
            new BoundaryError({
              boundary: "digest",
              message: String(cause),
              retryable: false,
            }),
        }),
        (handle) => Effect.promise(() => handle.close()).pipe(Effect.ignore),
      ).pipe(
        Effect.flatMap((handle) =>
          Effect.tryPromise({
            try: async (signal) => {
              const metadata = await handle.stat();
              const hash = createXxhash64();
              const stream = handle.createReadStream({
                autoClose: false,
                signal,
              });
              let bytesRead = 0;
              try {
                for await (const chunk of stream) {
                  bytesRead += chunk.length;
                  hash.update(chunk);
                }
              } finally {
                stream.destroy();
              }
              if (bytesRead !== metadata.size) {
                throw new Error("file size changed while hashing");
              }
              return hash.digest().toString(16).padStart(16, "0");
            },
            catch: (cause) =>
              new BoundaryError({
                boundary: "digest",
                message: String(cause),
                retryable: false,
              }),
          }),
        ),
      ),
    ),
});

const concurrencyLayer = Layer.succeed(ConcurrencyService, {
  availableParallelism: Effect.sync(availableParallelism),
});

export const nodeFoundationLayer = Layer.mergeAll(
  fileSystemLayer,
  processLayer,
  environmentLayer,
  exitStatusLayer,
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
