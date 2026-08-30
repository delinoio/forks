import type { Scope } from "effect";
import { Context, Effect, Layer, Schedule } from "effect";
import type { BoundaryError, ProcessExecutionError } from "./errors.js";

export interface ExecutionRequest {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string;
}

export interface ExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface FileSystemOperations {
  readonly readText: (path: string) => Effect.Effect<string, BoundaryError>;
  readonly writeText: (
    path: string,
    contents: string,
  ) => Effect.Effect<void, BoundaryError>;
  readonly temporaryDirectory: Effect.Effect<
    string,
    BoundaryError,
    Scope.Scope
  >;
}

export class FileSystemService extends Context.Tag(
  "turbo-ts/FileSystemService",
)<FileSystemService, FileSystemOperations>() {}

export interface ProcessOperations {
  readonly run: (
    request: ExecutionRequest,
  ) => Effect.Effect<ExecutionResult, ProcessExecutionError, Scope.Scope>;
}

export class ProcessService extends Context.Tag("turbo-ts/ProcessService")<
  ProcessService,
  ProcessOperations
>() {}

export interface EnvironmentOperations {
  readonly argv: Effect.Effect<ReadonlyArray<string>>;
  readonly cwd: Effect.Effect<string>;
  readonly get: (name: string) => Effect.Effect<string | undefined>;
  readonly entries: Effect.Effect<Readonly<Record<string, string | undefined>>>;
}

export class EnvironmentService extends Context.Tag(
  "turbo-ts/EnvironmentService",
)<EnvironmentService, EnvironmentOperations>() {}

export interface TerminalOperations {
  readonly writeStdout: (text: string) => Effect.Effect<void, BoundaryError>;
  readonly writeStderr: (text: string) => Effect.Effect<void, BoundaryError>;
  readonly colorEnabled: Effect.Effect<boolean>;
}

export class TerminalService extends Context.Tag("turbo-ts/TerminalService")<
  TerminalService,
  TerminalOperations
>() {}

export interface ClockOperations {
  readonly now: Effect.Effect<number>;
  readonly sleep: (milliseconds: number) => Effect.Effect<void>;
}

export class ClockService extends Context.Tag("turbo-ts/ClockService")<
  ClockService,
  ClockOperations
>() {}

export interface RandomnessOperations {
  readonly uuidV7: Effect.Effect<string, BoundaryError>;
}

export class RandomnessService extends Context.Tag(
  "turbo-ts/RandomnessService",
)<RandomnessService, RandomnessOperations>() {}

export interface BoundaryOperations {
  readonly execute: (operation: string) => Effect.Effect<never, BoundaryError>;
}

export class GitService extends Context.Tag("turbo-ts/GitService")<
  GitService,
  BoundaryOperations
>() {}
export class PackageManagerService extends Context.Tag(
  "turbo-ts/PackageManagerService",
)<PackageManagerService, BoundaryOperations>() {}
export class SignalService extends Context.Tag("turbo-ts/SignalService")<
  SignalService,
  BoundaryOperations
>() {}
export class ConcurrencyService extends Context.Tag(
  "turbo-ts/ConcurrencyService",
)<ConcurrencyService, BoundaryOperations>() {}
export class HttpService extends Context.Tag("turbo-ts/HttpService")<
  HttpService,
  BoundaryOperations
>() {}
export class CredentialService extends Context.Tag(
  "turbo-ts/CredentialService",
)<CredentialService, BoundaryOperations>() {}
export class CacheService extends Context.Tag("turbo-ts/CacheService")<
  CacheService,
  BoundaryOperations
>() {}
export class DaemonService extends Context.Tag("turbo-ts/DaemonService")<
  DaemonService,
  BoundaryOperations
>() {}
export class TelemetryService extends Context.Tag("turbo-ts/TelemetryService")<
  TelemetryService,
  BoundaryOperations
>() {}
export class ObservabilityService extends Context.Tag(
  "turbo-ts/ObservabilityService",
)<ObservabilityService, BoundaryOperations>() {}

export interface RetryScheduleOperations {
  readonly transient: Schedule.Schedule<unknown, unknown>;
}

export class RetryScheduleService extends Context.Tag(
  "turbo-ts/RetryScheduleService",
)<RetryScheduleService, RetryScheduleOperations>() {}

export const deterministicRetryLayer = Layer.succeed(RetryScheduleService, {
  transient: Schedule.recurs(2),
});
