import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { parse } from "yaml";
import { BoundaryError } from "../effect/errors.js";
import { nodeFoundationLayer } from "../effect/node-layer.js";
import { EnvironmentService, FileSystemService } from "../effect/services.js";

const expectedRuntimeDependencies = {
  "@effect/cli": "0.77.0",
  "@effect/platform": "0.97.1",
  "@effect/platform-node": "0.108.1",
  "@effect/printer": "0.51.0",
  "@effect/printer-ansi": "0.51.0",
  effect: "3.22.1",
  yaml: "2.8.3",
} as const;

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystemService;
  const environment = yield* EnvironmentService;
  const cwd = yield* environment.cwd;
  const packageDocument = JSON.parse(
    yield* fileSystem.readText(`${cwd}/package.json`),
  ) as { dependencies?: Record<string, string> };
  const actual = packageDocument.dependencies ?? {};
  if (JSON.stringify(actual) !== JSON.stringify(expectedRuntimeDependencies)) {
    return yield* Effect.fail(
      new BoundaryError({
        boundary: "runtime-dependencies",
        message:
          "runtime dependencies differ from the exact pure-JavaScript allowlist",
        retryable: false,
      }),
    );
  }

  const lockText = yield* fileSystem.readText(`${cwd}/../../pnpm-lock.yaml`);
  const lockDocument = parse(lockText) as {
    importers?: Readonly<
      Record<
        string,
        {
          dependencies?: Readonly<Record<string, { readonly version: string }>>;
        }
      >
    >;
    packages?: Readonly<Record<string, unknown>>;
    snapshots?: Readonly<
      Record<
        string,
        {
          dependencies?: Readonly<Record<string, string>>;
          optionalDependencies?: Readonly<Record<string, string>>;
        }
      >
    >;
  };
  if (
    Object.keys(lockDocument.packages ?? {}).some((name) =>
      name.startsWith("msgpackr-extract@"),
    )
  ) {
    return yield* Effect.fail(
      new BoundaryError({
        boundary: "runtime-dependencies",
        message: "optional native msgpackr-extract is present in the lockfile",
        retryable: false,
      }),
    );
  }

  const importer = lockDocument.importers?.["packages/turbo-ts"];
  const snapshots = lockDocument.snapshots ?? {};
  const pending = Object.entries(importer?.dependencies ?? {}).map(
    ([name, dependency]) => `${name}@${dependency.version}`,
  );
  const productionClosure = new Set<string>();
  while (pending.length > 0) {
    const key = pending.pop()!;
    if (productionClosure.has(key)) {
      continue;
    }
    productionClosure.add(key);
    const snapshot = snapshots[key];
    if (snapshot === undefined) {
      return yield* Effect.fail(
        new BoundaryError({
          boundary: "runtime-dependencies",
          message: `production dependency has no lockfile snapshot: ${key}`,
          retryable: false,
        }),
      );
    }
    for (const [name, version] of Object.entries({
      ...snapshot.dependencies,
      ...snapshot.optionalDependencies,
    })) {
      pending.push(`${name}@${version}`);
    }
  }

  const forbidden = [...productionClosure].filter((key) =>
    /(?:^|\/)(?:[^@/]+-)?(?:binding|wasm|native)(?:-|@)|msgpackr-extract|node-gyp|node-addon-api/i.test(
      key,
    ),
  );
  if (forbidden.length > 0) {
    return yield* Effect.fail(
      new BoundaryError({
        boundary: "runtime-dependencies",
        message: `native or WASM production dependency detected: ${forbidden.join(", ")}`,
        retryable: false,
      }),
    );
  }
});

program.pipe(Effect.provide(nodeFoundationLayer), NodeRuntime.runMain);
