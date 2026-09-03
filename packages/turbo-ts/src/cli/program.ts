import { Cause, Effect } from "effect";
import { UnsupportedCompatibilityError } from "../effect/errors.js";
import {
  EnvironmentService,
  ExitStatusService,
  TerminalService,
} from "../effect/services.js";
import { executeRun } from "../run/engine.js";
import { isLaterGateCommand, parseRunArguments } from "../run/options.js";
import { versionOutput } from "../version.js";
import { renderUnsupportedCompatibilityError } from "./compatibility-renderer.js";

const helpOutput = `turbo-ts - Turborepo 2.10.12-compatible task runner

Usage: turbo-ts run [OPTIONS] <TASKS>... [-- <ARGS>...]
       turbo-ts <TASKS>... [OPTIONS] [-- <ARGS>...]

Core options:
  --filter, -F <SELECTOR>    Select packages
  --affected                Select changed packages and dependents
  --concurrency <VALUE>     Maximum tasks or percentage
  --continue[=<MODE>]       Continue after task failures
  --env-mode <MODE>         strict or loose
  --cache <POLICY>          Local and remote read/write policy
  --force                   Ignore existing cache entries
  --no-cache                Disable cache reads and writes
  --cwd <PATH>              Repository root
  --help, -h                Show help
  --version                 Show version
`;

const errorMessage = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);

export const cliProgram = Effect.gen(function* () {
  const environment = yield* EnvironmentService;
  const exitStatus = yield* ExitStatusService;
  const terminal = yield* TerminalService;
  const argv = yield* environment.argv;
  const arguments_ = argv.slice(2);
  const delimiter = arguments_.indexOf("--");
  const parserArguments =
    delimiter === -1 ? arguments_ : arguments_.slice(0, delimiter);
  const noColorRequested = parserArguments.some(
    (argument) => argument.split("=", 1)[0] === "--no-color",
  );
  if (parserArguments.includes("--version")) {
    yield* terminal.writeStdout(`${versionOutput}\n`);
    return;
  }
  if (parserArguments.includes("--help") || parserArguments.includes("-h")) {
    yield* terminal.writeStdout(helpOutput);
    return;
  }
  const first = arguments_[0];
  if (first !== undefined && first !== "run" && isLaterGateCommand(first)) {
    const error = new UnsupportedCompatibilityError({
      surface: first,
      targetGate: first === "watch" || first === "query" ? 3 : 4,
    });
    const color = noColorRequested ? false : yield* terminal.stderrColorEnabled;
    yield* terminal.writeStderr(
      renderUnsupportedCompatibilityError(error, color),
    );
    yield* exitStatus.set(1);
    return;
  }
  const outcome = yield* Effect.either(
    Effect.try({
      try: () => parseRunArguments(arguments_),
      catch: (cause) => cause,
    }).pipe(
      Effect.flatMap(executeRun),
      Effect.catchAllCause((cause) => Effect.fail(Cause.squash(cause))),
    ),
  );
  if (outcome._tag === "Right") {
    yield* exitStatus.set(outcome.right);
    return;
  }
  const color = noColorRequested ? false : yield* terminal.stderrColorEnabled;
  if (outcome.left instanceof UnsupportedCompatibilityError) {
    yield* terminal.writeStderr(
      renderUnsupportedCompatibilityError(outcome.left, color),
    );
  } else {
    yield* terminal.writeStderr(`turbo-ts: ${errorMessage(outcome.left)}\n`);
  }
  yield* exitStatus.set(1);
});
