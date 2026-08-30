import { parse as parseYaml } from "yaml";
import { baseName } from "../core/path.js";

export interface LockfilePackage {
  readonly name: string;
  readonly version: string;
}

export interface ParsedLockfile {
  readonly format:
    | "aube"
    | "bun-binary"
    | "bun-text"
    | "cargo"
    | "npm"
    | "nub"
    | "pnpm"
    | "uv"
    | "yarn-berry"
    | "yarn-classic"
    | "yarn-pnp";
  readonly packages: ReadonlyArray<LockfilePackage>;
}

const maximumLockfileBytes = 32 * 1024 * 1024;
const maximumNodes = 500_000;

const validateSource = (contents: Uint8Array): string => {
  if (contents.length > maximumLockfileBytes) {
    throw new TypeError("lockfile exceeds the 32 MiB safety limit");
  }
  if (contents.includes(0)) {
    throw new TypeError("text lockfile contains a NUL byte");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(contents);
};

const collectPackages = (value: unknown): ReadonlyArray<LockfilePackage> => {
  const packages = new Map<string, LockfilePackage>();
  const pending: Array<unknown> = [value];
  const seen = new Set<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    nodes += 1;
    if (nodes > maximumNodes) {
      throw new TypeError("lockfile structure exceeds the node safety limit");
    }
    if (typeof current !== "object" || current === null) {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    const object = current as Record<string, unknown>;
    if (typeof object.name === "string" && typeof object.version === "string") {
      packages.set(`${object.name}@${object.version}`, {
        name: object.name,
        version: object.version,
      });
    }
    for (const [key, entry] of Object.entries(object)) {
      const match = /^(?:\/)?((?:@[^/]+\/)?[^@/]+)@([^()]+)$/.exec(key);
      if (match !== null) {
        packages.set(`${match[1]}@${match[2]}`, {
          name: match[1]!,
          version: match[2]!,
        });
      }
      pending.push(entry);
    }
  }
  return [...packages.values()].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(
      `${right.name}@${right.version}`,
    ),
  );
};

const parseJson = (source: string): unknown => {
  const value = JSON.parse(source) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("lockfile must contain an object");
  }
  return value;
};

const parseYamlDocument = (source: string): unknown => {
  if ((source.match(/(?:^|\s)\*/g) ?? []).length > 1_000) {
    throw new TypeError("lockfile contains too many YAML aliases");
  }
  return parseYaml(source, { maxAliasCount: 1_000 });
};

const parseCargo = (source: string): ReadonlyArray<LockfilePackage> => {
  const packages: Array<LockfilePackage> = [];
  for (const block of source.split(/\n\s*\[\[package\]\]\s*\n/).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (name !== undefined && version !== undefined) {
      packages.push({ name, version });
    }
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
};

const parseYarnClassic = (source: string): ReadonlyArray<LockfilePackage> => {
  const packages: Array<LockfilePackage> = [];
  let selectors: ReadonlyArray<string> = [];
  for (const line of source.split(/\r?\n/)) {
    if (line !== "" && !line.startsWith(" ") && line.endsWith(":")) {
      selectors = line
        .slice(0, -1)
        .split(",")
        .map((entry) => entry.trim().replace(/^"|"$/g, ""));
    } else {
      const version = /^\s+version\s+"([^"]+)"/.exec(line)?.[1];
      if (version !== undefined) {
        for (const selector of selectors) {
          const name = selector.startsWith("@")
            ? selector.slice(0, selector.indexOf("@", 1))
            : selector.slice(0, selector.indexOf("@"));
          if (name !== "") {
            packages.push({ name, version });
          }
        }
      }
    }
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
};

const isYarnBerry = (source: string): boolean => {
  const firstKey = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("#") && line !== "---");
  return /^__metadata\s*:/.test(firstKey ?? "");
};

export const parseLockfile = (
  path: string,
  contents: Uint8Array,
): ParsedLockfile => {
  const name = baseName(path);
  if (name === "bun.lockb") {
    if (contents.length > maximumLockfileBytes) {
      throw new TypeError("lockfile exceeds the 32 MiB safety limit");
    }
    return { format: "bun-binary", packages: [] };
  }
  if (name === ".pnp.cjs") {
    validateSource(contents);
    return { format: "yarn-pnp", packages: [] };
  }
  const source = validateSource(contents);
  if (name === "package-lock.json" || name === "npm-shrinkwrap.json") {
    return { format: "npm", packages: collectPackages(parseJson(source)) };
  }
  if (name === "pnpm-lock.yaml") {
    return {
      format: "pnpm",
      packages: collectPackages(parseYamlDocument(source)),
    };
  }
  if (name === "yarn.lock") {
    return isYarnBerry(source)
      ? {
          format: "yarn-berry",
          packages: collectPackages(parseYamlDocument(source)),
        }
      : { format: "yarn-classic", packages: parseYarnClassic(source) };
  }
  if (name === "bun.lock") {
    return {
      format: "bun-text",
      packages: collectPackages(parseYamlDocument(source)),
    };
  }
  if (name === "Cargo.lock") {
    return { format: "cargo", packages: parseCargo(source) };
  }
  if (name === "uv.lock") {
    return {
      format: "uv",
      packages: collectPackages(parseYamlDocument(source)),
    };
  }
  if (name === "aube.lock") {
    return {
      format: "aube",
      packages: collectPackages(parseYamlDocument(source)),
    };
  }
  if (name === "nub.lock") {
    return {
      format: "nub",
      packages: collectPackages(parseYamlDocument(source)),
    };
  }
  throw new TypeError(`unsupported lockfile: ${name}`);
};
