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
  if (argv.slice(2).includes("--version")) {
    const terminal = yield* TerminalService;
    yield* terminal.writeStdout(`${versionOutput}\n`);
    return;
  }
  yield* run(argv);
});

program.pipe(
  Effect.provide(CliConfig.layer({ finalCheckBuiltIn: true })),
  Effect.provide(Layer.merge(NodeContext.layer, nodeFoundationLayer)),
  NodeRuntime.runMain,
);
