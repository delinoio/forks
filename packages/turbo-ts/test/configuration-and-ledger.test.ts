import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { JSONSchema, Schema } from "effect";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  evidenceId,
  evidenceRegistry,
  expandLedgerRowIds,
  parseCompatibilityLedger,
} from "../src/compatibility/ledger.js";
import { normalizerIds } from "../src/compatibility/normalizers.js";
import {
  ledgerCategories,
  requiredLedgerVariants,
} from "../src/compatibility/required-variants.js";
import {
  RootSchemaSchema,
  TurboConfigurationSchema,
  WorkspaceSchemaSchema,
} from "../src/config/schema.js";
import { haveEquivalentConfigurationSchemas } from "../src/config/schema-compatibility.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

interface JsonSchemaNode {
  readonly $ref?: string;
  readonly additionalProperties?: boolean | JsonSchemaNode;
  readonly allOf?: ReadonlyArray<JsonSchemaNode>;
  readonly anyOf?: ReadonlyArray<JsonSchemaNode>;
  readonly items?: JsonSchemaNode | ReadonlyArray<JsonSchemaNode>;
  readonly oneOf?: ReadonlyArray<JsonSchemaNode>;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
}

interface DistributedJsonSchema extends JsonSchemaNode {
  readonly definitions: Readonly<Record<string, JsonSchemaNode>>;
}

const definitionReferencePrefix = "#/definitions/";

const decodeJsonPointerSegment = (value: string): string =>
  value.replaceAll("~1", "/").replaceAll("~0", "~");

const collectConfigurationPropertyPaths = (
  document: DistributedJsonSchema,
): ReadonlyArray<string> => {
  const paths = new Set<string>();

  const visit = (
    schema: JsonSchemaNode,
    prefix: string,
    activeReferences: ReadonlySet<string>,
  ): void => {
    if (schema.$ref !== undefined && !activeReferences.has(schema.$ref)) {
      if (!schema.$ref.startsWith(definitionReferencePrefix)) {
        throw new Error(`unsupported schema reference: ${schema.$ref}`);
      }
      const definitionName = decodeJsonPointerSegment(
        schema.$ref.slice(definitionReferencePrefix.length),
      );
      const definition = document.definitions[definitionName];
      if (definition === undefined) {
        throw new Error(`missing schema definition: ${definitionName}`);
      }
      visit(definition, prefix, new Set([...activeReferences, schema.$ref]));
    }

    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      for (const branch of schema[keyword] ?? []) {
        visit(branch, prefix, activeReferences);
      }
    }

    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      const propertyPath = prefix === "" ? name : `${prefix}.${name}`;
      paths.add(propertyPath);
      visit(property, propertyPath, activeReferences);
    }

    const wildcardPath = prefix === "" ? "*" : `${prefix}.*`;
    if (
      typeof schema.additionalProperties === "object" &&
      schema.additionalProperties !== null
    ) {
      visit(schema.additionalProperties, wildcardPath, activeReferences);
    }
    const items = Array.isArray(schema.items)
      ? schema.items
      : schema.items === undefined
        ? []
        : [schema.items];
    for (const item of items) {
      visit(item, wildcardPath, activeReferences);
    }
  };

  visit(document, "", new Set());
  return [...paths].sort();
};

const listFixtureFiles = async (
  root: string,
  relativeDirectory = "",
): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(join(root, relativeDirectory), {
    withFileTypes: true,
  });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const relativePath =
        relativeDirectory === ""
          ? entry.name
          : `${relativeDirectory}/${entry.name}`;
      return entry.isDirectory()
        ? listFixtureFiles(root, relativePath)
        : [relativePath];
    }),
  );
  return paths.flat().sort();
};

