import { ConfigurationError } from "../effect/errors.js";

export type OtlpProtocol = "grpc" | "http-json" | "http-protobuf";

export interface OpenTelemetryOptions {
  readonly enabled?: boolean;
  readonly protocol?: OtlpProtocol;
  readonly endpoint?: string;
  readonly timeoutMilliseconds?: number;
  readonly intervalMilliseconds?: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly resources: ReadonlyArray<readonly [string, string]>;
  readonly metricsRunSummary?: boolean;
  readonly metricsTaskDetails?: boolean;
  readonly useRemoteCacheToken?: boolean;
}

export interface CommonCliOptions {
  readonly apiUrl?: string;
  readonly color?: boolean;
  readonly cwd?: string;
  readonly dangerouslyDisablePackageManagerCheck: boolean;
  readonly heap?: string;
  readonly loginUrl?: string;
  readonly noUpdateNotifier: boolean;
  readonly openTelemetry: OpenTelemetryOptions;
  readonly preflight: boolean;
  readonly remoteCacheTimeoutSeconds?: number;
  readonly rootTurboJson?: string;
  readonly skipInfer: boolean;
  readonly team?: string;
  readonly token?: string;
  readonly trace?: string;
  readonly ui?: "stream" | "stream-with-experimental-timestamps" | "tui";
  readonly verbosity?: number;
}

export interface ParsedCommonArguments {
  readonly options: CommonCliOptions;
  readonly remaining: ReadonlyArray<string>;
}

const configurationFailure = (message: string): ConfigurationError =>
  new ConfigurationError({ path: "<arguments>", message });

const requiredValue = (
  arguments_: ReadonlyArray<string>,
  index: number,
  name: string,
): readonly [string, number] => {
  const argument = arguments_[index]!;
  const equals = argument.indexOf("=");
  if (equals !== -1) {
    const value = argument.slice(equals + 1);
    if (value === "") throw configurationFailure(`${name} requires a value`);
    return [value, index];
  }
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw configurationFailure(`${name} requires a value`);
  }
  return [value, index + 1];
};

const optionalBoolean = (
  arguments_: ReadonlyArray<string>,
  index: number,
  name: string,
): readonly [boolean, number] => {
  const argument = arguments_[index]!;
  const equals = argument.indexOf("=");
  if (equals !== -1) {
    const value = argument.slice(equals + 1);
    if (value === "true") return [true, index];
    if (value === "false") return [false, index];
    throw configurationFailure(`${name} must be true or false`);
  }
  const adjacent = arguments_[index + 1];
  if (adjacent === "true") return [true, index + 1];
  if (adjacent === "false") return [false, index + 1];
  return [true, index];
};

const nonNegativeNumber = (value: string, name: string): number => {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed) || parsed < 0) {
    throw configurationFailure(`invalid ${name}: ${value}`);
  }
  return parsed;
};

const nonNegativeInteger = (value: string, name: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw configurationFailure(`invalid ${name}: ${value}`);
  }
  return parsed;
};

const assignment = (value: string, name: string): readonly [string, string] => {
  const separator = value.indexOf("=");
  if (separator <= 0) {
    throw configurationFailure(`${name} requires KEY=VALUE`);
  }
  return [value.slice(0, separator), value.slice(separator + 1)];
};

