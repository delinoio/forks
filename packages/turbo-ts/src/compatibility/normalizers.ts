export const normalizerIds = [
  "branding",
  "version",
  "executable-path",
  "temporary-path",
  "path-separator",
] as const;

export type NormalizerId = (typeof normalizerIds)[number];

export interface NormalizationContext {
  readonly executablePaths?: ReadonlyArray<string>;
  readonly temporaryPaths?: ReadonlyArray<string>;
}

const escapeRegularExpression = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const replaceKnownValues = (
  input: string,
  values: ReadonlyArray<string> | undefined,
  replacement: string,
): string =>
  [...(values ?? [])]
    .sort((left, right) => right.length - left.length)
    .reduce(
      (output, value) =>
        output.replace(
          new RegExp(escapeRegularExpression(value), "g"),
          replacement,
        ),
      input,
    );

export const normalizeOutput = (
  input: string,
  enabled: ReadonlyArray<NormalizerId>,
  context: NormalizationContext = {},
): string => {
  const selected = new Set(enabled);
  let output = input;
  if (selected.has("branding")) {
    output = output
      .replaceAll("turbo-ts", "<PRODUCT>")
      .replaceAll("turbo", "<PRODUCT>");
  }
  if (selected.has("version")) {
    output = output
      .replaceAll("0.1.0", "<VERSION>")
      .replaceAll("2.10.12", "<VERSION>");
  }
  if (selected.has("executable-path")) {
    output = replaceKnownValues(
      output,
      context.executablePaths,
      "<EXECUTABLE>",
    );
  }
  if (selected.has("temporary-path")) {
    output = replaceKnownValues(output, context.temporaryPaths, "<TEMP>");
  }
  if (selected.has("path-separator")) {
    output = output.replaceAll("\\", "/");
  }
  return output;
};
