import type { UnsupportedCompatibilityError } from "../effect/errors.js";

export interface CompatibilityDiagnostic {
  readonly kind: "error" | "help" | "completion";
  readonly message: string;
}

const ansiRed = "\u001B[31m";
const ansiReset = "\u001B[0m";

export const renderCompatibilityDiagnostic = (
  diagnostic: CompatibilityDiagnostic,
  colorEnabled: boolean,
): string => {
  const message = `turbo-ts: ${diagnostic.message}`;
  return diagnostic.kind === "error" && colorEnabled
    ? `${ansiRed}${message}${ansiReset}\n`
    : `${message}\n`;
};

export const renderUnsupportedCompatibilityError = (
  error: UnsupportedCompatibilityError,
  colorEnabled: boolean,
): string =>
  renderCompatibilityDiagnostic(
    {
      kind: "error",
      message: `${error.surface} is not implemented in compatibility gate ${error.targetGate}`,
    },
    colorEnabled,
  );

export const renderCompletion = (candidates: ReadonlyArray<string>): string =>
  `${[...candidates].sort().join("\n")}\n`;
