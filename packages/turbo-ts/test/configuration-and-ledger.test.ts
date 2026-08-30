import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { Schema } from "effect";
import { parse as parseYaml } from "yaml";
import {
  expandLedgerRowIds,
  parseCompatibilityLedger,
} from "../src/compatibility/ledger.js";
import { TurboConfigurationSchema } from "../src/config/schema.js";

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

  it("validates and expands the exhaustive compatibility ledger", async () => {
    const ledger = parseCompatibilityLedger(
      await readFile(`${packageRoot}/compatibility/ledger.yaml`, "utf8"),
    );
    const expanded = expandLedgerRowIds(ledger);
    expect(expanded.length).toBeGreaterThan(200);
    expect(new Set(expanded).size).toBe(expanded.length);
  });

  it("records ten stable reference executions before approving normalizers", async () => {
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
