import { Effect } from "effect";
import { OracleError } from "../effect/errors.js";
import { ProcessService } from "../effect/services.js";
import type { OracleInvocation, OracleResult } from "./model.js";

export interface ExternalOracle {
  readonly executable: string;
  readonly verify: Effect.Effect<void, OracleError, never>;
  readonly execute: (
    invocation: OracleInvocation,
  ) => Effect.Effect<OracleResult, OracleError, never>;
}

export interface OracleLauncher {
  readonly command: string;
  readonly fixedArgs: ReadonlyArray<string>;
}

export const makeExternalOracle = (
  launcher: OracleLauncher,
  verificationCwd: string,
): Effect.Effect<ExternalOracle, never, ProcessService> =>
  Effect.gen(function* () {
    const processService = yield* ProcessService;

    const execute = (invocation: OracleInvocation) =>
      Effect.scoped(
        processService
          .run({
            command: launcher.command,
            args: [...launcher.fixedArgs, ...invocation.args],
            cwd: invocation.cwd,
            env: invocation.env,
            stdin: invocation.stdin,
          })
          .pipe(
            Effect.mapError(
              (error) => new OracleError({ message: error.message }),
            ),
          ),
      );

    const verify = execute({
      args: ["--version"],
      cwd: verificationCwd,
    }).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0 && result.stdout === "2.10.12\n"
          ? Effect.void
          : Effect.fail(
              new OracleError({
                message:
                  "external oracle must print exactly 2.10.12 and exit successfully",
              }),
            ),
      ),
    );

    return { executable: launcher.command, execute, verify };
  });
