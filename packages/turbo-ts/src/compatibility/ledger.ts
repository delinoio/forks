import { Schema } from "effect";
import { parse } from "yaml";
import { LedgerError } from "../effect/errors.js";
import {
  ledgerCategories,
  requiredLedgerVariants,
} from "./required-variants.js";

export const evidenceId = {
  cliVersion: "cli.version",
  configurationGenerated: "configuration.generated",
  dependenciesRuntime: "dependencies.runtime",
  effectsScoped: "effects.scoped",
  mockHostedScoped: "mock-hosted.scoped",
  nondeterminismEvidence: "nondeterminism.evidence",
  normalizersAllowlist: "normalizers.allowlist",
  normalizersDeterministic: "normalizers.deterministic",
  oracleExternal: "oracle.external",
} as const;

export type EvidenceId = (typeof evidenceId)[keyof typeof evidenceId];

type EvidenceRegistration =
  | {
      readonly kind: "rstest";
      readonly file: string;
      readonly binding: keyof typeof evidenceId;
    }
  | {
      readonly kind: "package-script";
      readonly script: string;
    };

export const evidenceRegistry = {
  [evidenceId.cliVersion]: {
    kind: "rstest",
    file: "test/cli-and-oracle.test.ts",
    binding: "cliVersion",
  },
  [evidenceId.configurationGenerated]: {
    kind: "package-script",
    script: "check:generated",
  },
  [evidenceId.dependenciesRuntime]: {
    kind: "package-script",
    script: "check:runtime-dependencies",
  },
  [evidenceId.effectsScoped]: {
    kind: "rstest",
    file: "test/effect-foundation.test.ts",
    binding: "effectsScoped",
  },
  [evidenceId.mockHostedScoped]: {
    kind: "rstest",
    file: "test/mock-hosted-service.test.ts",
    binding: "mockHostedScoped",
  },
  [evidenceId.nondeterminismEvidence]: {
    kind: "rstest",
    file: "test/configuration-and-ledger.test.ts",
    binding: "nondeterminismEvidence",
  },
  [evidenceId.normalizersAllowlist]: {
    kind: "rstest",
    file: "test/normalizers.test.ts",
    binding: "normalizersAllowlist",
  },
  [evidenceId.normalizersDeterministic]: {
    kind: "rstest",
    file: "test/normalizers.test.ts",
    binding: "normalizersDeterministic",
  },
  [evidenceId.oracleExternal]: {
    kind: "rstest",
    file: "test/cli-and-oracle.test.ts",
    binding: "oracleExternal",
  },
} as const satisfies Record<EvidenceId, EvidenceRegistration>;

const evidenceIdValues = Object.values(evidenceId) as [
  EvidenceId,
  ...Array<EvidenceId>,
];

export const EvidenceIdSchema = Schema.Literal(...evidenceIdValues);

export const LedgerCategorySchema = Schema.Literal(...ledgerCategories);

export const LedgerStatusSchema = Schema.Literal(
  "passing",
  "planned",
  "documented-difference",
  "out-of-scope",
);

export const LedgerRowSchema = Schema.Struct({
  id: Schema.String,
  category: LedgerCategorySchema,
  subject: Schema.String,
  targetGate: Schema.Number,
  status: LedgerStatusSchema,
  variants: Schema.optional(Schema.Array(Schema.String)),
  tests: Schema.optional(Schema.Array(EvidenceIdSchema)),
  normalizers: Schema.optional(Schema.Array(Schema.String)),
  source: Schema.String,
});

export const CompatibilityLedgerSchema = Schema.Struct({
  version: Schema.Literal(1),
  baseline: Schema.Struct({
    package: Schema.Literal("turbo"),
    version: Schema.Literal("2.10.12"),
    commit: Schema.Literal("53752d452049bdda47698354b16a83d7ce92ced0"),
  }),
  rows: Schema.Array(LedgerRowSchema),
});

export type CompatibilityLedger = Schema.Schema.Type<
  typeof CompatibilityLedgerSchema
>;

export const parseCompatibilityLedger = (
  source: string,
): CompatibilityLedger => {
  const decoded = Schema.decodeUnknownSync(CompatibilityLedgerSchema)(
    parse(source),
  );
  const ids = new Set<string>();
  for (const row of decoded.rows) {
    if (ids.has(row.id)) {
      throw new LedgerError({ message: `duplicate ledger id: ${row.id}` });
    }
    ids.add(row.id);
    if (row.status === "passing" && (row.tests?.length ?? 0) === 0) {
      throw new LedgerError({ message: `passing row has no test: ${row.id}` });
    }
  }

  for (const category of ledgerCategories) {
    const actual = new Set(
      decoded.rows
        .filter((row) => row.category === category)
        .flatMap((row) => row.variants ?? []),
    );
    for (const required of requiredLedgerVariants[category]) {
      if (!actual.has(required)) {
        throw new LedgerError({
          message: `missing ledger variant: ${category}:${required}`,
        });
      }
    }
    const required = new Set<string>(requiredLedgerVariants[category]);
    for (const variant of actual) {
      if (!required.has(variant)) {
        throw new LedgerError({
          message: `unexpected ledger variant: ${category}:${variant}`,
        });
      }
    }
  }
  return decoded;
};

export const expandLedgerRowIds = (
  ledger: CompatibilityLedger,
): ReadonlyArray<string> =>
  ledger.rows.flatMap((row) =>
    row.variants === undefined || row.variants.length === 0
      ? [row.id]
      : row.variants.map((variant) => `${row.id}:${variant}`),
  );
