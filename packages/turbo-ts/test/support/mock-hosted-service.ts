import { createServer } from "node:http";
import { Context, Effect, Layer } from "effect";
import { BoundaryError } from "../../src/effect/errors.js";

export interface ScriptedResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface MockHostedOperations {
  readonly baseUrl: string;
  readonly requests: ReadonlyArray<RecordedRequest>;
  readonly request: (
    path: string,
    init?: RequestInit,
  ) => Effect.Effect<
    { readonly status: number; readonly body: string },
    BoundaryError
  >;
}

export class MockHostedService extends Context.Tag(
  "turbo-ts/MockHostedService",
)<MockHostedService, MockHostedOperations>() {}

const redactHeaders = (
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      /authorization|token|signature|cookie/i.test(name)
        ? "[REDACTED]"
        : Array.isArray(value)
          ? value.join(",")
          : (value ?? ""),
    ]),
  );

export const makeMockHostedLayer = (
  script: ReadonlyArray<ScriptedResponse>,
): Layer.Layer<MockHostedService, BoundaryError> =>
  Layer.scoped(
    MockHostedService,
    Effect.acquireRelease(
      Effect.async<
        {
          readonly service: MockHostedOperations;
          readonly close: () => Effect.Effect<void>;
        },
        BoundaryError
      >((resume) => {
        const requests: Array<RecordedRequest> = [];
        const responses = [...script];
        const server = createServer((request, response) => {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => {
            body += chunk;
          });
          request.on("end", () => {
            requests.push({
              method: request.method ?? "GET",
              path: request.url ?? "/",
              headers: redactHeaders(request.headers),
              body,
            });
            const next = responses.shift() ?? {
              status: 500,
              body: "unscripted",
            };
            response.writeHead(next.status, next.headers);
            response.end(next.body ?? "");
          });
        });
        server.once("error", (cause) =>
          resume(
            Effect.fail(
              new BoundaryError({
                boundary: "mock-hosted-service",
                message: String(cause),
                retryable: false,
              }),
            ),
          ),
        );
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string") {
            resume(
              Effect.fail(
                new BoundaryError({
                  boundary: "mock-hosted-service",
                  message: "server did not expose a TCP address",
                  retryable: false,
                }),
              ),
            );
            return;
          }
          resume(
            Effect.succeed({
              service: {
                baseUrl: `http://127.0.0.1:${address.port}`,
                requests,
                request: (path, init) =>
                  Effect.tryPromise({
                    try: async () => {
                      const result = await fetch(
                        `http://127.0.0.1:${address.port}${path}`,
                        init,
                      );
                      return {
                        status: result.status,
                        body: await result.text(),
                      };
                    },
                    catch: (cause) =>
                      new BoundaryError({
                        boundary: "mock-hosted-service-client",
                        message: String(cause),
                        retryable: true,
                      }),
                  }),
              },
              close: () =>
                Effect.async<void>((closeResume) => {
                  server.close(() => closeResume(Effect.void));
                }),
            }),
          );
        });
        return Effect.sync(() => server.close());
      }),
      (resource) => resource.close(),
    ).pipe(Effect.map((resource) => resource.service)),
  );
