import { Command } from "@effect/cli";
import { Effect } from "effect";
import { UnsupportedCompatibilityError } from "../effect/errors.js";
import { TerminalService } from "../effect/services.js";
import { renderUnsupportedCompatibilityError } from "./compatibility-renderer.js";

export const rootCommand = Command.make("turbo-ts", {}, () =>
  Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const error = new UnsupportedCompatibilityError({
      surface: "root invocation",
      targetGate: 2,
    });
    const colorEnabled = yield* terminal.stderrColorEnabled;
    yield* terminal.writeStderr(
      renderUnsupportedCompatibilityError(error, colorEnabled),
    );
    return yield* Effect.fail(error);
  }),
);
