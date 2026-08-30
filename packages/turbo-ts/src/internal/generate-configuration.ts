import { NodeRuntime } from "@effect/platform-node";
import { Effect, JSONSchema } from "effect";
import { distributedSchemaBase64 } from "../config/distributed-schema.js";
import { generatedConfigurationTypes } from "../config/generation.js";
import { TurboConfigurationSchema } from "../config/schema.js";
import { haveEquivalentConfigurationSchemas } from "../config/schema-compatibility.js";
import { GeneratedFileError } from "../effect/errors.js";
import { nodeFoundationLayer } from "../effect/node-layer.js";
import { EnvironmentService, FileSystemService } from "../effect/services.js";

const expectedSchemaHash =
  "a1f4c1c64530290c12ad440966b2ead3150bd8758678d81afa2cb70666519c53";

const schemaContents = Buffer.from(distributedSchemaBase64, "base64").toString(
  "utf8",
);

const hashText = async (contents: string): Promise<string> => {
  const bytes = new TextEncoder().encode(contents);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystemService;
  const environment = yield* EnvironmentService;
  const argv = yield* environment.argv;
  const cwd = yield* environment.cwd;
  const mode = argv.at(-1);
  const outputs = [
    { path: `${cwd}/schema.json`, contents: schemaContents },
    {
      path: `${cwd}/src/generated/configuration.ts`,
      contents: generatedConfigurationTypes,
    },
  ] as const;

  const hash = yield* Effect.promise(() => hashText(schemaContents));
  if (hash !== expectedSchemaHash) {
    return yield* Effect.fail(
      new GeneratedFileError({
        path: "schema.json",
        message: `schema hash ${hash} does not match ${expectedSchemaHash}`,
      }),
    );
  }

  const schemasMatch = yield* Effect.try({
    try: () =>
      haveEquivalentConfigurationSchemas(
        JSONSchema.make(TurboConfigurationSchema),
        JSON.parse(schemaContents) as unknown,
      ),
    catch: (cause) =>
      new GeneratedFileError({
        path: "src/config/schema.ts",
        message: `unable to compare Effect and distributed schemas: ${String(cause)}`,
      }),
  });
  if (!schemasMatch) {
    return yield* Effect.fail(
      new GeneratedFileError({
        path: "src/config/schema.ts",
        message:
          "Effect Schema validation shape differs from the distributed schema",
      }),
    );
  }

  // The distributed artifact contains duplicate metadata keys, which a JSON
  // object cannot retain. Preserve its exact byte layout as the output template
  // after proving that its validation shape equals the Effect Schema output.

  if (mode === "--write") {
    yield* Effect.forEach(outputs, (output) =>
      fileSystem.writeText(output.path, output.contents),
    );
    return;
  }
  if (mode !== "--check") {
    return yield* Effect.fail(
      new GeneratedFileError({
        path: "arguments",
        message: "expected --write or --check",
      }),
    );
  }
  yield* Effect.forEach(outputs, (output) =>
    fileSystem.readText(output.path).pipe(
      Effect.flatMap((actual) =>
        actual === output.contents
          ? Effect.void
          : Effect.fail(
              new GeneratedFileError({
                path: output.path,
                message: "generated file is stale",
              }),
            ),
      ),
    ),
  );
});

program.pipe(Effect.provide(nodeFoundationLayer), NodeRuntime.runMain);