export const parseCommonArguments = (
  arguments_: ReadonlyArray<string>,
): ParsedCommonArguments => {
  const remaining: Array<string> = [];
  let apiUrl: string | undefined;
  let color: boolean | undefined;
  let cwd: string | undefined;
  let dangerouslyDisablePackageManagerCheck = false;
  let heap: string | undefined;
  let loginUrl: string | undefined;
  let noUpdateNotifier = false;
  let preflight = false;
  let remoteCacheTimeoutSeconds: number | undefined;
  let rootTurboJson: string | undefined;
  let skipInfer = false;
  let team: string | undefined;
  let token: string | undefined;
  let trace: string | undefined;
  let ui: CommonCliOptions["ui"];
  let verbosity: number | undefined;
  let otelEnabled: boolean | undefined;
  let otelProtocol: OtlpProtocol | undefined;
  let otelEndpoint: string | undefined;
  let otelTimeout: number | undefined;
  let otelInterval: number | undefined;
  let metricsRunSummary: boolean | undefined;
  let metricsTaskDetails: boolean | undefined;
  let useRemoteCacheToken: boolean | undefined;
  const headers: Array<readonly [string, string]> = [];
  const resources: Array<readonly [string, string]> = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--") {
      remaining.push(...arguments_.slice(index));
      break;
    }
    const name = argument.split("=", 1)[0]!;
    switch (name) {
      case "--api":
        [apiUrl, index] = requiredValue(arguments_, index, name);
        break;
      case "--color":
        color = true;
        break;
      case "--no-color":
        color = false;
        break;
      case "--cwd":
        [cwd, index] = requiredValue(arguments_, index, name);
        break;
      case "--dangerously-disable-package-manager-check":
        dangerouslyDisablePackageManagerCheck = true;
        break;
      case "--heap":
        [heap, index] = requiredValue(arguments_, index, name);
        break;
      case "--login":
        [loginUrl, index] = requiredValue(arguments_, index, name);
        break;
      case "--no-update-notifier":
        noUpdateNotifier = true;
        break;
      case "--preflight":
        preflight = true;
        break;
      case "--remote-cache-timeout": {
        if (argument.endsWith("=")) {
          throw configurationFailure("invalid remote cache timeout: ");
        }
        let value: string;
        [value, index] = requiredValue(arguments_, index, name);
        remoteCacheTimeoutSeconds = nonNegativeNumber(
          value,
          "remote cache timeout",
        );
        break;
      }
      case "--root-turbo-json":
        [rootTurboJson, index] = requiredValue(arguments_, index, name);
        break;
      case "--skip-infer":
        skipInfer = true;
        break;
      case "--team":
        [team, index] = requiredValue(arguments_, index, name);
        break;
      case "--token":
        [token, index] = requiredValue(arguments_, index, name);
        break;
      case "--trace":
        if (argument === "--trace=") {
          trace = "";
        } else {
          [trace, index] = requiredValue(arguments_, index, name);
        }
        break;
      case "--ui": {
        let value: string;
        [value, index] = requiredValue(arguments_, index, name);
        if (
          value !== "stream" &&
          value !== "stream-with-experimental-timestamps" &&
          value !== "tui"
        ) {
          throw configurationFailure(`invalid UI mode: ${value}`);
        }
        ui = value;
        break;
      }
      case "--verbosity": {
        let value: string;
        [value, index] = requiredValue(arguments_, index, name);
        verbosity = nonNegativeInteger(value, "verbosity");
        break;
      }
      case "--experimental-otel-enabled":
        [otelEnabled, index] = optionalBoolean(arguments_, index, name);
        break;
      case "--experimental-otel-protocol": {
        let value: string;
        [value, index] = requiredValue(arguments_, index, name);
        if (
          value !== "grpc" &&
          value !== "http-protobuf" &&
          value !== "http-json"
        ) {
          throw configurationFailure(`invalid OTLP protocol: ${value}`);
        }
        otelProtocol = value;
        break;
      }
      case "--experimental-otel-endpoint":
        [otelEndpoint, index] = requiredValue(arguments_, index, name);
        break;
      case "--experimental-otel-timeout-ms": {
        let value: string;
        [value, index] = requiredValue(arguments_, index, name);
        otelTimeout = nonNegativeInteger(value, "OTLP timeout");
        break;
      }
      case "--experimental-otel-interval-ms": {
        let value: string;
        [value, index] = requiredValue(arguments_, index, name);
        otelInterval = nonNegativeInteger(value, "OTLP interval");
        break;
      }
      case "--experimental-otel-header": {
        let value: string;
        [value, index] = requiredValue(arguments_, index, name);
        headers.push(assignment(value, name));
        break;
      }
      case "--experimental-otel-resource": {
        let value: string;
        [value, index] = requiredValue(arguments_, index, name);
        resources.push(assignment(value, name));
        break;
      }
      case "--experimental-otel-metrics-run-summary":
        [metricsRunSummary, index] = optionalBoolean(arguments_, index, name);
        break;
      case "--experimental-otel-metrics-task-details":
        [metricsTaskDetails, index] = optionalBoolean(arguments_, index, name);
        break;
      case "--experimental-otel-use-remote-cache-token":
        [useRemoteCacheToken, index] = optionalBoolean(arguments_, index, name);
        break;
      default:
        remaining.push(argument);
        break;
    }
  }

  return {
    options: {
      apiUrl,
      color,
      cwd,
      dangerouslyDisablePackageManagerCheck,
      heap,
      loginUrl,
      noUpdateNotifier,
      openTelemetry: {
        enabled: otelEnabled,
        protocol: otelProtocol,
        endpoint: otelEndpoint,
        timeoutMilliseconds: otelTimeout,
        intervalMilliseconds: otelInterval,
        headers,
        resources,
        metricsRunSummary,
        metricsTaskDetails,
        useRemoteCacheToken,
      },
      preflight,
      remoteCacheTimeoutSeconds,
      rootTurboJson,
      skipInfer,
      team,
      token,
      trace,
      ui,
      verbosity,
    },
    remaining,
  };
};
