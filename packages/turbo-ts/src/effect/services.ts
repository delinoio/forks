import type { Scope, Stream } from "effect";
import { Context, Effect, Layer, Schedule } from "effect";
import type { BoundaryError, ProcessExecutionError } from "./errors.js";

export type OutputChunkHandler =
  | ((chunk: string, level: "stdout" | "stderr") => void)
  | ((chunk: string, level: "stdout" | "stderr") => PromiseLike<void>);

export interface ExecutionRequest {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly inheritEnvironment?: boolean;
  readonly stdin?: string;
  readonly stdio?: "capture" | "inherit";
  readonly onOutputChunk?: OutputChunkHandler;
  readonly maxCapturedOutputCharacters?: number;
}

export interface ExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly combinedOutput: string;
}

export type BinaryExecutionRequest = Omit<
  ExecutionRequest,
  "maxCapturedOutputCharacters" | "onOutputChunk" | "stdio"
>;

export interface BinaryExecutionResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface FileSystemOperations {
  readonly readText: (path: string) => Effect.Effect<string, BoundaryError>;
  readonly readTextChunks: (
    path: string,
  ) => Stream.Stream<string, BoundaryError>;
  readonly readBytes: (
    path: string,
  ) => Effect.Effect<Uint8Array, BoundaryError>;
  readonly readBytesRange: (
    path: string,
    offset: number,
    length: number,
  ) => Effect.Effect<Uint8Array, BoundaryError>;
  readonly readLink: (path: string) => Effect.Effect<string, BoundaryError>;
  readonly exists: (path: string) => Effect.Effect<boolean, BoundaryError>;
  readonly list: (
    path: string,
  ) => Effect.Effect<ReadonlyArray<DirectoryEntry>, BoundaryError>;
  readonly metadata: (
    path: string,
  ) => Effect.Effect<FileMetadata, BoundaryError>;
  readonly makeDirectory: (path: string) => Effect.Effect<void, BoundaryError>;
  readonly createExclusiveFile: (
    path: string,
    contents: string,
  ) => Effect.Effect<boolean, BoundaryError>;
  readonly writeText: (
    path: string,
    contents: string,
  ) => Effect.Effect<void, BoundaryError>;
  readonly writeTextAtomic: (
    path: string,
    contents: string,
    mode?: number,
  ) => Effect.Effect<void, BoundaryError>;
  readonly appendText: (
    path: string,
    contents: string,
  ) => Effect.Effect<void, BoundaryError>;
  readonly writeBytes: (
    path: string,
    contents: Uint8Array,
  ) => Effect.Effect<void, BoundaryError>;
  readonly copyBytesRange: (
    source: string,
    offset: number,
    length: number,
    destination: string,
  ) => Effect.Effect<void, BoundaryError>;
  readonly createSymlink: (
    target: string,
    path: string,
  ) => Effect.Effect<void, BoundaryError>;
  readonly setFileMetadata: (
    path: string,
    mode: number,
    modifiedMilliseconds: number,
  ) => Effect.Effect<void, BoundaryError>;
  readonly rename: (
    source: string,
    destination: string,
  ) => Effect.Effect<void, BoundaryError>;
  readonly remove: (path: string) => Effect.Effect<void, BoundaryError>;
  readonly copyFile: (
    source: string,
    destination: string,
  ) => Effect.Effect<void, BoundaryError>;
  readonly realPath: (path: string) => Effect.Effect<string, BoundaryError>;
  readonly withTemporaryDirectory: <A, E, R>(
    use: (path: string) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | BoundaryError, R>;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly kind: "directory" | "file" | "symlink" | "other";
}

export interface FileMetadata {
  readonly kind: "directory" | "file" | "symlink" | "other";
  readonly mode: number;
  readonly modifiedMilliseconds: number;
  readonly size: number;
}

export class FileSystemService extends Context.Tag(
  "turbo-ts/FileSystemService",
)<FileSystemService, FileSystemOperations>() {}

export interface ProcessOperations {
  readonly run: (
    request: ExecutionRequest,
  ) => Effect.Effect<ExecutionResult, ProcessExecutionError, Scope.Scope>;
  readonly runBytes: (
    request: BinaryExecutionRequest,
  ) => Effect.Effect<BinaryExecutionResult, ProcessExecutionError, Scope.Scope>;
  readonly spawnDetached?: (
    request: BinaryExecutionRequest,
  ) => Effect.Effect<number, ProcessExecutionError>;
  readonly isProcessAlive?: (pid: number) => Effect.Effect<boolean>;
  readonly terminateProcess?: (
    pid: number,
    force: boolean,
  ) => Effect.Effect<void, ProcessExecutionError>;
}

export class ProcessService extends Context.Tag("turbo-ts/ProcessService")<
  ProcessService,
  ProcessOperations
>() {}

export interface EnvironmentOperations {
  readonly argv: Effect.Effect<ReadonlyArray<string>>;
  readonly cwd: Effect.Effect<string>;
  readonly platform: Effect.Effect<NodeJS.Platform>;
  readonly executablePath?: Effect.Effect<string>;
  readonly get: (name: string) => Effect.Effect<string | undefined>;
  readonly entries: Effect.Effect<Readonly<Record<string, string | undefined>>>;
}

export class EnvironmentService extends Context.Tag(
  "turbo-ts/EnvironmentService",
)<EnvironmentService, EnvironmentOperations>() {}

export interface ExitStatusOperations {
  readonly set: (code: number) => Effect.Effect<void>;
}

export class ExitStatusService extends Context.Tag(
  "turbo-ts/ExitStatusService",
)<ExitStatusService, ExitStatusOperations>() {}

export interface TerminalOperations {
  readonly writeStdout: (text: string) => Effect.Effect<void, BoundaryError>;
  readonly writeStderr: (text: string) => Effect.Effect<void, BoundaryError>;
  readonly stdoutColorEnabled: Effect.Effect<boolean>;
  readonly stderrColorEnabled: Effect.Effect<boolean>;
  readonly stdinIsTerminal?: Effect.Effect<boolean>;
  readonly stdoutIsTerminal?: Effect.Effect<boolean>;
  readonly columns?: Effect.Effect<number>;
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
export interface FileChange {
  readonly path: string;
  readonly kind: "create" | "modify" | "remove" | "rename" | "unknown";
  readonly entryKind?: FileMetadata["kind"];
}

export interface FileWatcherOperations {
  readonly watch: (root: string) => Stream.Stream<FileChange, BoundaryError>;
}

export class FileWatcherService extends Context.Tag(
  "turbo-ts/FileWatcherService",
)<FileWatcherService, FileWatcherOperations>() {}

export interface SignalOperations {
  readonly signals: Stream.Stream<"SIGINT" | "SIGTERM">;
}

export class SignalService extends Context.Tag("turbo-ts/SignalService")<
  SignalService,
  SignalOperations
>() {}
export interface ConcurrencyOperations {
  readonly availableParallelism: Effect.Effect<number>;
}

export class ConcurrencyService extends Context.Tag(
  "turbo-ts/ConcurrencyService",
)<ConcurrencyService, ConcurrencyOperations>() {}
export interface HttpRequest {
  readonly url: string;
  readonly method: "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array | string;
  readonly timeoutMilliseconds?: number;
  readonly maxResponseBodyBytes?: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export type HttpDownloadRequest = Omit<HttpRequest, "body">;

export interface HttpFileResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

export interface HttpOperations {
  readonly request: (
    request: HttpRequest,
  ) => Effect.Effect<HttpResponse, BoundaryError>;
  readonly downloadToFile: (
    request: HttpDownloadRequest,
    destination: string,
  ) => Effect.Effect<HttpFileResponse, BoundaryError>;
}

export class HttpService extends Context.Tag("turbo-ts/HttpService")<
  HttpService,
  HttpOperations
>() {}
export class CredentialService extends Context.Tag(
  "turbo-ts/CredentialService",
)<CredentialService, BoundaryOperations>() {}
export class CacheService extends Context.Tag("turbo-ts/CacheService")<
  CacheService,
  BoundaryOperations
>() {}
export interface CompressionOperations {
  readonly compressZstd: (
    contents: Uint8Array,
  ) => Effect.Effect<Uint8Array, BoundaryError>;
  readonly decompressZstd: (
    contents: Uint8Array,
    maxOutputBytes?: number,
  ) => Effect.Effect<Uint8Array, BoundaryError>;
  readonly decompressZstdToFile: (
    contents: Uint8Array,
    destination: string,
    maxOutputBytes?: number,
  ) => Effect.Effect<void, BoundaryError>;
  readonly decompressZstdFileToFile: (
    source: string,
    destination: string,
    maxOutputBytes?: number,
  ) => Effect.Effect<void, BoundaryError>;
}

export class CompressionService extends Context.Tag(
  "turbo-ts/CompressionService",
)<CompressionService, CompressionOperations>() {}
export interface SigningOperations {
  readonly hmacSha256: (
    key: string,
    contents: Uint8Array,
  ) => Effect.Effect<string, BoundaryError>;
  readonly hmacSha256File: (
    key: string,
    path: string,
  ) => Effect.Effect<string, BoundaryError>;
  readonly equal: (left: string, right: string) => Effect.Effect<boolean>;
}

export class SigningService extends Context.Tag("turbo-ts/SigningService")<
  SigningService,
  SigningOperations
>() {}
export interface DigestOperations {
  readonly sha256?: (
    value: string | Uint8Array,
  ) => Effect.Effect<string, BoundaryError>;
  readonly gitBlobSha1: (
    contents: Uint8Array,
  ) => Effect.Effect<string, BoundaryError>;
  readonly gitBlobSha1File: (
    path: string,
  ) => Effect.Effect<string, BoundaryError>;
  readonly xxhash64File: (path: string) => Effect.Effect<string, BoundaryError>;
}

export class DigestService extends Context.Tag("turbo-ts/DigestService")<
  DigestService,
  DigestOperations
>() {}
export const DaemonMethod = {
  discoverPackages: "DiscoverPackages",
  getChangedOutputs: "GetChangedOutputs",
  hello: "Hello",
  notifyOutputsWritten: "NotifyOutputsWritten",
  shutdown: "Shutdown",
  status: "Status",
} as const;

export type DaemonMethod = (typeof DaemonMethod)[keyof typeof DaemonMethod];

export interface DaemonRequest {
  readonly id: string;
  readonly method: DaemonMethod;
  readonly params?: unknown;
}

export interface DaemonResponse {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: string;
}

export interface DaemonConnection {
  readonly requests: Stream.Stream<DaemonRequest, BoundaryError>;
  readonly respond: (
    response: DaemonResponse,
  ) => Effect.Effect<void, BoundaryError>;
}

export interface DaemonOperations {
  readonly serve: (
    endpoint: string,
  ) => Stream.Stream<DaemonConnection, BoundaryError>;
  readonly request: (
    endpoint: string,
    request: DaemonRequest,
    timeoutMilliseconds?: number,
  ) => Effect.Effect<DaemonResponse, BoundaryError>;
}

export class DaemonService extends Context.Tag("turbo-ts/DaemonService")<
  DaemonService,
  DaemonOperations
>() {}

export interface LoopbackHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface LoopbackHttpResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: Uint8Array | string;
}

export interface LoopbackHttpServer {
  readonly port: number;
  readonly closed: Effect.Effect<void, BoundaryError>;
}

export interface LoopbackHttpOperations {
  readonly serve: (
    port: number,
    handler: (
      request: LoopbackHttpRequest,
    ) => Effect.Effect<LoopbackHttpResponse, BoundaryError>,
  ) => Effect.Effect<LoopbackHttpServer, BoundaryError, Scope.Scope>;
}

export class LoopbackHttpService extends Context.Tag(
  "turbo-ts/LoopbackHttpService",
)<LoopbackHttpService, LoopbackHttpOperations>() {}

export interface RuntimeProfileOperations {
  readonly heapSnapshot: (path: string) => Effect.Effect<void, BoundaryError>;
  readonly writeTrace: (
    path: string,
    events: ReadonlyArray<Readonly<Record<string, unknown>>>,
  ) => Effect.Effect<void, BoundaryError>;
}

export class RuntimeProfileService extends Context.Tag(
  "turbo-ts/RuntimeProfileService",
)<RuntimeProfileService, RuntimeProfileOperations>() {}

export interface SystemInformation {
  readonly architecture: string;
  readonly operatingSystem: string;
  readonly kernelRelease: string;
  readonly availableMemoryMegabytes: number;
  readonly availableCpuCores: number;
  readonly temporaryDirectory: string;
  readonly userIdentifier: string;
  readonly processIdentifier: number;
}

export interface SystemOperations {
  readonly information: Effect.Effect<SystemInformation>;
}

export class SystemService extends Context.Tag("turbo-ts/SystemService")<
  SystemService,
  SystemOperations
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
