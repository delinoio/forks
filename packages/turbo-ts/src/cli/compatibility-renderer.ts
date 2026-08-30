import type { UnsupportedCompatibilityError } from "../effect/errors.js";

export interface CompatibilityDiagnostic {
  readonly kind: "error" | "help" | "completion";
  readonly message: string;
}

export const renderCompatibilityDiagnostic = (
  diagnostic: CompatibilityDiagnostic,
): string => `turbo-ts: ${diagnostic.message}\n`;

export const renderUnsupportedCompatibilityError = (
  error: UnsupportedCompatibilityError,
): string =>
  renderCompatibilityDiagnostic({
    kind: "error",
    message: `${error.surface} is not implemented in compatibility gate ${error.targetGate}`,
  });

export const renderCompletion = (candidates: ReadonlyArray<string>): string =>
  `${[...candidates].sort().join("\n")}\n`;
