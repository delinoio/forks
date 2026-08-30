import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { Effect } from "effect";
import { renderUnsupportedCompatibilityError } from "../src/cli/compatibility-renderer.js";
import { evidenceId } from "../src/compatibility/ledger.js";
import { UnsupportedCompatibilityError } from "../src/effect/errors.js";
import { nodeFoundationLayer } from "../src/effect/node-layer.js";
import { ProcessService } from "../src/effect/services.js";
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
