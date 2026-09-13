const secretName =
  /authorization|cookie|credential|password|secret|signature|token/i;
const bearerValue = /\bBearer\s+[^\s,;]+/gi;
const urlCredentials = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;
const namedSecretValue =
  /(\b(?:access[_-]?token|authorization|cookie|credential|password|secret|signature|token)=)[^\s&#;,]+/gi;

export const redactedValue = "[REDACTED]";

export const redactText = (
  value: string,
  secrets: ReadonlyArray<string> = [],
): string => {
  let redacted = value
    .replaceAll(bearerValue, `Bearer ${redactedValue}`)
    .replaceAll(urlCredentials, `$1${redactedValue}@`)
    .replaceAll(namedSecretValue, `$1${redactedValue}`);
  for (const secret of [...new Set(secrets)].sort(
    (left, right) => right.length - left.length,
  )) {
    if (secret !== "") redacted = redacted.replaceAll(secret, redactedValue);
  }
  return redacted;
};

const redactEntry = (
  entry: unknown,
  secrets: ReadonlyArray<string>,
): unknown =>
  typeof entry === "string"
    ? redactText(entry, secrets)
    : Array.isArray(entry)
      ? entry.map((item) => redactEntry(item, secrets))
      : typeof entry === "object" && entry !== null
        ? redactRecord(entry as Readonly<Record<string, unknown>>, secrets)
        : entry;

export const redactRecord = (
  value: Readonly<Record<string, unknown>>,
  secrets: ReadonlyArray<string> = [],
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(value).map(([name, entry]) => [
      name,
      secretName.test(name) ? redactedValue : redactEntry(entry, secrets),
    ]),
  );
