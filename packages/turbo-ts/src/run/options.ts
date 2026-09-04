import { Schema } from "effect";
import { OutputLogsSchema } from "../config/schema.js";
import { ConfigurationError } from "../effect/errors.js";
import type { OutputLogs } from "../generated/configuration.js";

export type ContinueMode = "always" | "dependencies-successful" | "never";
export type EnvironmentMode = "loose" | "strict";

export interface ParsedRunOptions {
  readonly tasks: ReadonlyArray<string>;
  readonly passThroughArguments: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly filters: ReadonlyArray<string>;
  readonly globalDependencies: ReadonlyArray<string>;
  readonly affected: boolean;
  readonly concurrency?: string;
  readonly continueMode?: ContinueMode;
  readonly environmentMode?: EnvironmentMode;
  readonly cacheDirectory?: string;
  readonly cacheSpecification?: string;
  readonly force: boolean;
  readonly remoteOnly: boolean;
  readonly remoteCacheReadOnly: boolean;
  readonly noCache: boolean;
  readonly frameworkInference?: boolean;
  readonly outputLogs?: OutputLogs;
  readonly only: boolean;
  readonly parallel: boolean;
  readonly singlePackage: boolean;
  readonly apiUrl?: string;
  readonly token?: string;
  readonly team?: string;
  readonly preflight: boolean;
  readonly remoteCacheTimeoutSeconds?: number;
  readonly rootTurboJson?: string;
  readonly noColor: boolean;
  readonly dangerouslyDisablePackageManagerCheck: boolean;
  readonly dryRun?: "text" | "json";
  readonly graph?: string;
  readonly summarize: boolean;
  readonly profile?: string;
  readonly anonymousProfile?: string;
  readonly heap?: string;
  readonly trace?: string;
  readonly ui?: "tui" | "stream" | "stream-with-experimental-timestamps";
  readonly json: boolean;
  readonly logFile?: string;
  readonly logOrder?: "auto" | "stream" | "grouped";
  readonly logPrefix?: "auto" | "none" | "task";
}

const unsupportedCommands = new Set([
  "bin",
  "boundaries",
  "config",
  "devtools",
  "docs",
  "generate",
  "get-mfe-port",
  "link",
  "login",
  "logout",
  "scan",
  "telemetry",
  "unlink",
]);

export const isLaterGateCommand = (value: string): boolean =>
  unsupportedCommands.has(value);

const optionValue = (
  arguments_: ReadonlyArray<string>,
  index: number,
  option: string,
): readonly [string, number] => {
  const argument = arguments_[index]!;
  const equals = argument.indexOf("=");
  if (equals !== -1) {
    return [argument.slice(equals + 1), index];
  }
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new ConfigurationError({
      path: "<arguments>",
      message: `${option} requires a value`,
    });
  }
  return [value, index + 1];
};

