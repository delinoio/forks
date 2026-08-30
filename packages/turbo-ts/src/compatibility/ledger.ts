import { Schema } from "effect";
import { parse } from "yaml";
import { LedgerError } from "../effect/errors.js";

export const LedgerCategorySchema = Schema.Literal(
  "command",
  "option",
  "environment",
  "configuration",
  "protocol",
  "package-manager",
  "success",
  "failure",
  "security",
  "normalization",
  "explicit-difference",
);

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
  tests: Schema.optional(Schema.Array(Schema.String)),
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

const requiredCommands = [
  "bin",
  "get-mfe-port",
  "boundaries",
  "completion",
  "daemon",
  "devtools",
  "docs",
  "generate",
  "telemetry",
  "scan",
  "config",
  "ls",
  "link",
  "login",
  "logout",
  "info",
  "prune",
  "run",
  "implicit-task",
  "query",
  "query affected",
  "query ls",
  "watch",
  "unlink",
] as const;

const requiredCategories = [
  "command",
  "option",
  "environment",
  "configuration",
  "protocol",
  "package-manager",
  "success",
  "failure",
  "security",
  "normalization",
  "explicit-difference",
] as const;

const requiredPackageManagers = [
  "npm@8.0.0",
  "npm@8.19.4",
  "npm@9.9.4",
  "npm@10.9.9",
  "npm@11.19.1",
  "npm@12.0.2",
  "pnpm@8.0.0",
  "pnpm@8.15.9",
  "pnpm@9.15.9",
  "pnpm@10.34.5",
  "pnpm@11.25.0",
  "pnpm@12.1.0",
  "yarn@1.0.0",
  "yarn@1.22.22",
  "yarn@2.4.2",
  "yarn@3.8.7",
  "yarn@4.18.0",
  "bun@1.2.0",
  "bun@1.4.0",
  "cargo@1.97.1",
  "rustc@1.97.1",
  "uv@0.12.7",
] as const;

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

  for (const category of requiredCategories) {
    if (!decoded.rows.some((row) => row.category === category)) {
      throw new LedgerError({
        message: `missing ledger category: ${category}`,
      });
    }
  }

  const commandVariants = new Set(
    decoded.rows
      .filter((row) => row.category === "command")
      .flatMap((row) => row.variants ?? []),
  );
  for (const command of requiredCommands) {
    if (!commandVariants.has(command)) {
      throw new LedgerError({ message: `missing command: ${command}` });
    }
  }

  const packageManagerVariants = new Set(
    decoded.rows
      .filter((row) => row.category === "package-manager")
      .flatMap((row) => row.variants ?? []),
  );
  for (const packageManager of requiredPackageManagers) {
    if (!packageManagerVariants.has(packageManager)) {
      throw new LedgerError({
        message: `missing package manager: ${packageManager}`,
      });
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
