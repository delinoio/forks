import {
  compatibilityVersion,
  packageVersion,
  versionOutput,
} from "../version.js";

export const normalizerIds = ["branding", "version"] as const;

export type NormalizerId = (typeof normalizerIds)[number];

const mapOutputLines = (
  input: string,
  transform: (contents: string) => string,
): string =>
  input
    .split("\n")
    .map((line) => {
      const carriageReturn = line.endsWith("\r") ? "\r" : "";
      const contents = carriageReturn === "" ? line : line.slice(0, -1);
      return `${transform(contents)}${carriageReturn}`;
    })
    .join("\n");

export const normalizeOutput = (
  input: string,
  enabled: ReadonlyArray<NormalizerId>,
): string => {
  const selected = new Set(enabled);
  let output = input;
  if (selected.has("branding")) {
    output = mapOutputLines(output, (contents) =>
      contents === versionOutput
        ? packageVersion
        : contents === `• ${versionOutput}`
          ? `• turbo ${compatibilityVersion}`
          : contents,
    );
  }
  if (selected.has("version")) {
    output = mapOutputLines(output, (contents) => {
      if (contents === packageVersion || contents === compatibilityVersion) {
        return "<VERSION>";
      }
      return contents === versionOutput
        ? "turbo-ts <VERSION> (compatible with turbo <VERSION>)"
        : contents === `• ${versionOutput}`
          ? "• turbo-ts <VERSION> (compatible with turbo <VERSION>)"
          : contents;
    });
  }
  return output;
};
