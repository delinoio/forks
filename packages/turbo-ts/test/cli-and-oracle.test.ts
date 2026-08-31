import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { Effect } from "effect";
import { renderUnsupportedCompatibilityError } from "../src/cli/compatibility-renderer.js";
import { cliProgram } from "../src/cli/program.js";
import { evidenceId } from "../src/compatibility/ledger.js";
import { UnsupportedCompatibilityError } from "../src/effect/errors.js";
import { nodeFoundationLayer } from "../src/effect/node-layer.js";
import {
  EnvironmentService,
  ExitStatusService,
  ProcessService,
  TerminalService,
} from "../src/effect/services.js";
import {
  makeExternalOracle,
  type OracleLauncher,
} from "../src/oracle/launcher.js";
import { versionOutput } from "../src/version.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const officialExecutable = fileURLToPath(
  new URL("../../../node_modules/.bin/turbo", import.meta.url),
);
const officialNodeLauncher = fileURLToPath(
  new URL("../../../node_modules/turbo/bin/turbo", import.meta.url),
);
const candidateEntrypoint = fileURLToPath(
  new URL("../dist/bin/turbo-ts.js", import.meta.url),
);

const makeOfficialOracleLauncher = (
  platform: NodeJS.Platform,
  override: string | undefined,
): OracleLauncher => {
  if (override !== undefined) {
    return { command: override, fixedArgs: [] };
  }
  return platform === "win32"
    ? { command: process.execPath, fixedArgs: [officialNodeLauncher] }
    : { command: officialExecutable, fixedArgs: [] };
};

describe("CLI and external oracle", () => {
  it("renders unsupported diagnostics according to terminal color policy", () => {
    const error = new UnsupportedCompatibilityError({
      surface: "root invocation",
      targetGate: 2,
    });
    const message =
      "turbo-ts: root invocation is not implemented in compatibility gate 2";
    expect(renderUnsupportedCompatibilityError(error, false)).toBe(
      `${message}\n`,
    );
    expect(renderUnsupportedCompatibilityError(error, true)).toBe(
      `\u001B[31m${message}\u001B[0m\n`,
    );
  });

  it("routes exit status through a substitutable Effect service", async () => {
    const exitStatuses: Array<number> = [];
    let stderr = "";
    const previousExitCode = process.exitCode;
    await Effect.runPromise(
      cliProgram.pipe(
        Effect.provideService(EnvironmentService, {
          argv: Effect.succeed(["node", "turbo-ts", "watch", "--no-color"]),
          cwd: Effect.succeed(packageRoot),
          get: () => Effect.succeed(undefined),
          entries: Effect.succeed({}),
        }),
        Effect.provideService(ExitStatusService, {
          set: (code) =>
            Effect.sync(() => {
              exitStatuses.push(code);
            }),
        }),
        Effect.provideService(TerminalService, {
          writeStdout: () => Effect.void,
          writeStderr: (text) =>
            Effect.sync(() => {
              stderr += text;
            }),
          stdoutColorEnabled: Effect.succeed(true),
          stderrColorEnabled: Effect.succeed(true),
        }),
        Effect.provide(nodeFoundationLayer),
      ),
    );
    expect(exitStatuses).toEqual([1]);
    expect(stderr).toContain("watch is not implemented");
    expect(stderr).not.toContain("\u001B[");
    expect(process.exitCode).toBe(previousExitCode);
  });

  it(evidenceId.cliVersion, async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const processService = yield* ProcessService;
          return yield* processService.run({
            command: process.execPath,
            args: [candidateEntrypoint, "--version"],
            cwd: packageRoot,
          });
        }),
      ).pipe(Effect.provide(nodeFoundationLayer)),
    );
    expect(result).toEqual({
      exitCode: 0,
      stdout: `${versionOutput}\n`,
      stderr: "",
      combinedOutput: `${versionOutput}\n`,
    });
  });

  it("does not recognize version flags after the pass-through delimiter", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const processService = yield* ProcessService;
          return yield* processService.run({
            command: process.execPath,
            args: [candidateEntrypoint, "run", "build", "--", "--version"],
            cwd: packageRoot,
          });
        }),
      ).pipe(Effect.provide(nodeFoundationLayer)),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain(versionOutput);
  });

  it(evidenceId.oracleExternal, async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const oracle = yield* makeExternalOracle(
          makeOfficialOracleLauncher(
            process.platform,
            process.env.TURBO_TS_ORACLE_PATH,
          ),
          repositoryRoot,
        );
        yield* oracle.verify;
        return yield* oracle.execute({
          args: ["--version"],
          cwd: repositoryRoot,
        });
      }).pipe(Effect.provide(nodeFoundationLayer)),
    );
    expect(result).toEqual({
      exitCode: 0,
      stdout: "2.10.12\n",
      stderr: "",
    });
  });

  it("launches the distributed Windows oracle through Node", () => {
    expect(makeOfficialOracleLauncher("win32", undefined)).toEqual({
      command: process.execPath,
      fixedArgs: [officialNodeLauncher],
    });
  });
});
