export const normalizerIds = ["branding", "version"] as const;

export type NormalizerId = (typeof normalizerIds)[number];

export const normalizeOutput = (
  input: string,
  enabled: ReadonlyArray<NormalizerId>,
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
  return output;
};
