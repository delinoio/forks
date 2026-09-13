import { Cause, Effect } from "effect";
import { UnsupportedCompatibilityError } from "../effect/errors.js";
import {
  EnvironmentService,
  ExitStatusService,
  TerminalService,
} from "../effect/services.js";
import { redactText } from "../logging/redaction.js";
import { executeRun, type RunMetricTaskDetail } from "../run/engine.js";
import { parseRunArguments } from "../run/options.js";
import { versionOutput } from "../version.js";
import { executeDaemon, parseDaemonArguments } from "../workflow/daemon.js";
import { executeList, parseListArguments } from "../workflow/list.js";
import { executeCompletion, executeInfo } from "../workflow/misc.js";
import { executePrune, parsePruneArguments } from "../workflow/prune.js";
import { executeWatch, parseWatchArguments } from "../workflow/watch.js";
import { parseCommonArguments } from "./common-options.js";
import { renderUnsupportedCompatibilityError } from "./compatibility-renderer.js";

const helpOutput = `turbo-ts - Turborepo 2.10.12-compatible task runner

Usage: turbo-ts [OPTIONS] [COMMAND]

Commands:
  bin           Print the turbo-ts executable path
  boundaries    Check package boundary rules
  completion    Generate shell completion
  config        Print resolved configuration
  daemon        Manage the repository daemon
  devtools      Serve the package graph
  docs          Search Turborepo documentation
  generate      Run an independently authored generator
  get-mfe-port  Print the current microfrontend port
  info          Print debugging information
  link          Enable remote caching for this repository
  login         Store shared hosted credentials
  logout        Remove shared hosted credentials
  ls            List packages
  prune         Prepare a repository subset
  query         Query the repository graph
  run           Run repository tasks
  scan          Deprecated compatibility command
  telemetry     Manage anonymous telemetry consent
  unlink        Disable remote caching for this repository
  watch         Watch and rerun repository tasks

Core options:
  --filter, -F <SELECTOR>    Select packages
  --affected                Select changed packages and dependents
  --concurrency <VALUE>     Maximum tasks or percentage
  --continue[=<MODE>]       Continue after task failures
  --env-mode <MODE>         strict or loose
  --cache <POLICY>          Local and remote read/write policy
  --force                   Ignore existing cache entries
  --no-cache                Disable cache reads and writes
  --cache-workers <COUNT>   Limit concurrent cache publications
  --api <URL>               Override the hosted API
  --team <TEAM>             Select a remote-cache team
  --token <TOKEN>           Use a hosted access token
  --preflight               Send remote-cache preflight requests
  --remote-cache-timeout <SECONDS>
                            Set hosted request timeout
  --no-update-notifier      Keep update notification disabled
  --experimental-otel-enabled[=<BOOL>]
                            Export run metrics with OpenTelemetry
  --cwd <PATH>              Repository root
  --help, -h                Show help
  --version                 Show version
`;

const commandHelp: Readonly<Record<string, string>> = {
  bin: "Usage: turbo-ts bin [OPTIONS]\n",
  boundaries:
    "Usage: turbo-ts boundaries [OPTIONS]\n\nOptions:\n  -F, --filter <FILTER>\n      --ignore[=<all|prompt>]\n      --reason <REASON>\n",
  config: "Usage: turbo-ts config [OPTIONS]\n",
  daemon:
    "Usage: turbo-ts daemon [OPTIONS] <COMMAND>\n\nCommands:\n  clean\n  logs\n  restart\n  serve\n  start\n  status\n  stop\n\nOptions:\n      --idle-time <DURATION>\n      --json\n      --turbo-json-path <PATH>\n",
  devtools:
    "Usage: turbo-ts devtools [OPTIONS]\n\nOptions:\n      --port <PORT>\n      --no-open\n",
  docs: "Usage: turbo-ts docs [OPTIONS] <QUERY>\n\nOptions:\n      --docs-version <VERSION>\n",
  generate:
    "Usage: turbo-ts generate [OPTIONS] [GENERATOR_NAME] [COMMAND]\n\nCommands:\n  workspace\n  run\n\nOptions:\n  -c, --config <CONFIG>\n  -r, --root <ROOT>\n  -a, --args <ARGS>...\n",
  "generate workspace":
    "Usage: turbo-ts generate workspace [OPTIONS]\n\nOptions:\n  -n, --name <NAME>\n  -b, --empty\n  -c, --copy <WORKSPACE>\n  -d, --destination <PATH>\n  -t, --type <TYPE>\n  -r, --root <ROOT>\n  -p, --example-path <PATH>\n      --show-all-dependencies\n",
  "get-mfe-port": "Usage: turbo-ts get-mfe-port [OPTIONS]\n",
  link: "Usage: turbo-ts link [OPTIONS]\n\nOptions:\n      --scope <SCOPE>\n  -y, --yes\n      --no-gitignore\n",
  login:
    "Usage: turbo-ts login [OPTIONS]\n\nOptions:\n      --manual\n      --sso-team <TEAM>\n",
  logout:
    "Usage: turbo-ts logout [OPTIONS]\n\nOptions:\n      --invalidate[=<true|false>]\n",
  scan: "Usage: turbo-ts scan [OPTIONS]\n",
  telemetry: "Usage: turbo-ts telemetry [OPTIONS] <enable|disable|status>\n",
  "telemetry disable": "Usage: turbo-ts telemetry disable [OPTIONS]\n",
  "telemetry enable": "Usage: turbo-ts telemetry enable [OPTIONS]\n",
  "telemetry status": "Usage: turbo-ts telemetry status [OPTIONS]\n",
  unlink: "Usage: turbo-ts unlink [OPTIONS]\n",
};

