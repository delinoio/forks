#!/usr/bin/env node

import { CliConfig, Command } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { cliProgram } from "../cli/program.js";
import { nodeFoundationLayer } from "../effect/node-layer.js";
import { versionOutput } from "../version.js";

const command = Command.make("turbo-ts", {}, () => cliProgram);
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
