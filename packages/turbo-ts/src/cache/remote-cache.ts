import { Effect, Schedule } from "effect";
import { joinPath } from "../core/path.js";
import { CacheError, CacheRollbackError } from "../effect/errors.js";
import {
  CompressionService,
  FileSystemService,
  HttpService,
  RetryScheduleService,
  SigningService,
} from "../effect/services.js";
import { packageVersion } from "../version.js";
import { type ArchiveEntry, createTarArchive } from "./archive.js";
import { parseTarArchiveFile } from "./archive-file.js";
import {
  maximumCacheArchiveBytes,
  maximumCacheArtifactBytes,
} from "./limits.js";
import { type CacheRestoreScope, restoreArchiveEntries } from "./restore.js";

export interface RemoteCacheOptions {
  readonly apiUrl: string;
  readonly token?: string;
  readonly teamId?: string;
  readonly teamSlug?: string;
  readonly timeoutMilliseconds: number;
  readonly uploadTimeoutMilliseconds: number;
  readonly preflight: boolean;
  readonly signatureKey?: string;
  readonly requireSignature: boolean;
}

const remoteError = (
  path: string,
  cause: unknown,
  retryable = false,
): CacheError => new CacheError({ path, message: String(cause), retryable });

const isTransientStatus = (status: number): boolean =>
  status === 408 || status === 429 || (status >= 500 && status <= 599);

const maximumRemoteControlResponseBytes = 64 * 1024;

const retryTransientCacheErrors = Schedule.whileInput((error: unknown) =>
  error instanceof CacheError ? error.retryable : false,
);

