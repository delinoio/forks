#!/usr/bin/env node

import { CliConfig, Command } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { rootCommand } from "../cli/root-command.js";
import { nodeFoundationLayer } from "../effect/node-layer.js";
import { EnvironmentService, TerminalService } from "../effect/services.js";
import { versionOutput } from "../version.js";

const run = Command.run(rootCommand, {
  executable: "turbo-ts",
  name: "turbo-ts",
  version: versionOutput,
});

const program = Effect.gen(function* () {
  const environment = yield* EnvironmentService;
  const argv = yield* environment.argv;
  const commandArguments = argv.slice(2);
  const passThroughIndex = commandArguments.indexOf("--");
  const parsedArguments = commandArguments.slice(
    0,
    passThroughIndex === -1 ? undefined : passThroughIndex,
  );
  if (parsedArguments.includes("--version")) {
    const terminal = yield* TerminalService;
    yield* terminal.writeStdout(`${versionOutput}\n`);
    return;
  }
  // Effect CLI scans built-in flags after the pass-through delimiter. Gate 1
  // does not execute task arguments, so omit that tail from its parser input.
  // Remove this workaround when Gate 2 owns and forwards pass-through values.
  const parserArgv =
    passThroughIndex === -1 ? argv : argv.slice(0, passThroughIndex + 3);
  yield* run(parserArgv);
});

program.pipe(
  Effect.provide(CliConfig.layer({ finalCheckBuiltIn: true })),
  Effect.provide(Layer.merge(NodeContext.layer, nodeFoundationLayer)),
  NodeRuntime.runMain,
);
