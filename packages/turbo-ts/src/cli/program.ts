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
import { executeDaemon, parseDaemonArguments } from "../workflow/daemon.js";
import { executeList, parseListArguments } from "../workflow/list.js";
import { executeCompletion, executeInfo } from "../workflow/misc.js";
import { executePrune, parsePruneArguments } from "../workflow/prune.js";
import { executeWatch, parseWatchArguments } from "../workflow/watch.js";
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

const workflowCommands = new Set([
  "completion",
  "daemon",
  "info",
  "ls",
  "prune",
  "query",
  "watch",
]);

const globalOptionsWithValues = new Set([
  "--api",
  "--cwd",
  "--heap",
  "--login",
  "--remote-cache-timeout",
  "--root-turbo-json",
  "--team",
  "--token",
  "--trace",
  "--ui",
  "--verbosity",
  "--experimental-otel-protocol",
  "--experimental-otel-endpoint",
  "--experimental-otel-timeout-ms",
  "--experimental-otel-interval-ms",
  "--experimental-otel-header",
  "--experimental-otel-resource",
]);

const commandIndex = (arguments_: ReadonlyArray<string>): number => {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--") return -1;
    if (!argument.startsWith("-")) return index;
    if (
      !argument.includes("=") &&
      globalOptionsWithValues.has(argument.split("=", 1)[0]!)
    ) {
      index += 1;
    }
  }
  return -1;
};

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
  // The reference prints its product banner on stderr before every command
  // execution (including parser and repository failures), but not for help or
  // version. Keep the independent product identity required by the contract.
  yield* terminal.writeStderr(`• ${versionOutput}\n`);
  const locatedCommandIndex = commandIndex(arguments_);
  const first =
    locatedCommandIndex === -1 ? undefined : arguments_[locatedCommandIndex];
  const commandPrefix =
    locatedCommandIndex === -1 ? [] : arguments_.slice(0, locatedCommandIndex);
  const commandTail =
    locatedCommandIndex === -1
      ? arguments_
      : arguments_.slice(locatedCommandIndex + 1);
  const commandArguments =
    locatedCommandIndex === -1
      ? arguments_
      : [...commandPrefix, ...commandTail];
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
  const workflow = (): Effect.Effect<number, unknown, never> => {
    if (first === "prune") {
      return Effect.try({
        try: () => parsePruneArguments(commandArguments),
        catch: (cause) => cause,
      }).pipe(Effect.flatMap(executePrune)) as Effect.Effect<
        number,
        unknown,
        never
      >;
    }
    if (first === "watch") {
      return Effect.try({
        try: () => parseWatchArguments(commandArguments),
        catch: (cause) => cause,
      }).pipe(Effect.flatMap(executeWatch)) as Effect.Effect<
        number,
        unknown,
        never
      >;
    }
    if (first === "daemon") {
      return Effect.try({
        try: () => parseDaemonArguments(commandArguments),
        catch: (cause) => cause,
      }).pipe(Effect.flatMap(executeDaemon)) as Effect.Effect<
        number,
        unknown,
        never
      >;
    }
    if (first === "completion") {
      return executeCompletion(commandTail) as Effect.Effect<
        number,
        unknown,
        never
      >;
    }
    if (first === "info") {
      return executeInfo(commandArguments) as Effect.Effect<
        number,
        unknown,
        never
      >;
    }
    if (first === "ls" || (first === "query" && commandTail[0] === "ls")) {
      const listArguments =
        first === "ls"
          ? commandArguments
          : [...commandPrefix, ...commandTail.slice(1)];
      return Effect.try({
        try: () => parseListArguments(listArguments),
        catch: (cause) => cause,
      }).pipe(Effect.flatMap(executeList)) as Effect.Effect<
        number,
        unknown,
        never
      >;
    }
    if (first === "query") {
      if (commandTail[0] === "affected") {
        return Effect.promise(() => import("../workflow/query.js")).pipe(
          Effect.flatMap((query) =>
            query.executeQueryAffected([
              ...commandPrefix,
              ...commandTail.slice(1),
            ]),
          ),
        ) as Effect.Effect<number, unknown, never>;
      }
      return Effect.promise(() => import("../workflow/query.js")).pipe(
        Effect.flatMap((query) =>
          Effect.try({
            try: () => query.parseQueryArguments(commandArguments),
            catch: (cause) => cause,
          }).pipe(Effect.flatMap(query.executeQuery)),
        ),
      ) as Effect.Effect<number, unknown, never>;
    }
    if (first !== undefined && workflowCommands.has(first)) {
      return Effect.fail(
        new UnsupportedCompatibilityError({ surface: first, targetGate: 3 }),
      );
    }
    return Effect.try({
      try: () =>
        parseRunArguments(
          first === "run" ? ["run", ...commandArguments] : arguments_,
        ),
      catch: (cause) => cause,
    }).pipe(Effect.flatMap(executeRun)) as Effect.Effect<
      number,
      unknown,
      never
    >;
  };
  const outcome = yield* Effect.either(
    workflow().pipe(
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
