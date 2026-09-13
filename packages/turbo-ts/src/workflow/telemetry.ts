import { Effect, Schema } from "effect";
import { parseCommonArguments } from "../cli/common-options.js";
import { ConfigurationError } from "../effect/errors.js";
import {
  ClockService,
  DigestService,
  EnvironmentService,
  RandomnessService,
  TelemetryService,
  type TelemetryState,
  TerminalService,
} from "../effect/services.js";

export const TelemetryStateSchema = Schema.Struct({
  telemetry_enabled: Schema.Boolean,
  telemetry_id: Schema.String,
  telemetry_salt: Schema.String,
  telemetry_alerted: Schema.optional(Schema.String),
});

type TelemetryCommand = "disable" | "enable" | "status";

const parseTelemetryArguments = (
  arguments_: ReadonlyArray<string>,
): TelemetryCommand => {
  const parsed = parseCommonArguments(arguments_);
  if (parsed.remaining.length !== 1) {
    throw new ConfigurationError({
      path: "<arguments>",
      message: "telemetry requires one of: enable, disable, status",
    });
  }
  const command = parsed.remaining[0];
  if (command !== "enable" && command !== "disable" && command !== "status") {
    throw new ConfigurationError({
      path: "<arguments>",
      message: `unknown telemetry command: ${command}`,
    });
  }
  return command;
};

const environmentDisablesTelemetry = (value: string | undefined): boolean =>
  value !== undefined &&
  value !== "" &&
  value !== "0" &&
  value.toLowerCase() !== "false";

const makeTelemetryState = (): Effect.Effect<
  TelemetryState,
  unknown,
  ClockService | DigestService | RandomnessService
> =>
  Effect.gen(function* () {
    const clock = yield* ClockService;
    const digest = yield* DigestService;
    const randomness = yield* RandomnessService;
    const salt = yield* randomness.uuidV7;
    const telemetryId =
      digest.sha256 === undefined
        ? salt.replaceAll("-", "").padEnd(64, "0").slice(0, 64)
        : yield* digest.sha256(`turbo-ts:${salt}`);
    return {
      telemetry_enabled: true,
      telemetry_id: telemetryId,
      telemetry_salt: salt,
      telemetry_alerted: new Date(yield* clock.now).toISOString(),
    };
  });

export const executeTelemetry = (
  arguments_: ReadonlyArray<string>,
): Effect.Effect<
  number,
  unknown,
  | ClockService
  | DigestService
  | EnvironmentService
  | RandomnessService
  | TelemetryService
  | TerminalService
> =>
  Effect.gen(function* () {
    const command = parseTelemetryArguments(arguments_);
    const environment = yield* EnvironmentService;
    const telemetry = yield* TelemetryService;
    const terminal = yield* TerminalService;
    const stored = yield* telemetry.read;
    let persisted: TelemetryState | undefined;
    try {
      persisted =
        stored === undefined
          ? undefined
          : Schema.decodeUnknownSync(TelemetryStateSchema)(stored);
    } catch {
      return yield* Effect.fail(
        new ConfigurationError({
          path: "telemetry.json",
          message: "telemetry state is invalid",
        }),
      );
    }
    const state = persisted ?? (yield* makeTelemetryState());
    const environmentDisabled = environmentDisablesTelemetry(
      yield* environment.get("TURBO_TELEMETRY_DISABLED"),
    );

    const persistedEnabled =
      command === "enable"
        ? true
        : command === "disable"
          ? false
          : state.telemetry_enabled;
    const enabled = persistedEnabled && !environmentDisabled;
    if (command !== "status" || persisted === undefined) {
      yield* telemetry.write({
        ...state,
        telemetry_enabled: persistedEnabled,
      });
    }

    if (command !== "status") {
      yield* terminal.writeStdout("Success!\n\n");
    }
    yield* terminal.writeStdout(
      `Status: ${enabled ? "Enabled" : "Disabled"}\n\n`,
    );
    yield* terminal.writeStdout(
      enabled
        ? "turbo-ts telemetry is anonymous. Thank you for participating!\n"
        : "You have opted out of anonymous telemetry. No data will be collected from your machine.\n",
    );
    yield* terminal.writeStdout(
      "Learn more: https://turborepo.dev/docs/telemetry\n",
    );
    return 0;
  });
