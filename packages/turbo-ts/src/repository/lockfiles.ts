import { parse as parseToml } from "smol-toml";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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
      packages: collectPackages(parseToml(source)),
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

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const dependencyVersion = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  const object = objectValue(value);
  return typeof object?.version === "string" ? object.version : undefined;
};

const packageKeyForDependency = (
  packages: Readonly<Record<string, unknown>>,
  name: string,
  rawVersion: string,
): string | undefined => {
  if (
    rawVersion.startsWith("link:") ||
    rawVersion.startsWith("workspace:") ||
    rawVersion.startsWith("file:")
  ) {
    return undefined;
  }
  const version = rawVersion.startsWith("npm:")
    ? rawVersion.slice(4).replace(/^((?:@[^/]+\/)?[^@]+)@/, "")
    : rawVersion;
  const candidates = [
    `${name}@${version}`,
    `/${name}@${version}`,
    version.startsWith("/") ? version : `/${version}`,
    version,
  ];
  return candidates.find((candidate) => candidate in packages);
};

const dependencyEntries = (
  value: unknown,
  includeDevelopmentDependencies: boolean,
): ReadonlyArray<readonly [string, string]> => {
  const object = objectValue(value);
  if (object === undefined) return [];
  return [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    ...(includeDevelopmentDependencies ? ["devDependencies"] : []),
  ].flatMap((field) => {
    const dependencies = objectValue(object[field]);
    if (dependencies === undefined) return [];
    return Object.entries(dependencies).flatMap(([name, descriptor]) => {
      const version = dependencyVersion(descriptor);
      return version === undefined ? [] : [[name, version] as const];
    });
  });
};

const prunePnpmLockfile = (
  source: string,
  workspacePaths: ReadonlySet<string>,
  production: boolean,
): string => {
  const document = objectValue(parseYamlDocument(source));
  if (document === undefined)
    throw new TypeError("pnpm lockfile is not an object");
  const importers = objectValue(document.importers) ?? {};
  const retainedImporters = Object.fromEntries(
    Object.entries(importers)
      .filter(([path]) => path === "." || workspacePaths.has(path))
      .map(([path, value]) => {
        if (!production) return [path, value];
        const importer = objectValue(value);
        if (importer === undefined) return [path, value];
        const { devDependencies: _devDependencies, ...productionImporter } =
          importer;
        return [path, productionImporter];
      }),
  );
  const packages = objectValue(document.packages) ?? {};
  const snapshots = objectValue(document.snapshots) ?? {};
  const retained = new Set<string>();
  const pending: Array<string> = [];
  const enqueueDependencies = (value: unknown): void => {
    for (const [name, version] of dependencyEntries(value, !production)) {
      const key = packageKeyForDependency(packages, name, version);
      if (key !== undefined && !retained.has(key)) pending.push(key);
    }
  };
  for (const importer of Object.values(retainedImporters)) {
    enqueueDependencies(importer);
  }
  while (pending.length > 0) {
    const key = pending.pop()!;
    if (retained.has(key)) continue;
    retained.add(key);
    enqueueDependencies(packages[key]);
    enqueueDependencies(snapshots[key]);
  }
  const pruned: Record<string, unknown> = { ...document };
  pruned.importers = retainedImporters;
  if (document.packages !== undefined) {
    pruned.packages = Object.fromEntries(
      Object.entries(packages).filter(([key]) => retained.has(key)),
    );
  }
  if (document.snapshots !== undefined) {
    pruned.snapshots = Object.fromEntries(
      Object.entries(snapshots).filter(([key]) => retained.has(key)),
    );
  }
  return stringifyYaml(pruned, { lineWidth: 0, singleQuote: true });
};

const pruneNpmLockfile = (
  source: string,
  workspacePaths: ReadonlySet<string>,
): string => {
  const document = objectValue(parseJson(source));
  if (document === undefined)
    throw new TypeError("npm lockfile is not an object");
  const packages = objectValue(document.packages);
  if (packages === undefined)
    return `${JSON.stringify(document, undefined, 2)}\n`;
  document.packages = Object.fromEntries(
    Object.entries(packages).filter(([path]) => {
      if (path === "" || path.startsWith("node_modules/")) return true;
      return [...workspacePaths].some(
        (workspace) =>
          path === workspace || path.startsWith(`${workspace}/node_modules/`),
      );
    }),
  );
  return `${JSON.stringify(document, undefined, 2)}\n`;
};

/**
 * Prunes independently parsed lockfile formats without consulting a package
 * manager implementation. Formats whose public artifact does not expose a
 * safely rewritable workspace index are validated and preserved byte-for-byte.
 */
export const pruneLockfile = (
  path: string,
  contents: Uint8Array,
  workspacePaths: ReadonlySet<string>,
  options: { readonly production?: boolean } = {},
): Uint8Array => {
  const parsed = parseLockfile(path, contents);
  if (parsed.format === "bun-binary" || parsed.format === "yarn-pnp") {
    return contents;
  }
  const source = validateSource(contents);
  const output =
    parsed.format === "pnpm"
      ? prunePnpmLockfile(source, workspacePaths, options.production === true)
      : parsed.format === "npm"
        ? pruneNpmLockfile(source, workspacePaths)
        : source;
  return new TextEncoder().encode(output);
};