const workflowCommands = new Set([
  "completion",
  "bin",
  "boundaries",
  "config",
  "daemon",
  "devtools",
  "docs",
  "generate",
  "gen",
  "get-mfe-port",
  "info",
  "link",
  "login",
  "logout",
  "ls",
  "prune",
  "query",
  "scan",
  "telemetry",
  "unlink",
  "watch",
]);

const runOptionsWithRequiredValues = new Set([
  "--api",
  "--cache",
  "--cache-dir",
  "--cache-workers",
  "--concurrency",
  "--cwd",
  "--env-mode",
  "--filter",
  "--global-deps",
  "--heap",
  "--login",
  "--log-order",
  "--log-prefix",
  "--output-logs",
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
  "-F",
]);

const runOptionConsumesAdjacent = (
  argument: string,
  adjacent: string | undefined,
): boolean => {
  if (argument.includes("=")) return false;
  const name = argument.split("=", 1)[0]!;
  if (runOptionsWithRequiredValues.has(name)) return true;
  if (name === "--dry" || name === "--dry-run") {
    return adjacent === "text" || adjacent === "json";
  }
  if (name === "--summarize") {
    return adjacent === "true" || adjacent === "false";
  }
  if (
    [
      "--experimental-otel-enabled",
      "--experimental-otel-metrics-run-summary",
      "--experimental-otel-metrics-task-details",
      "--experimental-otel-use-remote-cache-token",
    ].includes(name)
  ) {
    return adjacent === "true" || adjacent === "false";
  }
  return (
    ["--anon-profile", "--graph", "--log-file", "--profile"].includes(name) &&
    adjacent !== undefined &&
    !adjacent.startsWith("-")
  );
};

const existingWorkflowArguments = (
  arguments_: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const parsed = parseCommonArguments(arguments_);
  return [
    ...parsed.remaining,
    ...(parsed.options.cwd === undefined
      ? []
      : [`--cwd=${parsed.options.cwd}`]),
    ...(parsed.options.rootTurboJson === undefined
      ? []
      : [`--root-turbo-json=${parsed.options.rootTurboJson}`]),
    ...(parsed.options.color === false ? ["--no-color"] : []),
    ...(parsed.options.noUpdateNotifier ? ["--no-update-notifier"] : []),
  ];
};

export const commandIndex = (arguments_: ReadonlyArray<string>): number => {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--") return -1;
    if (!argument.startsWith("-")) return index;
    if (runOptionConsumesAdjacent(argument, arguments_[index + 1])) {
      index += 1;
    }
  }
  return -1;
};