const artifactUrl = (options: RemoteCacheOptions, hash: string): string => {
  const url = new URL(options.apiUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v8/artifacts/${hash}`;
  url.hash = "";
  if (options.teamId?.startsWith("team_") === true) {
    url.searchParams.set("teamId", options.teamId);
  } else if (options.teamSlug !== undefined) {
    url.searchParams.set("slug", options.teamSlug);
  }
  return url.toString();
};

const requestHeaders = (
  options: RemoteCacheOptions,
): Record<string, string> => ({
  "user-agent": `turbo-ts/${packageVersion}`,
  ...(options.token === undefined
    ? {}
    : { authorization: `Bearer ${options.token}` }),
});

const preflight = (
  url: string,
  options: RemoteCacheOptions,
): Effect.Effect<void, CacheError, HttpService | RetryScheduleService> =>
  Effect.gen(function* () {
    if (!options.preflight) {
      return;
    }
    const http = yield* HttpService;
    const retry = yield* RetryScheduleService;
    const response = yield* http
      .request({
        url,
        method: "OPTIONS",
        headers: requestHeaders(options),
        timeoutMilliseconds: options.timeoutMilliseconds,
        maxResponseBodyBytes: maximumRemoteControlResponseBytes,
      })
      .pipe(
        Effect.mapError((error) =>
          remoteError(url, error.message, error.retryable),
        ),
        Effect.flatMap((response) =>
          isTransientStatus(response.status)
            ? Effect.fail(
                remoteError(url, `preflight returned ${response.status}`, true),
              )
            : Effect.succeed(response),
        ),
        Effect.retry(retry.transient.pipe(retryTransientCacheErrors)),
      );
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        remoteError(url, `preflight returned ${response.status}`),
      );
    }
  });

export const restoreRemoteCache = (
  root: string,
  options: RemoteCacheOptions,
  hash: string,
  scope: CacheRestoreScope,
): Effect.Effect<
  boolean,
  CacheError | CacheRollbackError,
  | HttpService
  | CompressionService
  | FileSystemService
  | RetryScheduleService
  | SigningService
> =>
  Effect.gen(function* () {
    const http = yield* HttpService;
    const compression = yield* CompressionService;
    const fileSystem = yield* FileSystemService;
    const retry = yield* RetryScheduleService;
    const signing = yield* SigningService;
    const url = artifactUrl(options, hash);
    yield* preflight(url, options);
    const response = yield* http
      .request({
        url,
        method: "GET",
        headers: requestHeaders(options),
        timeoutMilliseconds: options.timeoutMilliseconds,
        maxResponseBodyBytes: maximumCacheArtifactBytes,
      })
      .pipe(
        Effect.mapError((error) =>
          remoteError(url, error.message, error.retryable),
        ),
        Effect.flatMap((response) =>
          isTransientStatus(response.status)
            ? Effect.fail(
                remoteError(
                  url,
                  `remote cache returned ${response.status}`,
                  true,
                ),
              )
            : Effect.succeed(response),
        ),
        Effect.retry(retry.transient.pipe(retryTransientCacheErrors)),
      );
    if (response.status === 404) {
      return false;
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        remoteError(url, `remote cache returned ${response.status}`),
      );
    }
    if (options.requireSignature) {
      if (options.signatureKey === undefined) {
        return yield* Effect.fail(
          remoteError(url, "remote cache signature key is missing"),
        );
      }
      const expected = yield* signing
        .hmacSha256(options.signatureKey, response.body)
        .pipe(Effect.mapError((error) => remoteError(url, error.message)));
      const actual = response.headers["x-artifact-tag"];
      if (actual === undefined || !(yield* signing.equal(actual, expected))) {
        return yield* Effect.fail(
          remoteError(url, "remote cache signature is invalid"),
        );
      }
    }
    yield* fileSystem
      .withTemporaryDirectory((directory) => {
        const archivePath = joinPath(directory, "remote-cache.tar");
        return compression
          .decompressZstdToFile(
            response.body,
            archivePath,
            maximumCacheArchiveBytes,
          )
          .pipe(
            Effect.mapError((error) => remoteError(url, error.message)),
            Effect.flatMap(() => parseTarArchiveFile(archivePath)),
            Effect.flatMap((entries) =>
              restoreArchiveEntries(root, entries, scope),
            ),
          );
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "CacheError" || error._tag === "CacheRollbackError"
            ? error
            : remoteError(url, error.message),
        ),
      );
    return true;
  });

export const writeRemoteCache = (
  options: RemoteCacheOptions,
  hash: string,
  entries: ReadonlyArray<ArchiveEntry>,
  durationMilliseconds: number,
): Effect.Effect<
  void,
  CacheError,
  HttpService | CompressionService | RetryScheduleService | SigningService
> =>
  Effect.gen(function* () {
    const http = yield* HttpService;
    const compression = yield* CompressionService;
    const retry = yield* RetryScheduleService;
    const signing = yield* SigningService;
    const url = artifactUrl(options, hash);
    yield* preflight(url, options);
    let archive: Uint8Array;
    try {
      archive = createTarArchive(entries);
    } catch (cause) {
      return yield* Effect.fail(remoteError(url, cause));
    }
    const compressed = yield* compression
      .compressZstd(archive)
      .pipe(Effect.mapError((error) => remoteError(url, error.message)));
    const headers: Record<string, string> = {
      ...requestHeaders(options),
      "content-type": "application/octet-stream",
      "x-artifact-duration": String(
        Math.max(0, Math.round(durationMilliseconds)),
      ),
    };
    if (options.requireSignature) {
      if (options.signatureKey === undefined) {
        return yield* Effect.fail(
          remoteError(url, "remote cache signature key is missing"),
        );
      }
      headers["x-artifact-tag"] = yield* signing
        .hmacSha256(options.signatureKey, compressed)
        .pipe(Effect.mapError((error) => remoteError(url, error.message)));
    }
    const response = yield* http
      .request({
        url,
        method: "PUT",
        headers,
        body: compressed,
        timeoutMilliseconds: options.uploadTimeoutMilliseconds,
        maxResponseBodyBytes: maximumRemoteControlResponseBytes,
      })
      .pipe(
        Effect.mapError((error) =>
          remoteError(url, error.message, error.retryable),
        ),
        Effect.flatMap((response) =>
          isTransientStatus(response.status)
            ? Effect.fail(
                remoteError(
                  url,
                  `remote cache returned ${response.status}`,
                  true,
                ),
              )
            : Effect.succeed(response),
        ),
        Effect.retry(retry.transient.pipe(retryTransientCacheErrors)),
      );
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        remoteError(url, `remote cache returned ${response.status}`),
      );
    }
  });