export const parseRunArguments = (
  input: ReadonlyArray<string>,
): ParsedRunOptions => {
  const delimiter = input.indexOf("--");
  const arguments_ = delimiter === -1 ? input : input.slice(0, delimiter);
  const passThroughArguments =
    delimiter === -1 ? [] : input.slice(delimiter + 1);
  const start = arguments_[0] === "run" ? 1 : 0;
  const tasks: Array<string> = [];
  const filters: Array<string> = [];
  const globalDependencies: Array<string> = [];
  let cwd: string | undefined;
  let affected = false;
  let concurrency: string | undefined;
  let continueMode: ContinueMode | undefined;
  let environmentMode: EnvironmentMode | undefined;
  let cacheDirectory: string | undefined;
  let cacheSpecification: string | undefined;
  let force = false;
  let remoteOnly = false;
  let remoteCacheReadOnly = false;
  let noCache = false;
  let frameworkInference: boolean | undefined;
  let outputLogs: OutputLogs | undefined;
  let only = false;
  let parallel = false;
  let singlePackage = false;
  let apiUrl: string | undefined;
  let token: string | undefined;
  let team: string | undefined;
  let preflight = false;
  let remoteCacheTimeoutSeconds: number | undefined;
  let rootTurboJson: string | undefined;
  let noColor = false;
  let dangerouslyDisablePackageManagerCheck = false;
  let dryRun: "text" | "json" | undefined;
  let graph: string | undefined;
  let summarize = false;
  let profile: string | undefined;
  let anonymousProfile: string | undefined;
  let heap: string | undefined;
  let trace: string | undefined;
  let ui: ParsedRunOptions["ui"];
  let json = false;
  let logFile: string | undefined;
  let logOrder: ParsedRunOptions["logOrder"];
  let logPrefix: ParsedRunOptions["logPrefix"];
  for (let index = start; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (!argument.startsWith("-")) {
      tasks.push(argument);
      continue;
    }
    const [name] = argument.split("=", 1);
    switch (name) {
      case "--cwd": {
        [cwd, index] = optionValue(arguments_, index, name);
        break;
      }
      case "--filter":
      case "-F": {
        let value: string;
        [value, index] = optionValue(arguments_, index, name);
        filters.push(value);
        break;
      }
      case "--affected":
        affected = true;
        break;
      case "--concurrency":
        [concurrency, index] = optionValue(arguments_, index, name);
        break;
      case "--continue": {
        const value = argument.includes("=")
          ? argument.slice(argument.indexOf("=") + 1)
          : "dependencies-successful";
        if (
          !(["always", "dependencies-successful", "never"] as const).includes(
            value as ContinueMode,
          )
        ) {
          throw new ConfigurationError({
            path: "<arguments>",
            message: `invalid continue mode: ${value}`,
          });
        }
        continueMode = value as ContinueMode;
        break;
      }
      case "--env-mode": {
        let value: string;
        [value, index] = optionValue(arguments_, index, name);
        if (value !== "strict" && value !== "loose") {
          throw new ConfigurationError({
            path: "<arguments>",
            message: `invalid environment mode: ${value}`,
          });
        }
        environmentMode = value;
        break;
      }
      case "--cache-dir":
        [cacheDirectory, index] = optionValue(arguments_, index, name);
        break;
      case "--cache":
        [cacheSpecification, index] = optionValue(arguments_, index, name);
        break;
      case "--force":
        force = true;
        break;
      case "--remote-only":
        remoteOnly = true;
        break;
      case "--remote-cache-read-only":
        remoteCacheReadOnly = true;
        break;
      case "--no-cache":
        noCache = true;
        break;
      case "--framework-inference":
        frameworkInference = !argument.endsWith("=false");
        break;
      case "--output-logs": {
        let value: string;
        [value, index] = optionValue(arguments_, index, name);
        if (!Schema.is(OutputLogsSchema)(value)) {
          throw new ConfigurationError({
            path: "<arguments>",
            message: `invalid output log mode: ${value}`,
          });
        }
        outputLogs = value;
        break;
      }
      case "--only":
        only = true;
        break;
      case "--parallel":
        parallel = true;
        break;
      case "--single-package":
        singlePackage = true;
        break;
      case "--api":
        [apiUrl, index] = optionValue(arguments_, index, name);
        break;
      case "--token":
        [token, index] = optionValue(arguments_, index, name);
        break;
      case "--team":
        [team, index] = optionValue(arguments_, index, name);
        break;
      case "--preflight":
        preflight = true;
        break;
      case "--remote-cache-timeout": {
        let value: string;
        [value, index] = optionValue(arguments_, index, name);
        remoteCacheTimeoutSeconds = Number(value);
        if (
          value.trim() === "" ||
          !Number.isFinite(remoteCacheTimeoutSeconds) ||
          remoteCacheTimeoutSeconds < 0
        ) {
          throw new ConfigurationError({
            path: "<arguments>",
            message: `invalid remote cache timeout: ${value}`,
          });
        }
        break;
      }
      case "--root-turbo-json":
        [rootTurboJson, index] = optionValue(arguments_, index, name);
        break;
      case "--no-color":
        noColor = true;
        break;
      case "--dangerously-disable-package-manager-check":
        dangerouslyDisablePackageManagerCheck = true;
        break;
      case "--dry":
      case "--dry-run": {
        const adjacent = arguments_[index + 1];
        const consumesAdjacent =
          !argument.includes("=") &&
          (adjacent === "text" || adjacent === "json");
        const value = argument.includes("=")
          ? argument.slice(argument.indexOf("=") + 1)
          : consumesAdjacent
            ? adjacent
            : "text";
        if (consumesAdjacent) index += 1;
        if (value !== "text" && value !== "json") {
          throw new ConfigurationError({
            path: "<arguments>",
            message: `invalid dry-run format: ${value}`,
          });
        }
        dryRun = value;
        break;
      }
      case "--graph": {
        const adjacent = arguments_[index + 1];
        const consumesAdjacent =
          !argument.includes("=") &&
          adjacent !== undefined &&
          !adjacent.startsWith("-");
        graph = argument.includes("=")
          ? argument.slice(argument.indexOf("=") + 1)
          : consumesAdjacent
            ? adjacent
            : "";
        if (consumesAdjacent) index += 1;
        break;
      }
      case "--summarize": {
        const adjacent = arguments_[index + 1];
        const consumesAdjacent = adjacent === "true" || adjacent === "false";
        summarize = argument.includes("=")
          ? !argument.endsWith("=false")
          : consumesAdjacent
            ? adjacent === "true"
            : true;
        if (consumesAdjacent) index += 1;
        break;
      }
      case "--profile": {
        const adjacent = arguments_[index + 1];
        if (argument.includes("=")) {
          profile = argument.slice(argument.indexOf("=") + 1);
        } else if (adjacent !== undefined && !adjacent.startsWith("-")) {
          profile = adjacent;
          index += 1;
        } else {
          profile = "";
        }
        break;
      }
      case "--anon-profile": {
        const adjacent = arguments_[index + 1];
        if (argument.includes("=")) {
          anonymousProfile = argument.slice(argument.indexOf("=") + 1);
        } else if (adjacent !== undefined && !adjacent.startsWith("-")) {
          anonymousProfile = adjacent;
          index += 1;
        } else {
          anonymousProfile = "";
        }
        break;
      }
      case "--heap":
        [heap, index] = optionValue(arguments_, index, name);
        break;
      case "--trace":
        [trace, index] = optionValue(arguments_, index, name);
        break;
      case "--ui": {
        let value: string;
        [value, index] = optionValue(arguments_, index, name);
        if (
          value !== "tui" &&
          value !== "stream" &&
          value !== "stream-with-experimental-timestamps"
        ) {
          throw new ConfigurationError({
            path: "<arguments>",
            message: `invalid UI mode: ${value}`,
          });
        }
        ui = value;
        break;
      }
      case "--json":
        json = true;
        break;
      case "--log-file": {
        const adjacent = arguments_[index + 1];
        const consumesAdjacent =
          !argument.includes("=") &&
          adjacent !== undefined &&
          !adjacent.startsWith("-");
        logFile = argument.includes("=")
          ? argument.slice(argument.indexOf("=") + 1)
          : consumesAdjacent
            ? adjacent
            : "";
        if (consumesAdjacent) index += 1;
        break;
      }
      case "--log-order": {
        let value: string;
        [value, index] = optionValue(arguments_, index, name);
        if (value !== "auto" && value !== "stream" && value !== "grouped") {
          throw new ConfigurationError({
            path: "<arguments>",
            message: `invalid log order: ${value}`,
          });
        }
        logOrder = value;
        break;
      }
      case "--log-prefix": {
        let value: string;
        [value, index] = optionValue(arguments_, index, name);
        if (value !== "auto" && value !== "none" && value !== "task") {
          throw new ConfigurationError({
            path: "<arguments>",
            message: `invalid log prefix: ${value}`,
          });
        }
        logPrefix = value;
        break;
      }
      case "--color":
      case "--no-daemon":
      case "--daemon":
      case "--no-update-notifier":
      case "--skip-infer":
      case "--experimental-otel-enabled":
      case "--experimental-otel-metrics-run-summary":
      case "--experimental-otel-metrics-task-details":
      case "--experimental-otel-use-remote-cache-token":
        break;
      case "--verbosity": {
        [, index] = optionValue(arguments_, index, name);
        break;
      }
      case "--global-deps": {
        let value: string;
        [value, index] = optionValue(arguments_, index, name);
        globalDependencies.push(value);
        break;
      }
      case "--cache-workers":
      case "--login":
      case "--experimental-otel-protocol":
      case "--experimental-otel-endpoint":
      case "--experimental-otel-timeout-ms":
      case "--experimental-otel-interval-ms":
      case "--experimental-otel-header":
      case "--experimental-otel-resource": {
        [, index] = optionValue(arguments_, index, name);
        break;
      }
      default:
        throw new ConfigurationError({
          path: "<arguments>",
          message: `unknown option: ${argument}`,
        });
    }
  }
  if (tasks.length === 0) {
    throw new ConfigurationError({
      path: "<arguments>",
      message: "at least one task is required",
    });
  }
  return {
    tasks,
    passThroughArguments,
    cwd,
    filters,
    globalDependencies,
    affected,
    concurrency,
    continueMode,
    environmentMode,
    cacheDirectory,
    cacheSpecification,
    force,
    remoteOnly,
    remoteCacheReadOnly,
    noCache,
    frameworkInference,
    outputLogs,
    only,
    parallel,
    singlePackage,
    apiUrl,
    token,
    team,
    preflight,
    remoteCacheTimeoutSeconds,
    rootTurboJson,
    noColor,
    dangerouslyDisablePackageManagerCheck,
    dryRun,
    graph,
    summarize,
    profile,
    anonymousProfile,
    heap,
    trace,
    ui,
    json,
    logFile,
    logOrder,
    logPrefix,
  };
};

export const parseConcurrency = (
  value: string | undefined,
  availableParallelism: number,
): number => {
  if (value === undefined) {
    return 10;
  }
  if (value.endsWith("%")) {
    const percentage = Number(value.slice(0, -1));
    if (!Number.isFinite(percentage) || percentage <= 0) {
      throw new ConfigurationError({
        path: "<arguments>",
        message: `invalid concurrency: ${value}`,
      });
    }
    return Math.max(
      1,
      Math.ceil((percentage / 100) * Math.max(1, availableParallelism)),
    );
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new ConfigurationError({
      path: "<arguments>",
      message: `invalid concurrency: ${value}`,
    });
  }
  return count;
};