const errorMessage = (error: unknown): string =>
  redactText(
    typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : String(error),
  );

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
  const locatedCommandIndex = commandIndex(arguments_);
  const first =
    locatedCommandIndex === -1 ? undefined : arguments_[locatedCommandIndex];
  if (parserArguments.includes("--version")) {
    yield* terminal.writeStdout(`${versionOutput}\n`);
    return;
  }
  if (parserArguments.includes("--help") || parserArguments.includes("-h")) {
    const nested =
      locatedCommandIndex === -1
        ? undefined
        : arguments_
            .slice(locatedCommandIndex + 1)
            .find((argument) => !argument.startsWith("-"));
    const helpKey =
      first !== undefined && nested !== undefined
        ? `${first === "gen" ? "generate" : first} ${nested}`
        : first === "gen"
          ? "generate"
          : first;
    yield* terminal.writeStdout(
      helpKey === undefined
        ? helpOutput
        : (commandHelp[helpKey] ?? commandHelp[first ?? ""] ?? helpOutput),
    );
    return;
  }
  if (
    parserArguments.some(
      (argument) =>
        argument === "--force-update-check" ||
        argument.startsWith("--force-update-check="),
    )
  ) {
    const argument = parserArguments.find((entry) =>
      entry.startsWith("--force-update-check="),
    );
    const endpoint = argument?.slice(argument.indexOf("=") + 1) || undefined;
    const result = yield* Effect.either(
      Effect.promise(() => import("../workflow/secondary.js")).pipe(
        Effect.flatMap((secondary) =>
          secondary.executeForcedUpdateCheck(endpoint),
        ),
        Effect.catchAllCause((cause) => Effect.fail(Cause.squash(cause))),
      ),
    );
    if (result._tag === "Right") {
      yield* exitStatus.set(result.right);
    } else {
      yield* terminal.writeStderr(`turbo-ts: ${errorMessage(result.left)}\n`);
      yield* exitStatus.set(1);
    }
    return;
  }
  // The reference prints its product banner on stderr before every command
  // execution (including parser and repository failures), but not for help or
  // version. Keep the independent product identity required by the contract.
  yield* terminal.writeStderr(`• ${versionOutput}\n`);
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
  const workflow = (): Effect.Effect<number, unknown, never> => {
    if (
      first === "login" ||
      first === "link" ||
      first === "logout" ||
      first === "unlink"
    ) {
      return Effect.promise(() => import("../workflow/hosted.js")).pipe(
        Effect.flatMap((hosted) =>
          hosted.executeHostedCommand(first, commandArguments),
        ),
      ) as Effect.Effect<number, unknown, never>;
    }
    if (first === "telemetry") {
      return Effect.promise(() => import("../workflow/telemetry.js")).pipe(
        Effect.flatMap((telemetry) =>
          telemetry.executeTelemetry(commandArguments),
        ),
      ) as Effect.Effect<number, unknown, never>;
    }
    if (first === "generate" || first === "gen") {
      return Effect.promise(() => import("../workflow/generate.js")).pipe(
        Effect.flatMap((generate) =>
          generate.executeGenerate(commandArguments),
        ),
      ) as Effect.Effect<number, unknown, never>;
    }
    if (first === "devtools") {
      return Effect.promise(() => import("../workflow/devtools.js")).pipe(
        Effect.flatMap((devtools) =>
          devtools.executeDevtools(commandArguments),
        ),
      ) as Effect.Effect<number, unknown, never>;
    }
    if (
      first === "bin" ||
      first === "boundaries" ||
      first === "config" ||
      first === "docs" ||
      first === "get-mfe-port" ||
      first === "scan"
    ) {
      return Effect.promise(() => import("../workflow/secondary.js")).pipe(
        Effect.flatMap((secondary) =>
          secondary.executeSecondaryCommand(first, commandArguments),
        ),
      ) as Effect.Effect<number, unknown, never>;
    }
    if (first === "prune") {
      return Effect.try({
        try: () =>
          parsePruneArguments(existingWorkflowArguments(commandArguments)),
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
        try: () =>
          parseDaemonArguments(existingWorkflowArguments(commandArguments)),
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
      return executeInfo(
        existingWorkflowArguments(commandArguments),
      ) as Effect.Effect<number, unknown, never>;
    }
    if (first === "ls" || (first === "query" && commandTail[0] === "ls")) {
      const listArguments =
        first === "ls"
          ? existingWorkflowArguments(commandArguments)
          : existingWorkflowArguments([
              ...commandPrefix,
              ...commandTail.slice(1),
            ]);
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
              ...existingWorkflowArguments([
                ...commandPrefix,
                ...commandTail.slice(1),
              ]),
            ]),
          ),
        ) as Effect.Effect<number, unknown, never>;
      }
      return Effect.promise(() => import("../workflow/query.js")).pipe(
        Effect.flatMap((query) =>
          Effect.try({
            try: () =>
              query.parseQueryArguments(
                existingWorkflowArguments(commandArguments),
              ),
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
    }).pipe(
      Effect.flatMap((options) => {
        let remoteToken = options.token;
        let taskDetails: ReadonlyArray<RunMetricTaskDetail> | undefined;
        return executeRun(options, {
          onRemoteTokenResolved: (token) => {
            remoteToken = token;
          },
          onTaskMetricsResolved: (tasks) => {
            taskDetails = tasks;
          },
        }).pipe(
          Effect.tap((exitCode) =>
            Effect.promise(() => import("../telemetry/observability.js")).pipe(
              Effect.flatMap((observability) =>
                observability.exportRunMetrics(
                  options.openTelemetry,
                  remoteToken,
                  {
                    exitCode,
                    taskCount: taskDetails?.length ?? options.tasks.length,
                    tasks: taskDetails ?? [],
                  },
                ),
              ),
              Effect.catchAll(() => Effect.void),
            ),
          ),
        );
      }),
    ) as Effect.Effect<number, unknown, never>;
  };
  const outcome = yield* Effect.either(
    Effect.suspend(workflow).pipe(
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
