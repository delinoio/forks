import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { Schema } from "effect";
import { parse as parseYaml } from "yaml";
import {
  evidenceId,
  evidenceRegistry,
  expandLedgerRowIds,
  parseCompatibilityLedger,
} from "../src/compatibility/ledger.js";
import { normalizerIds } from "../src/compatibility/normalizers.js";
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
