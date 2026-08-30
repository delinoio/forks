#!/usr/bin/env node

import { CliConfig, Command } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Cause, Effect, Layer } from "effect";
import { renderUnsupportedCompatibilityError } from "../cli/compatibility-renderer.js";
import { UnsupportedCompatibilityError } from "../effect/errors.js";
import { nodeFoundationLayer } from "../effect/node-layer.js";
import { EnvironmentService, TerminalService } from "../effect/services.js";
import { executeRun } from "../run/engine.js";
import { isLaterGateCommand, parseRunArguments } from "../run/options.js";
import { versionOutput } from "../version.js";

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

const program = Effect.gen(function* () {
  const environment = yield* EnvironmentService;
  const terminal = yield* TerminalService;
  const argv = yield* environment.argv;
  const arguments_ = argv.slice(2);
  const delimiter = arguments_.indexOf("--");
  const parserArguments =
    delimiter === -1 ? arguments_ : arguments_.slice(0, delimiter);
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
    const color = yield* terminal.stderrColorEnabled;
    yield* terminal.writeStderr(
      renderUnsupportedCompatibilityError(error, color),
    );
    process.exitCode = 1;
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
    process.exitCode = outcome.right;
    return;
  }
  const color = yield* terminal.stderrColorEnabled;
  if (outcome.left instanceof UnsupportedCompatibilityError) {
    yield* terminal.writeStderr(
      renderUnsupportedCompatibilityError(outcome.left, color),
    );
  } else {
    yield* terminal.writeStderr(`turbo-ts: ${errorMessage(outcome.left)}\n`);
  }
  process.exitCode = 1;
});

const command = Command.make("turbo-ts", {}, () => program);
const run = Command.run(command, {
  executable: "turbo-ts",
  name: "turbo-ts",
  version: versionOutput,
});

// The compatibility parser owns implicit tasks and the `--` tail. Give Effect
// CLI only the executable prefix so it supplies the command lifecycle without
// reinterpreting official-compatible task arguments.
run(process.argv.slice(0, 2)).pipe(
  Effect.provide(CliConfig.layer({ finalCheckBuiltIn: true })),
  Effect.provide(Layer.merge(NodeContext.layer, nodeFoundationLayer)),
  NodeRuntime.runMain,
);
