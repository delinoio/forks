import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { Schema } from "effect";
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

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

describe("configuration generation and compatibility ledger", () => {
  it("matches the distributed Turbo 2.10.12 schema", async () => {
    const contents = await readFile(`${packageRoot}/schema.json`, "utf8");
    expect(createHash("sha256").update(contents).digest("hex")).toBe(
      "a1f4c1c64530290c12ad440966b2ead3150bd8758678d81afa2cb70666519c53",
    );
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
