import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "@rstest/core";
import { Effect, Fiber, Schedule, Schema } from "effect";
import { evidenceId } from "../src/compatibility/ledger.js";
import { BoundaryError } from "../src/effect/errors.js";
import { nodeFoundationLayer } from "../src/effect/node-layer.js";
import { ProcessService, RandomnessService } from "../src/effect/services.js";

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

  it(evidenceId.effectsScoped, async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-process-test-"));
    const pidPath = join(directory, "pid");
    let childPid: number | undefined;
    try {
      const execution = Effect.scoped(
        Effect.gen(function* () {
          const processService = yield* ProcessService;
          return yield* processService.run({
            command: process.execPath,
            args: [
              "-e",
              'const fs = require("node:fs"); process.on("SIGTERM", () => {}); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1_000);',
              pidPath,
            ],
            cwd: directory,
          });
        }),
      ).pipe(Effect.provide(nodeFoundationLayer));
      const fiber = Effect.runFork(execution);
      childPid = Number(await waitForTextFile(pidPath));
      await Effect.runPromise(Fiber.interrupt(fiber));
      expect(() => process.kill(childPid as number, 0)).toThrow();
    } finally {
      if (childPid !== undefined) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The scoped finalizer already reaped the expected child process.
        }
      }
      await rm(directory, { force: true, recursive: true });
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
