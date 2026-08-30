import { describe, expect, it } from "@rstest/core";
import { Effect, Schedule, Schema } from "effect";
import { BoundaryError } from "../src/effect/errors.js";
import { nodeFoundationLayer } from "../src/effect/node-layer.js";
import { RandomnessService } from "../src/effect/services.js";

describe("Effect foundation", () => {
  it("schema-validates tagged boundary errors", () => {
    const error = Schema.decodeUnknownSync(BoundaryError)({
      _tag: "BoundaryError",
      boundary: "http",
      message: "offline",
      retryable: true,
    });
    expect(error.boundary).toBe("http");
  });

  it("finalizes scoped fibers when their parent scope closes", async () => {
    let finalized = false;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const resource = Effect.acquireRelease(Effect.void, () =>
            Effect.sync(() => {
              finalized = true;
            }),
          ).pipe(Effect.zipRight(Effect.never));
          yield* Effect.forkScoped(resource);
          yield* Effect.yieldNow();
        }),
      ),
    );
    expect(finalized).toBe(true);
  });

  it("uses a bounded retry schedule for transient failures", async () => {
    let attempts = 0;
    const result = await Effect.runPromise(
      Effect.suspend(() => {
        attempts += 1;
        return attempts < 3 ? Effect.fail("transient") : Effect.succeed("ok");
      }).pipe(Effect.retry(Schedule.recurs(2))),
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("generates canonical lowercase UUID v7 identifiers", async () => {
    const identifier = await Effect.runPromise(
      RandomnessService.pipe(Effect.flatMap((service) => service.uuidV7)).pipe(
        Effect.provide(nodeFoundationLayer),
      ),
    );
    expect(identifier).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
