import { Schema } from "effect";
import {
  type OpenTelemetryOptions,
  parseCommonArguments,
} from "../cli/common-options.js";
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
  readonly cacheWorkers?: number;
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
  readonly noUpdateNotifier: boolean;
  readonly loginUrl?: string;
  readonly verbosity?: number;
  readonly openTelemetry: OpenTelemetryOptions;
  readonly daemonPreference?: boolean;
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
  const parserArguments = delimiter === -1 ? input : input.slice(0, delimiter);
  const passThroughArguments =
    delimiter === -1 ? [] : input.slice(delimiter + 1);
  const start = parserArguments[0] === "run" ? 1 : 0;
  const common = parseCommonArguments(parserArguments.slice(start));
  const arguments_ = common.remaining;
  const tasks: Array<string> = [];
  const filters: Array<string> = [];
  const globalDependencies: Array<string> = [];
  let affected = false;
  let concurrency: string | undefined;
  let continueMode: ContinueMode | undefined;
  let environmentMode: EnvironmentMode | undefined;
  let cacheDirectory: string | undefined;
  let cacheSpecification: string | undefined;
  let cacheWorkers: number | undefined;
  let force = false;
  let remoteOnly = false;
  let remoteCacheReadOnly = false;
  let noCache = false;
  let frameworkInference: boolean | undefined;
  let outputLogs: OutputLogs | undefined;
  let only = false;
  let parallel = false;
  let singlePackage = false;
  let daemonPreference: boolean | undefined;
  let dryRun: "text" | "json" | undefined;
  let graph: string | undefined;
  let summarize = false;
  let profile: string | undefined;
  let anonymousProfile: string | undefined;
  let json = false;
  let logFile: string | undefined;
  let logOrder: ParsedRunOptions["logOrder"];
  let logPrefix: ParsedRunOptions["logPrefix"];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (!argument.startsWith("-")) {
      tasks.push(argument);
      continue;
    }
    const [name] = argument.split("=", 1);
    switch (name) {
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
        const consumesAdjacent =
          !argument.includes("=") &&
          (adjacent === "true" || adjacent === "false");
        const explicitValue = argument.includes("=")
          ? argument.slice(argument.indexOf("=") + 1)
          : undefined;
        if (
          explicitValue !== undefined &&
          explicitValue !== "true" &&
          explicitValue !== "false"
        ) {
          throw new ConfigurationError({
            path: "<arguments>",
            message: `invalid summarize value: ${explicitValue}`,
          });
        }
        summarize =
          explicitValue !== undefined
            ? explicitValue === "true"
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
      case "--no-daemon":
        daemonPreference = false;
        break;
      case "--daemon":
        daemonPreference = true;
        break;
      case "--global-deps": {
        let value: string;
        [value, index] = optionValue(arguments_, index, name);
        globalDependencies.push(value);
        break;
      }
      case "--cache-workers": {
        let value: string;
        [value, index] = optionValue(arguments_, index, name);
        const parsedCount = Number(value);
        if (!Number.isSafeInteger(parsedCount) || parsedCount <= 0) {
          throw new ConfigurationError({
            path: "<arguments>",
            message: `invalid cache worker count: ${value}`,
          });
        }
        cacheWorkers = parsedCount;
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
    cwd: common.options.cwd,
    filters,
    globalDependencies,
    affected,
    concurrency,
    continueMode,
    environmentMode,
    cacheDirectory,
    cacheSpecification,
    cacheWorkers,
    force,
    remoteOnly,
    remoteCacheReadOnly,
    noCache,
    frameworkInference,
    outputLogs,
    only,
    parallel,
    singlePackage,
    apiUrl: common.options.apiUrl,
    token: common.options.token,
    team: common.options.team,
    preflight: common.options.preflight,
    remoteCacheTimeoutSeconds: common.options.remoteCacheTimeoutSeconds,
    rootTurboJson: common.options.rootTurboJson,
    noColor: common.options.color === false,
    noUpdateNotifier: common.options.noUpdateNotifier,
    loginUrl: common.options.loginUrl,
    verbosity: common.options.verbosity,
    openTelemetry: common.options.openTelemetry,
    daemonPreference,
    dangerouslyDisablePackageManagerCheck:
      common.options.dangerouslyDisablePackageManagerCheck,
    dryRun,
    graph,
    summarize,
    profile,
    anonymousProfile,
    heap: common.options.heap,
    trace: common.options.trace,
    ui: common.options.ui,
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
