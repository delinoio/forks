import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { Effect } from "effect";
import { evidenceId } from "../src/compatibility/ledger.js";
import { nodeFoundationLayer } from "../src/effect/node-layer.js";
import { ProcessService } from "../src/effect/services.js";
import { makeExternalOracle } from "../src/oracle/launcher.js";
import { versionOutput } from "../src/version.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const officialExecutable = fileURLToPath(
  new URL(
    process.platform === "win32"
      ? "../../../node_modules/.bin/turbo.cmd"
      : "../../../node_modules/.bin/turbo",
    import.meta.url,
  ),
);
const candidateEntrypoint = fileURLToPath(
  new URL("../dist/bin/turbo-ts.js", import.meta.url),
);

describe("CLI and external oracle", () => {
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
    });
  });

  it(evidenceId.oracleExternal, async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const oracle = yield* makeExternalOracle(
          process.env.TURBO_TS_ORACLE_PATH ?? officialExecutable,
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
});
