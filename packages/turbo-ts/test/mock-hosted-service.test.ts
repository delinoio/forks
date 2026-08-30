import { describe, expect, it } from "@rstest/core";
import { Effect } from "effect";
import { evidenceId } from "../src/compatibility/ledger.js";
import {
  MockHostedService,
  makeMockHostedLayer,
} from "./support/mock-hosted-service.js";

describe("mock hosted services", () => {
  it(evidenceId.mockHostedScoped, async () => {
    let baseUrl = "";
    const recorded = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const mock = yield* MockHostedService;
          baseUrl = mock.baseUrl;
          const response = yield* mock.request("/v8/artifacts/example", {
            method: "PUT",
            headers: {
              authorization: "Bearer secret-token",
              "content-type": "application/json",
            },
            body: "synthetic payload",
          });
          expect(response).toEqual({ status: 201, body: "stored" });
          return [...mock.requests];
        }).pipe(
          Effect.provide(
            makeMockHostedLayer([{ status: 201, body: "stored" }]),
          ),
        ),
      ),
    );
    expect(recorded[0]?.headers.authorization).toBe("[REDACTED]");
    await expect(fetch(baseUrl)).rejects.toThrow();
  });
});
