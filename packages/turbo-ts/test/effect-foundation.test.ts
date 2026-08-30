import { fstatSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "@rstest/core";
import { Effect, Fiber, Schedule, Schema } from "effect";
import { evidenceId } from "../src/compatibility/ledger.js";
import { BoundaryError, ProcessExecutionError } from "../src/effect/errors.js";
import {
  collectChildProcessOutput,
  makeChildEnvironment,
  makeTerminalOperations,
  makeTerminalWriter,
  makeWithTemporaryDirectory,
  nodeFoundationLayer,
} from "../src/effect/node-layer.js";
import {
  HttpService,
  ProcessService,
  RandomnessService,
  TerminalService,
} from "../src/effect/services.js";

const waitForTextFile = async (path: string): Promise<string> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await delay(20);
    }
  }
  throw new Error(`timed out waiting for ${path}`);
};

describe("Effect foundation", () => {
  it("schema-validates tagged boundary errors", () => {
    const error = Schema.decodeUnknownSync(BoundaryError)({
      _tag: "BoundaryError",
      boundary: "http",
      message: "offline",
      retryable: true,
    });
    expect(error.boundary).toBe("http");
  });

  it("finalizes scoped fibers when their parent scope closes", async () => {
    let finalized = false;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const resource = Effect.acquireRelease(Effect.void, () =>
            Effect.sync(() => {
              finalized = true;
            }),
          ).pipe(Effect.zipRight(Effect.never));
          yield* Effect.forkScoped(resource);
          yield* Effect.yieldNow();
        }),
      ),
    );
    expect(finalized).toBe(true);
  });

  it("uses a bounded retry schedule for transient failures", async () => {
    let attempts = 0;
    const result = await Effect.runPromise(
      Effect.suspend(() => {
        attempts += 1;
        return attempts < 3 ? Effect.fail("transient") : Effect.succeed("ok");
      }).pipe(Effect.retry(Schedule.recurs(2))),
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("reports temporary-directory cleanup failures as typed errors", async () => {
    let removedPath: string | undefined;
    const withTemporaryDirectory = makeWithTemporaryDirectory(
      () => Promise.resolve("/virtual/turbo-ts-test"),
      (path) => {
        removedPath = path;
        return Promise.reject(new Error("directory is locked"));
      },
    );
    const outcome = await Effect.runPromise(
      Effect.either(withTemporaryDirectory((path) => Effect.succeed(path))),
    );
    expect(removedPath).toBe("/virtual/turbo-ts-test");
    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      expect(outcome.left).toBeInstanceOf(BoundaryError);
      expect(outcome.left.boundary).toBe("filesystem");
    }
  });

  it("reports asynchronous terminal stream failures as typed errors", async () => {
    const stream = new Writable({
      write: (_chunk, _encoding, callback) => {
        callback(new Error("consumer closed the pipe"));
      },
    });
    const outcome = await Effect.runPromise(
      Effect.either(makeTerminalWriter(stream)("payload")),
    );
    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      expect(outcome.left).toBeInstanceOf(BoundaryError);
      expect(outcome.left.boundary).toBe("terminal");
    }
  });

  it("preserves interruption for stalled terminal writes", async () => {
    const stream = new Writable({
      write: () => {
        // Deliberately retain backpressure by never completing the write.
      },
    });
    const fiber = Effect.runFork(makeTerminalWriter(stream)("payload"));
    await Effect.runPromise(Effect.yieldNow());
    expect(stream.listenerCount("error")).toBe(1);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("determines color support from each destination stream", async () => {
    const makeStream = (isTTY: boolean) =>
      Object.assign(
        new Writable({
          write: (_chunk, _encoding, callback) => {
            callback();
          },
        }),
        { isTTY },
      );
    const stdout = makeStream(true);
    const stderr = makeStream(false);
    const terminal = makeTerminalOperations(stdout, stderr, () => undefined);
    expect(
      await Effect.runPromise(
        Effect.all([terminal.stdoutColorEnabled, terminal.stderrColorEnabled]),
      ),
    ).toEqual([true, false]);

    const noColorTerminal = makeTerminalOperations(stdout, stderr, () => "1");
    expect(
      await Effect.runPromise(
        Effect.all([
          noColorTerminal.stdoutColorEnabled,
          noColorTerminal.stderrColorEnabled,
        ]),
      ),
    ).toEqual([false, false]);
  });

  it("disables terminal color when NO_COLOR is set", async () => {
    const previousValue = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const colorEnabled = await Effect.runPromise(
        TerminalService.pipe(
          Effect.flatMap((terminal) => terminal.stderrColorEnabled),
          Effect.provide(nodeFoundationLayer),
        ),
      );
      expect(colorEnabled).toBe(false);
    } finally {
      if (previousValue === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousValue;
      }
    }
  });

  it("treats a zero HTTP timeout as unlimited", async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200);
        response.end("ok");
      }, 25);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("missing loopback address");
    }
    try {
      const response = await Effect.runPromise(
        HttpService.pipe(
          Effect.flatMap((http) =>
            http.request({
              url: `http://127.0.0.1:${address.port}`,
              method: "GET",
              timeoutMilliseconds: 0,
            }),
          ),
          Effect.provide(nodeFoundationLayer),
        ),
      );
      expect(response.status).toBe(200);
      expect(new TextDecoder().decode(response.body)).toBe("ok");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("removes undefined environment overrides before spawning", async () => {
    const environmentName = "TURBO_TS_UNDEFINED_OVERRIDE_TEST";
    const previousValue = process.env[environmentName];
    process.env[environmentName] = "inherited";
    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const processService = yield* ProcessService;
            return yield* processService.run({
              command: process.execPath,
              args: [
                "-e",
                `process.stdout.write(String(Object.hasOwn(process.env, "${environmentName}")))`,
              ],
              cwd: process.cwd(),
              env: { [environmentName]: undefined },
            });
          }),
        ).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(result).toEqual({ exitCode: 0, stdout: "false", stderr: "" });
    } finally {
      if (previousValue === undefined) {
        delete process.env[environmentName];
      } else {
        process.env[environmentName] = previousValue;
      }
    }
  });

  it("matches Windows environment keys case-insensitively", () => {
    expect(
      makeChildEnvironment(
        { KEEP: "yes", Path: "inherited" },
        { PATH: undefined },
        "win32",
      ),
    ).toEqual({ KEEP: "yes" });
    expect(
      makeChildEnvironment(
        { KEEP: "yes", Path: "inherited" },
        { PATH: "override" },
        "win32",
      ),
    ).toEqual({ KEEP: "yes", PATH: "override" });
    expect(
      makeChildEnvironment({ Path: "inherited" }, { PATH: undefined }, "linux"),
    ).toEqual({ Path: "inherited" });
  });

  it("reports synchronous spawn failures as typed errors", async () => {
    const command = `${process.execPath}\u0000`;
    const outcome = await Effect.runPromise(
      Effect.either(
        Effect.scoped(
          Effect.gen(function* () {
            const processService = yield* ProcessService;
            return yield* processService.run({
              command,
              args: [],
              cwd: process.cwd(),
            });
          }),
        ).pipe(Effect.provide(nodeFoundationLayer)),
      ),
    );
    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      expect(outcome.left).toBeInstanceOf(ProcessExecutionError);
      expect(outcome.left.command).toBe(command);
    }
  });

  it("inherits all three parent descriptors for interactive processes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-inherit-test-"));
    const resultPath = join(directory, "descriptors.json");
    const descriptorIdentity = (descriptor: number): string => {
      const metadata = fstatSync(descriptor, { bigint: true });
      return `${metadata.dev}:${metadata.ino}`;
    };
    const expected = [0, 1, 2].map(descriptorIdentity);
    const script =
      'const fs = require("node:fs"); const actual = [0, 1, 2].map((fd) => { const value = fs.fstatSync(fd, { bigint: true }); return String(value.dev) + ":" + String(value.ino); }); fs.writeFileSync(process.argv[1], JSON.stringify(actual));';
    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const processService = yield* ProcessService;
            return yield* processService.run({
              command: process.execPath,
              args: ["-e", script, resultPath],
              cwd: directory,
              stdio: "inherit",
            });
          }),
        ).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual(expected);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it(evidenceId.effectsScoped, async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-process-test-"));
    const parentPidPath = join(directory, "parent-pid");
    const workerPidPath = join(directory, "worker-pid");
    let childPid: number | undefined;
    let workerPid: number | undefined;
    try {
      const workerScript =
        'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1_000);';
      const parentScript =
        'const { spawn } = require("node:child_process"); const fs = require("node:fs"); process.on("SIGTERM", () => {}); fs.writeFileSync(process.argv[1], String(process.pid)); spawn(process.execPath, ["-e", process.argv[3], process.argv[2]], { stdio: "inherit" }); setInterval(() => {}, 1_000);';
      const directChildScript =
        'const fs = require("node:fs"); process.on("SIGTERM", () => {}); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1_000);';
      const execution = Effect.scoped(
        Effect.gen(function* () {
          const processService = yield* ProcessService;
          return yield* processService.run({
            command: process.execPath,
            args:
              process.platform === "win32"
                ? ["-e", directChildScript, parentPidPath]
                : [
                    "-e",
                    parentScript,
                    parentPidPath,
                    workerPidPath,
                    workerScript,
                  ],
            cwd: directory,
          });
        }),
      ).pipe(Effect.provide(nodeFoundationLayer));
      const fiber = Effect.runFork(execution);
      childPid = Number(await waitForTextFile(parentPidPath));
      if (process.platform !== "win32") {
        workerPid = Number(await waitForTextFile(workerPidPath));
      }
      await Effect.runPromise(Fiber.interrupt(fiber));
      expect(() => process.kill(childPid as number, 0)).toThrow();
      if (workerPid !== undefined) {
        expect(() => process.kill(workerPid as number, 0)).toThrow();
      }
    } finally {
      for (const pid of [workerPid, childPid]) {
        if (pid === undefined) {
          continue;
        }
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The scoped finalizer already terminated the expected process tree.
        }
      }
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("supervises child stdin errors inside the process Effect", async () => {
    const outcome = await Effect.runPromise(
      Effect.either(
        Effect.scoped(
          Effect.gen(function* () {
            const processService = yield* ProcessService;
            return yield* processService.run({
              command: process.execPath,
              args: [
                "-e",
                "process.stdin.destroy(); setTimeout(() => {}, 100);",
              ],
              cwd: process.cwd(),
              stdin: "x".repeat(8 * 1024 * 1024),
            });
          }),
        ).pipe(Effect.provide(nodeFoundationLayer)),
      ),
    );
    if (outcome._tag === "Left") {
      expect(outcome.left).toBeInstanceOf(ProcessExecutionError);
    } else {
      expect(typeof outcome.right.exitCode).toBe("number");
    }
  });

  it("reports child stdout and stderr stream errors as typed errors", async () => {
    for (const outputName of ["stdout", "stderr"] as const) {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const command = `synthetic-${outputName}-failure`;
      const fiber = Effect.runFork(
        Effect.either(
          collectChildProcessOutput(
            {
              stdin,
              stdout,
              stderr,
              onceClose: () => {
                // The stream error settles the synthetic process first.
              },
              onceError: () => {
                // The selected output stream supplies the failure.
              },
            },
            command,
            undefined,
          ),
        ),
      );
      await Effect.runPromise(Effect.yieldNow());
      const output = outputName === "stdout" ? stdout : stderr;
      output.emit("error", new Error(`${outputName} failed`));
      const outcome = await Effect.runPromise(Fiber.join(fiber));
      expect(outcome._tag).toBe("Left");
      if (outcome._tag === "Left") {
        expect(outcome.left).toBeInstanceOf(ProcessExecutionError);
        expect(outcome.left.command).toBe(command);
      }
    }
  });

  it("generates canonical lowercase UUID v7 identifiers", async () => {
    const identifier = await Effect.runPromise(
      RandomnessService.pipe(Effect.flatMap((service) => service.uuidV7)).pipe(
        Effect.provide(nodeFoundationLayer),
      ),
    );
    expect(identifier).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
