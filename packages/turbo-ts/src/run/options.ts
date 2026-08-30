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
  readonly apiUrl?: string;
  readonly token?: string;
  readonly team?: string;
  readonly preflight: boolean;
  readonly remoteCacheTimeoutSeconds?: number;
  readonly rootTurboJson?: string;
  readonly noColor: boolean;
  readonly dangerouslyDisablePackageManagerCheck: boolean;
}

const unsupportedCommands = new Set([
  "bin",
  "boundaries",
  "completion",
  "config",
  "daemon",
  "devtools",
  "docs",
  "generate",
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
  let apiUrl: string | undefined;
  let token: string | undefined;
  let team: string | undefined;
  let preflight = false;
  let remoteCacheTimeoutSeconds: number | undefined;
  let rootTurboJson: string | undefined;
  let noColor = false;
  let dangerouslyDisablePackageManagerCheck = false;
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
      case "--color":
      case "--no-daemon":
      case "--daemon":
      case "--no-update-notifier":
        break;
      case "--ui":
      case "--verbosity": {
        if (!argument.includes("=")) {
          index += 1;
        }
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
    apiUrl,
    token,
    team,
    preflight,
    remoteCacheTimeoutSeconds,
    rootTurboJson,
    noColor,
    dangerouslyDisablePackageManagerCheck,
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
