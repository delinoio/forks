export const normalizerIds = [
  "branding",
  "version",
  "executable-path",
  "temporary-path",
  "path-separator",
  "pid",
  "port",
  "request-id",
  "session-id",
  "timestamp",
  "duration",
  "runtime-profile",
  "hosted-identity",
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
  if (selected.has("pid")) {
    output = output.replace(/\bpid[=: ]+\d+\b/gi, "pid=<PID>");
  }
  if (selected.has("port")) {
    output = output.replace(
      /\b(?:port[=: ]+|localhost:|127\.0\.0\.1:)\d+\b/gi,
      (match) => match.replace(/\d+$/, "<PORT>"),
    );
  }
  if (selected.has("request-id")) {
    output = output.replace(
      /\brequest[_-]?id[=: ]+[a-z0-9-]+\b/gi,
      "request-id=<REQUEST_ID>",
    );
  }
  if (selected.has("session-id")) {
    output = output.replace(
      /\bsession[_-]?id[=: ]+[a-z0-9-]+\b/gi,
      "session-id=<SESSION_ID>",
    );
  }
  if (selected.has("timestamp")) {
    output = output.replace(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g,
      "<TIMESTAMP>",
    );
  }
  if (selected.has("duration")) {
    output = output.replace(
      /\b\d+(?:\.\d+)?(?:ms|s|seconds?)\b/g,
      "<DURATION>",
    );
  }
  return output;
};
