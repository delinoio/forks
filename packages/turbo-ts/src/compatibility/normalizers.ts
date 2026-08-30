import { packageVersion, versionOutput } from "../version.js";

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
      .split("\n")
      .map((line) => {
        const carriageReturn = line.endsWith("\r") ? "\r" : "";
        const contents = carriageReturn === "" ? line : line.slice(0, -1);
        return contents === versionOutput
          ? `${packageVersion}${carriageReturn}`
          : line;
      })
      .join("\n");
  }
  if (selected.has("version")) {
    output = output
      .replaceAll("0.1.0", "<VERSION>")
      .replaceAll("2.10.12", "<VERSION>");
  }
  return output;
};