describe("configuration generation and compatibility ledger", () => {
  it("matches the distributed Turbo 2.10.12 schema", async () => {
    const contents = await readFile(`${packageRoot}/schema.json`, "utf8");
    expect(createHash("sha256").update(contents).digest("hex")).toBe(
      "a1f4c1c64530290c12ad440966b2ead3150bd8758678d81afa2cb70666519c53",
    );
  });

  it("detects drift between runtime definitions and the distributed schema", async () => {
    const distributedDocument = JSON.parse(
      await readFile(`${packageRoot}/schema.json`, "utf8"),
    ) as unknown;
    const runtimeDocument = JSONSchema.make(TurboConfigurationSchema);
    expect(
      haveEquivalentConfigurationSchemas(runtimeDocument, distributedDocument),
    ).toBe(true);

    const missingField = structuredClone(runtimeDocument) as unknown as Record<
      string,
      unknown
    >;
    const missingFieldProperties = missingField.properties as Record<
      string,
      unknown
    >;
    delete missingFieldProperties.ui;
    expect(
      haveEquivalentConfigurationSchemas(missingField, distributedDocument),
    ).toBe(false);

    const incorrectNullability = structuredClone(
      runtimeDocument,
    ) as unknown as Record<string, unknown>;
    const nullabilityProperties = incorrectNullability.properties as Record<
      string,
      Record<string, unknown>
    >;
    nullabilityProperties.ui!.anyOf = (
      nullabilityProperties.ui!.anyOf as ReadonlyArray<Record<string, unknown>>
    ).filter((member) => member.type !== "null");
    expect(
      haveEquivalentConfigurationSchemas(
        incorrectNullability,
        distributedDocument,
      ),
    ).toBe(false);

    const narrowedEnum = structuredClone(runtimeDocument) as unknown as Record<
      string,
      unknown
    >;
    const definitions = narrowedEnum.$defs as Record<
      string,
      Record<string, unknown>
    >;
    definitions.OutputLogs!.enum = ["full"];
    expect(
      haveEquivalentConfigurationSchemas(narrowedEnum, distributedDocument),
    ).toBe(false);
  });

  it("uses Effect Schema to accept valid configuration and reject invalid types", async () => {
    const valid = JSON.parse(
      await readFile(
        `${packageRoot}/test/fixtures/configuration/valid-root.json`,
        "utf8",
      ),
    );
    const invalid = JSON.parse(
      await readFile(
        `${packageRoot}/test/fixtures/configuration/invalid-root.json`,
        "utf8",
      ),
    );
    expect(Schema.decodeUnknownSync(TurboConfigurationSchema)(valid)).toEqual(
      valid,
    );
    expect(() =>
      Schema.decodeUnknownSync(TurboConfigurationSchema)(invalid),
    ).toThrow();
  });

  it("accepts omitted and null tasks in root and workspace schemas", () => {
    expect(Schema.decodeUnknownSync(TurboConfigurationSchema)({})).toEqual({});
    expect(Schema.decodeUnknownSync(RootSchemaSchema)({ tasks: null })).toEqual(
      {
        tasks: null,
      },
    );
    expect(
      Schema.decodeUnknownSync(WorkspaceSchemaSchema)({ extends: ["//"] }),
    ).toEqual({ extends: ["//"] });
    expect(
      Schema.decodeUnknownSync(WorkspaceSchemaSchema)({
        extends: ["//"],
        tasks: null,
      }),
    ).toEqual({ extends: ["//"], tasks: null });
    expect(
      Schema.decodeUnknownSync(WorkspaceSchemaSchema)({
        extends: ["//"],
        tasks: { lint: { extends: false } },
      }),
    ).toEqual({
      extends: ["//"],
      tasks: { lint: { extends: false } },
    });
    expect(
      Schema.decodeUnknownSync(TurboConfigurationSchema)({
        extends: ["//"],
        tags: ["app"],
      }),
    ).toEqual({ extends: ["//"], tags: ["app"] });
    expect(
      Schema.decodeUnknownSync(TurboConfigurationSchema)({
        extends: null,
        tags: null,
        boundaries: null,
      }),
    ).toEqual({ extends: null, tags: null, boundaries: null });
  });

  it("preserves every declared field in the nondiscriminated configuration shape", () => {
    const mixedConfiguration = {
      extends: ["//"],
      globalDependencies: ["package.json"],
    };
    expect(
      Schema.decodeUnknownSync(TurboConfigurationSchema)(mixedConfiguration),
    ).toEqual(mixedConfiguration);
    expect(
      Schema.decodeUnknownSync(TurboConfigurationSchema)({ tags: ["app"] }),
    ).toEqual({ tags: ["app"] });
  });

  it("inventories every recursive distributed configuration field", async () => {
    const distributedSchema = JSON.parse(
      await readFile(`${packageRoot}/schema.json`, "utf8"),
    ) as DistributedJsonSchema;
    const expected = collectConfigurationPropertyPaths(distributedSchema);
    const ledgerDocument = parseYaml(
      await readFile(`${packageRoot}/compatibility/ledger.yaml`, "utf8"),
    ) as {
      rows: Array<{ id: string; variants?: Array<string> }>;
    };
    const actual = [
      ...(ledgerDocument.rows.find(
        (row) => row.id === "configuration.distributed",
      )?.variants ?? []),
    ].sort();

    expect(expected).toEqual(
      expect.arrayContaining([
        "boundaries.dependencies.allow",
        "boundaries.tags.*.dependents.deny",
        "global.remoteCache.uploadTimeout",
        "tasks.*.inputs.*.mode",
      ]),
    );
    expect(actual).toEqual(expected);
  });

  it("rejects fractional remote-cache timeouts", () => {
    for (const field of ["timeout", "uploadTimeout"] as const) {
      expect(
        Schema.decodeUnknownSync(TurboConfigurationSchema)({
          remoteCache: { [field]: 1 },
        }),
      ).toEqual({ remoteCache: { [field]: 1 } });
      expect(() =>
        Schema.decodeUnknownSync(TurboConfigurationSchema)({
          remoteCache: { [field]: 0.5 },
        }),
      ).toThrow();
    }
  });

  it("records configuration fixture provenance", async () => {
    const provenance = parseYaml(
      await readFile(
        `${packageRoot}/test/fixtures/configuration/fixture.yaml`,
        "utf8",
      ),
    ) as { files: Array<string>; provenance: string };
    expect(provenance.provenance).toBe("independently-authored");
    expect(provenance.files).toEqual(["invalid-root.json", "valid-root.json"]);
  });

  it(evidenceId.fixturesSynthetic, async () => {
    const fixtureRoot = `${packageRoot}/test/fixtures/basic-workspace`;
    const metadata = parseYaml(
      await readFile(`${fixtureRoot}/fixture.yaml`, "utf8"),
    ) as {
      files: Array<string>;
      provenance: string;
      purpose: string;
    };
    const actualPayloadFiles = (await listFixtureFiles(fixtureRoot)).filter(
      (path) => path !== "fixture.yaml",
    );
    expect(metadata.provenance).toBe("independently-authored");
    expect(metadata.purpose).toBe(
      "package discovery, dependency graph, and deterministic task output",
    );
    expect([...metadata.files].sort()).toEqual(actualPayloadFiles);

    const readJson = async (path: string): Promise<unknown> =>
      JSON.parse(await readFile(`${fixtureRoot}/${path}`, "utf8")) as unknown;
    const rootConfiguration = await readJson("turbo.json");
    const workspaceConfiguration = await readJson("packages/app/turbo.json");
    expect(
      Schema.decodeUnknownSync(RootSchemaSchema)(rootConfiguration),
    ).toEqual(rootConfiguration);
    expect(
      Schema.decodeUnknownSync(WorkspaceSchemaSchema)(workspaceConfiguration),
    ).toEqual(workspaceConfiguration);

    const workspace = parseYaml(
      await readFile(`${fixtureRoot}/pnpm-workspace.yaml`, "utf8"),
    ) as { packages: Array<string> };
    expect(workspace.packages).toEqual(["packages/*"]);
    expect(
      (await readdir(`${fixtureRoot}/packages`, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(["app", "library"]);

    interface FixtureManifest {
      readonly dependencies?: Readonly<Record<string, string>>;
      readonly name: string;
      readonly packageManager?: string;
      readonly private: boolean;
      readonly scripts: Readonly<Record<string, string>>;
    }
    const rootManifest = (await readJson("package.json")) as FixtureManifest;
    const appManifest = (await readJson(
      "packages/app/package.json",
    )) as FixtureManifest;
    const libraryManifest = (await readJson(
      "packages/library/package.json",
    )) as FixtureManifest;
    expect(rootManifest.packageManager).toBe("pnpm@10.34.5");
    expect([rootManifest.name, appManifest.name, libraryManifest.name]).toEqual(
      ["synthetic-basic-workspace", "synthetic-app", "synthetic-library"],
    );
    expect(appManifest.dependencies?.[libraryManifest.name]).toBe(
      "workspace:*",
    );
    expect([
      rootManifest.scripts.build,
      appManifest.scripts.build,
      libraryManifest.scripts.build,
    ]).toEqual([
      "node -e \"console.log('root build')\"",
      "node -e \"console.log('app build')\"",
      "node -e \"console.log('library build')\"",
    ]);
    expect(appManifest.scripts.fail).toBe('node -e "process.exitCode = 7"');
  });

  it("matches distributed nullable fields and structured task inputs", () => {
    const configuration = {
      $schema: null,
      globalDependencies: null,
      globalEnv: null,
      globalPassThroughEnv: null,
      remoteCache: {
        signature: null,
        enabled: null,
        preflight: null,
        apiUrl: null,
        loginUrl: null,
        timeout: null,
        uploadTimeout: null,
        teamId: null,
        teamSlug: null,
      },
      ui: null,
      concurrency: null,
      dangerouslyDisablePackageManagerCheck: null,
      cacheDir: null,
      cacheMaxAge: null,
      cacheMaxSize: null,
      daemon: null,
      envMode: null,
      boundaries: {
        implicitDependencies: null,
        dependencies: { allow: null, deny: null },
        dependents: null,
        tags: {
          app: {
            dependencies: null,
            dependents: { allow: null, deny: null },
          },
        },
      },
      noUpdateNotifier: null,
      global: {
        inputs: null,
        env: null,
        passThroughEnv: null,
        remoteCache: null,
        ui: null,
        concurrency: null,
        dangerouslyDisablePackageManagerCheck: null,
        cacheDir: null,
        cacheMaxAge: null,
        cacheMaxSize: null,
        daemon: null,
        envMode: null,
        noUpdateNotifier: null,
      },
      futureFlags: null,
      tasks: {
        build: {
          description: null,
          dependsOn: null,
          env: null,
          passThroughEnv: null,
          outputs: null,
          cache: null,
          inputs: [
            {},
            {
              from: null,
              globs: null,
              mode: null,
              withDefaults: null,
            },
            { mode: "future-mode" },
          ],
          outputLogs: null,
          persistent: null,
          interactive: null,
          interruptible: null,
          with: null,
        },
      },
    };
    expect(
      Schema.decodeUnknownSync(TurboConfigurationSchema)(configuration),
    ).toEqual(configuration);
    expect(
      Schema.decodeUnknownSync(RootSchemaSchema)({
        boundaries: null,
        remoteCache: null,
        global: null,
        futureFlags: null,
      }),
    ).toEqual({
      boundaries: null,
      remoteCache: null,
      global: null,
      futureFlags: null,
    });
  });

  it("validates and expands the exhaustive compatibility ledger", async () => {
    const ledgerSource = await readFile(
      `${packageRoot}/compatibility/ledger.yaml`,
      "utf8",
    );
    const ledger = parseCompatibilityLedger(ledgerSource);
    const expanded = expandLedgerRowIds(ledger);
    expect(expanded.length).toBeGreaterThan(200);
    expect(new Set(expanded).size).toBe(expanded.length);
    expect(
      ledger.rows.find((row) => row.id === "normalization.approved")?.variants,
    ).toEqual(normalizerIds);
    expect(
      ledger.rows.find((row) => row.id === "success.lockfile-pruning"),
    ).toMatchObject({
      status: "passing",
      variants: ["lockfile-parse-and-prune"],
    });
    expect(
      ledger.rows
        .filter((row) => row.status === "passing")
        .flatMap((row) => row.variants ?? []),
    ).toContain("lockfile-parse-and-prune");
    expect(() =>
      parseCompatibilityLedger(
        ledgerSource.replace(
          "tests: [cli.version]",
          "tests: [unknown.evidence]",
        ),
      ),
    ).toThrow();

    const ledgerDocument = parseYaml(ledgerSource) as {
      rows: Array<{
        category: string;
        variants?: Array<string>;
      }>;
    };
    for (const category of ledgerCategories) {
      const variant = requiredLedgerVariants[category][0];
      const missingVariant = structuredClone(ledgerDocument);
      const row = missingVariant.rows.find(
        (candidate) =>
          candidate.category === category &&
          candidate.variants?.includes(variant) === true,
      );
      if (row?.variants === undefined) {
        throw new Error(`test setup cannot find ${category}:${variant}`);
      }
      row.variants = row.variants.filter((candidate) => candidate !== variant);
      expect(() =>
        parseCompatibilityLedger(stringifyYaml(missingVariant)),
      ).toThrow(`missing ledger variant: ${category}:${variant}`);
    }

    const unexpectedVariant = structuredClone(ledgerDocument);
    unexpectedVariant.rows[0]?.variants?.push("unexpected-surface");
    expect(() =>
      parseCompatibilityLedger(stringifyYaml(unexpectedVariant)),
    ).toThrow("unexpected ledger variant: command:unexpected-surface");
  });

  it("wires ledger evidence to executed tests and package checks", async () => {
    const packageManifest = JSON.parse(
      await readFile(`${packageRoot}/package.json`, "utf8"),
    ) as { scripts: Record<string, string> };
    for (const registration of Object.values(evidenceRegistry)) {
      if (registration.kind === "package-script") {
        expect(packageManifest.scripts.check).toContain(
          `pnpm ${registration.script}`,
        );
      } else {
        const testSource = await readFile(
          `${packageRoot}/${registration.file}`,
          "utf8",
        );
        expect(testSource).toContain(`it(evidenceId.${registration.binding},`);
      }
    }
  });

  it(evidenceId.nondeterminismEvidence, async () => {
    const evidence = parseYaml(
      await readFile(
        `${packageRoot}/compatibility/nondeterminism.yaml`,
        "utf8",
      ),
    ) as {
      runs: Array<{
        repetitions: number;
        rawSha256: Array<string>;
        varyingFields: Array<string>;
      }>;
    };
    expect(evidence.runs[0]?.repetitions).toBe(10);
    expect(evidence.runs[0]?.rawSha256).toHaveLength(10);
    expect(new Set(evidence.runs[0]?.rawSha256).size).toBe(1);
    expect(evidence.runs[0]?.varyingFields).toEqual([]);
  });
});
