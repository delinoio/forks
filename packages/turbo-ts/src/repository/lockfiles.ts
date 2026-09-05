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

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

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

const collectNpmPackages = (value: unknown): ReadonlyArray<LockfilePackage> => {
  const packages = new Map<string, LockfilePackage>();
  const document = objectValue(value);
  const locations = objectValue(document?.packages);
  if (locations === undefined) {
    const pending = [objectValue(document?.dependencies)];
    let nodes = 0;
    while (pending.length > 0) {
      const dependencies = pending.pop();
      for (const [name, value] of Object.entries(dependencies ?? {})) {
        nodes += 1;
        if (nodes > maximumNodes) {
          throw new TypeError(
            "lockfile structure exceeds the node safety limit",
          );
        }
        const entry = objectValue(value);
        if (typeof entry?.version === "string") {
          packages.set(`${name}@${entry.version}`, {
            name,
            version: entry.version,
          });
        }
        pending.push(objectValue(entry?.dependencies));
      }
    }
  } else {
    for (const [location, value] of Object.entries(locations)) {
      const entry = objectValue(value);
      const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(
        location,
      );
      if (
        match?.[1] === undefined ||
        typeof entry?.version !== "string" ||
        entry.link === true
      ) {
        continue;
      }
      packages.set(`${match[1]}@${entry.version}`, {
        name: match[1],
        version: entry.version,
      });
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

const yarnDescriptorName = (descriptor: string): string | undefined => {
  const separator = descriptor.startsWith("@")
    ? descriptor.indexOf("@", 1)
    : descriptor.indexOf("@");
  return separator <= 0 ? undefined : descriptor.slice(0, separator);
};

const parseYarnBerry = (source: string): ReadonlyArray<LockfilePackage> => {
  const document = objectValue(parseYamlDocument(source));
  if (document === undefined) {
    throw new TypeError("Yarn Berry lockfile is not an object");
  }
  const packages = new Map<string, LockfilePackage>();
  for (const [descriptors, value] of Object.entries(document)) {
    if (descriptors === "__metadata") continue;
    const entry = objectValue(value);
    if (typeof entry?.version !== "string") continue;
    const descriptorNames = descriptors.split(/,\s+/).flatMap((descriptor) => {
      const name = yarnDescriptorName(descriptor);
      return name === undefined ? [] : [name];
    });
    const resolutionName =
      typeof entry.resolution === "string"
        ? yarnDescriptorName(entry.resolution)
        : undefined;
    const names =
      descriptorNames.length === 0 && resolutionName !== undefined
        ? [resolutionName]
        : descriptorNames;
    for (const name of names) {
      packages.set(`${name}@${entry.version}`, {
        name,
        version: entry.version,
      });
    }
  }
  return [...packages.values()].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(
      `${right.name}@${right.version}`,
    ),
  );
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
    return { format: "npm", packages: collectNpmPackages(parseJson(source)) };
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
          packages: parseYarnBerry(source),
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

interface LockfileGraphEntry {
  readonly packages: ReadonlyArray<LockfilePackage>;
  readonly aliases: ReadonlyArray<string>;
  readonly dependencies: ReadonlyArray<
    readonly [name: string, reference: string | undefined]
  >;
  readonly sourceKey?: string;
  readonly localWorkspace?: boolean;
  readonly workspacePaths?: ReadonlyArray<string>;
}

export type LockfileDependencyReference = readonly [
  name: string,
  reference: string | undefined,
];

export interface LockfilePackageClosureContext {
  readonly workspacePath: string;
  readonly packageName: string;
  readonly packageVersion?: string;
  readonly directDependencies: ReadonlyArray<LockfileDependencyReference>;
  readonly workspacePackages?: ReadonlyArray<LockfilePackage>;
}

const lockfilePackageIdentity = (value: LockfilePackage): string =>
  `${value.name}@${value.version}`;

const dependencyObjectEntries = (
  value: unknown,
  includeDevelopmentDependencies: boolean,
): ReadonlyArray<readonly [string, string | undefined]> => {
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
    return Object.entries(dependencies).map(
      ([name, reference]) =>
        [
          name,
          typeof reference === "string"
            ? reference
            : typeof objectValue(reference)?.version === "string"
              ? (objectValue(reference)!.version as string)
              : undefined,
        ] as const,
    );
  });
};

const resolveGraphEntryClosure = (
  entries: ReadonlyArray<LockfileGraphEntry>,
  directDependencies: ReadonlyArray<LockfileDependencyReference>,
  initialEntries: ReadonlyArray<LockfileGraphEntry> = [],
): ReadonlySet<LockfileGraphEntry> => {
  if (entries.length > maximumNodes) {
    throw new TypeError("lockfile structure exceeds the node safety limit");
  }
  const aliases = new Map<string, Set<number>>();
  const names = new Map<string, Set<number>>();
  const addIndex = (
    index: Map<string, Set<number>>,
    key: string,
    entryIndex: number,
  ): void => {
    const matches = index.get(key) ?? new Set<number>();
    matches.add(entryIndex);
    index.set(key, matches);
  };
  for (const [entryIndex, entry] of entries.entries()) {
    for (const alias of entry.aliases) addIndex(aliases, alias, entryIndex);
    for (const package_ of entry.packages) {
      addIndex(names, package_.name, entryIndex);
      addIndex(aliases, lockfilePackageIdentity(package_), entryIndex);
    }
  }
  const matchesForReference = (
    name: string,
    reference: string | undefined,
  ): ReadonlySet<number> => {
    if (reference !== undefined) {
      const exact = new Set([
        ...(aliases.get(reference) ?? []),
        ...(aliases.get(`${name}@${reference}`) ?? []),
        ...(aliases.get(`${name}@npm:${reference}`) ?? []),
      ]);
      return exact;
    }
    return names.get(name) ?? new Set();
  };
  const pending = initialEntries.flatMap((entry) => {
    const index = entries.indexOf(entry);
    return index === -1 ? [] : [index];
  });
  for (const [name, reference] of directDependencies) {
    pending.push(...matchesForReference(name, reference));
  }
  const visited = new Set<number>();
  while (pending.length > 0) {
    const entryIndex = pending.pop()!;
    if (visited.has(entryIndex)) continue;
    visited.add(entryIndex);
    const entry = entries[entryIndex]!;
    for (const [name, reference] of entry.dependencies) {
      for (const dependencyIndex of matchesForReference(name, reference)) {
        if (!visited.has(dependencyIndex)) pending.push(dependencyIndex);
      }
    }
  }
  return new Set([...visited].map((index) => entries[index]!));
};

const resolveGraphPackageClosure = (
  entries: ReadonlyArray<LockfileGraphEntry>,
  directDependencies: ReadonlyArray<LockfileDependencyReference>,
  initialEntries: ReadonlyArray<LockfileGraphEntry> = [],
  excludedEntries: ReadonlyArray<LockfileGraphEntry> = [],
): ReadonlyArray<LockfilePackage> => {
  const packages = new Map<string, LockfilePackage>();
  const closure = resolveGraphEntryClosure(
    entries,
    directDependencies,
    initialEntries,
  );
  const internalEntries = new Set([...initialEntries, ...excludedEntries]);
  for (const entry of closure) {
    if (internalEntries.has(entry)) continue;
    for (const package_ of entry.packages) {
      packages.set(lockfilePackageIdentity(package_), package_);
    }
  }
  return [...packages.values()].sort((left, right) =>
    lockfilePackageIdentity(left).localeCompare(lockfilePackageIdentity(right)),
  );
};

const parseYarnClassicGraph = (
  source: string,
): ReadonlyArray<LockfileGraphEntry> => {
  const entries: Array<LockfileGraphEntry> = [];
  let selectors: ReadonlyArray<string> = [];
  let version: string | undefined;
  let dependencies: Array<readonly [string, string | undefined]> = [];
  let dependencySection = false;
  const flush = (): void => {
    if (version === undefined) return;
    const packageNames = [
      ...new Set(
        selectors.flatMap((selector) => {
          const name = yarnDescriptorName(selector);
          return name === undefined ? [] : [name];
        }),
      ),
    ];
    entries.push({
      packages: packageNames.map((name) => ({ name, version: version! })),
      aliases: selectors,
      dependencies,
    });
  };
  for (const line of source.split(/\r?\n/)) {
    if (line !== "" && !line.startsWith(" ") && line.endsWith(":")) {
      flush();
      selectors = line
        .slice(0, -1)
        .split(",")
        .map((entry) => entry.trim().replace(/^"|"$/g, ""));
      version = undefined;
      dependencies = [];
      dependencySection = false;
      continue;
    }
    const parsedVersion = /^\s+version\s+"([^"]+)"/.exec(line)?.[1];
    if (parsedVersion !== undefined) {
      version = parsedVersion;
      dependencySection = false;
      continue;
    }
    if (/^\s{2}(?:dependencies|optionalDependencies):\s*$/.test(line)) {
      dependencySection = true;
      continue;
    }
    if (!dependencySection) continue;
    const dependency =
      /^\s{4}(?:"([^"]+)"|(\S+))\s+(?:"([^"]+)"|(\S+))\s*$/.exec(line);
    if (dependency !== null) {
      dependencies.push([
        dependency[1] ?? dependency[2]!,
        dependency[3] ?? dependency[4],
      ]);
    } else if (/^\s{2}\S/.test(line)) {
      dependencySection = false;
    }
  }
  flush();
  return entries;
};

const parseYarnBerryGraph = (
  source: string,
  includeDevelopmentDependencies = false,
): ReadonlyArray<LockfileGraphEntry> => {
  const document = objectValue(parseYamlDocument(source));
  if (document === undefined) {
    throw new TypeError("Yarn Berry lockfile is not an object");
  }
  return Object.entries(document).flatMap(([descriptors, value]) => {
    if (descriptors === "__metadata") return [];
    const entry = objectValue(value);
    if (typeof entry?.version !== "string") return [];
    const selectorList = descriptors.split(/,\s+/);
    const descriptorNames = selectorList.flatMap((descriptor) => {
      const name = yarnDescriptorName(descriptor);
      return name === undefined ? [] : [name];
    });
    const resolution =
      typeof entry.resolution === "string" ? entry.resolution : undefined;
    const resolutionName =
      resolution === undefined ? undefined : yarnDescriptorName(resolution);
    const packageNames = [
      ...new Set(
        descriptorNames.length === 0 && resolutionName !== undefined
          ? [resolutionName]
          : descriptorNames,
      ),
    ];
    return [
      {
        packages: packageNames.map((name) => ({
          name,
          version: entry.version as string,
        })),
        aliases: [
          ...selectorList,
          ...(resolution === undefined ? [] : [resolution]),
        ],
        dependencies: dependencyObjectEntries(
          entry,
          includeDevelopmentDependencies,
        ),
        sourceKey: descriptors,
        localWorkspace: [
          ...selectorList,
          ...(resolution === undefined ? [] : [resolution]),
        ].some((alias) => workspaceReferencePath(alias) !== undefined),
      },
    ];
  });
};

const parseCargoGraph = (source: string): ReadonlyArray<LockfileGraphEntry> => {
  const document = objectValue(parseToml(source));
  const packages = document?.package;
  if (!Array.isArray(packages)) return [];
  return packages.flatMap((value) => {
    const package_ = objectValue(value);
    if (
      typeof package_?.name !== "string" ||
      typeof package_.version !== "string"
    ) {
      return [];
    }
    const dependencies = Array.isArray(package_.dependencies)
      ? package_.dependencies.flatMap((dependency) => {
          if (typeof dependency !== "string") return [];
          const match = /^(\S+)(?:\s+(\S+))?(?:\s+\((.+)\))?$/.exec(dependency);
          if (match === null) return [];
          const reference =
            match[2] === undefined
              ? undefined
              : `${match[2]}${match[3] === undefined ? "" : ` (${match[3]})`}`;
          return [[match[1]!, reference] as const];
        })
      : [];
    const packageSource =
      typeof package_.source === "string" ? package_.source : undefined;
    const versionAlias = `${package_.name}@${package_.version}`;
    return [
      {
        packages: [{ name: package_.name, version: package_.version }],
        aliases: [
          versionAlias,
          ...(packageSource === undefined
            ? []
            : [`${versionAlias} (${packageSource})`]),
        ],
        dependencies,
        localWorkspace: packageSource === undefined,
      },
    ];
  });
};

const parseUvGraph = (source: string): ReadonlyArray<LockfileGraphEntry> => {
  const document = objectValue(parseToml(source));
  const packages = document?.package;
  if (!Array.isArray(packages)) return [];
  return packages.flatMap((value) => {
    const package_ = objectValue(value);
    if (
      typeof package_?.name !== "string" ||
      typeof package_.version !== "string"
    ) {
      return [];
    }
    const dependencies = Array.isArray(package_.dependencies)
      ? package_.dependencies.flatMap((dependency) => {
          const object = objectValue(dependency);
          return typeof object?.name === "string"
            ? [
                [
                  object.name,
                  typeof object.version === "string"
                    ? object.version
                    : undefined,
                ] as const,
              ]
            : [];
        })
      : [];
    const source = objectValue(package_.source);
    const workspacePaths = [source?.virtual, source?.editable].flatMap(
      (path) =>
        typeof path === "string" ? [normalizeWorkspacePath(path)] : [],
    );
    return [
      {
        packages: [{ name: package_.name, version: package_.version }],
        aliases: [`${package_.name}@${package_.version}`],
        dependencies,
        localWorkspace: workspacePaths.length > 0,
        workspacePaths,
      },
    ];
  });
};

const normalizeWorkspacePath = (path: string): string => {
  const normalized = path.replace(/^\.\//, "").replace(/\/$/, "");
  return normalized === "" ? "." : normalized;
};

const workspaceReferencePath = (reference: string): string | undefined => {
  const marker = "@workspace:";
  const separator = reference.lastIndexOf(marker);
  if (separator !== -1) {
    return normalizeWorkspacePath(reference.slice(separator + marker.length));
  }
  return reference.startsWith("workspace:")
    ? normalizeWorkspacePath(reference.slice("workspace:".length))
    : undefined;
};

const bunPackageReference = (
  reference: string,
): LockfilePackage | undefined => {
  const separator = reference.startsWith("@")
    ? reference.indexOf("@", 1)
    : reference.indexOf("@");
  if (separator <= 0) return undefined;
  const name = reference.slice(0, separator);
  const rawVersion = reference.slice(separator + 1).replace(/^npm:/, "");
  if (/^(?:file|git|github|link|root|tarball|workspace):/.test(rawVersion)) {
    return undefined;
  }
  const version = rawVersion.split("(", 1)[0];
  return version === undefined || version === ""
    ? undefined
    : { name, version };
};

const parseBunGraph = (
  source: string,
  includeDevelopmentDependencies = false,
): {
  readonly entries: ReadonlyArray<LockfileGraphEntry>;
  readonly workspaces: Readonly<Record<string, unknown>>;
} => {
  const document = objectValue(parseYamlDocument(source));
  if (document === undefined)
    throw new TypeError("Bun lockfile is not an object");
  const entries = Object.entries(objectValue(document.packages) ?? {}).flatMap(
    ([key, value]) => {
      if (!Array.isArray(value) || typeof value[0] !== "string") return [];
      const package_ =
        bunPackageReference(value[0]) ?? bunPackageReference(key);
      if (
        package_ === undefined &&
        workspaceReferencePath(value[0]) === undefined
      ) {
        return [];
      }
      const information = value.find(
        (entry) => objectValue(entry) !== undefined,
      );
      return [
        {
          packages: package_ === undefined ? [] : [package_],
          aliases: [key, value[0]],
          dependencies: dependencyObjectEntries(
            information,
            includeDevelopmentDependencies,
          ),
          sourceKey: key,
        },
      ];
    },
  );
  return {
    entries,
    workspaces: objectValue(document.workspaces) ?? {},
  };
};

const dependencyVersion = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  const object = objectValue(value);
  return typeof object?.version === "string" ? object.version : undefined;
};

const dependencySpecifier = (value: unknown): string | undefined => {
  const object = objectValue(value);
  return typeof object?.specifier === "string" ? object.specifier : undefined;
};

interface PnpmDependencyKeys {
  readonly packageKey?: string;
  readonly snapshotKey?: string;
}

const pnpmKeyCandidates = (
  name: string,
  version: string,
): ReadonlyArray<string> => [
  `${name}@${version}`,
  `/${name}@${version}`,
  version.startsWith("/") ? version : `/${version}`,
  version,
];

const packageKeysForDependency = (
  packages: Readonly<Record<string, unknown>>,
  snapshots: Readonly<Record<string, unknown>>,
  name: string,
  rawVersion: string,
  specifier: string | undefined,
): PnpmDependencyKeys => {
  if (rawVersion.startsWith("link:") || rawVersion.startsWith("workspace:")) {
    return {};
  }
  const aliasPattern = /^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/;
  const specifierAlias =
    specifier === undefined ? null : aliasPattern.exec(specifier);
  const versionAlias = aliasPattern.exec(rawVersion);
  const targetName = specifierAlias?.[1] ?? versionAlias?.[1] ?? name;
  const resolvedVersion = versionAlias?.[2] ?? rawVersion;
  const targetVersion = resolvedVersion.startsWith(`${targetName}@`)
    ? resolvedVersion.slice(targetName.length + 1)
    : resolvedVersion;
  const peerQualifier = targetVersion.indexOf("(");
  const baseVersion =
    peerQualifier === -1
      ? targetVersion
      : targetVersion.slice(0, peerQualifier);
  return {
    packageKey: pnpmKeyCandidates(targetName, baseVersion).find(
      (candidate) => candidate in packages,
    ),
    snapshotKey: pnpmKeyCandidates(targetName, targetVersion).find(
      (candidate) => candidate in snapshots,
    ),
  };
};

const dependencyEntries = (
  value: unknown,
  includeDevelopmentDependencies: boolean,
): ReadonlyArray<readonly [string, string, string | undefined]> => {
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
      return version === undefined
        ? []
        : [[name, version, dependencySpecifier(descriptor)] as const];
    });
  });
};

const prunePnpmLockfile = (
  source: string,
  workspacePaths: ReadonlySet<string>,
  production: boolean,
  includeRootImporter = true,
): string => {
  const document = objectValue(parseYamlDocument(source));
  if (document === undefined)
    throw new TypeError("pnpm lockfile is not an object");
  const importers = objectValue(document.importers) ?? {};
  const retainedImporters = Object.fromEntries(
    Object.entries(importers)
      .filter(
        ([path]) =>
          (includeRootImporter && path === ".") || workspacePaths.has(path),
      )
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
  const retainedPackages = new Set<string>();
  const retainedSnapshots = new Set<string>();
  const pending: Array<PnpmDependencyKeys> = [];
  const enqueueDependencies = (value: unknown): void => {
    for (const [name, version, specifier] of dependencyEntries(
      value,
      !production,
    )) {
      const keys = packageKeysForDependency(
        packages,
        snapshots,
        name,
        version,
        specifier,
      );
      if (
        (keys.packageKey !== undefined &&
          !retainedPackages.has(keys.packageKey)) ||
        (keys.snapshotKey !== undefined &&
          !retainedSnapshots.has(keys.snapshotKey))
      ) {
        pending.push(keys);
      }
    }
  };
  for (const importer of Object.values(retainedImporters)) {
    enqueueDependencies(importer);
  }
  while (pending.length > 0) {
    const keys = pending.pop()!;
    if (
      keys.packageKey !== undefined &&
      !retainedPackages.has(keys.packageKey)
    ) {
      retainedPackages.add(keys.packageKey);
      enqueueDependencies(packages[keys.packageKey]);
    }
    if (
      keys.snapshotKey !== undefined &&
      !retainedSnapshots.has(keys.snapshotKey)
    ) {
      retainedSnapshots.add(keys.snapshotKey);
      enqueueDependencies(snapshots[keys.snapshotKey]);
    }
  }
  const pruned: Record<string, unknown> = { ...document };
  pruned.importers = retainedImporters;
  if (document.packages !== undefined) {
    pruned.packages = Object.fromEntries(
      Object.entries(packages).filter(([key]) => retainedPackages.has(key)),
    );
  }
  if (document.snapshots !== undefined) {
    pruned.snapshots = Object.fromEntries(
      Object.entries(snapshots).filter(([key]) => retainedSnapshots.has(key)),
    );
  }
  return stringifyYaml(pruned, { lineWidth: 0, singleQuote: true });
};

const pruneNpmLockfile = (
  source: string,
  workspacePaths: ReadonlySet<string>,
  production: boolean,
  includeRootPackage = true,
): string => {
  const document = objectValue(parseJson(source));
  if (document === undefined)
    throw new TypeError("npm lockfile is not an object");
  const packages = objectValue(document.packages);
  if (packages === undefined) {
    if (production && document.dependencies !== undefined) {
      const pruneLegacyDependencies = (
        value: unknown,
      ): Readonly<Record<string, unknown>> =>
        Object.fromEntries(
          Object.entries(objectValue(value) ?? {}).flatMap(
            ([name, rawEntry]) => {
              const entry = objectValue(rawEntry);
              if (entry?.dev === true) return [];
              if (entry?.dependencies === undefined) return [[name, rawEntry]];
              return [
                [
                  name,
                  {
                    ...entry,
                    dependencies: pruneLegacyDependencies(entry.dependencies),
                  },
                ],
              ];
            },
          ),
        );
      document.dependencies = pruneLegacyDependencies(document.dependencies);
    }
    return `${JSON.stringify(document, undefined, 2)}\n`;
  }
  const selectedWorkspaces = new Set(
    [...workspacePaths].map((path) => path.replace(/^\.\//, "")),
  );
  const retained = new Set<string>();
  const pending = [
    ...(includeRootPackage ? [""] : []),
    ...[...selectedWorkspaces].filter((path) => path in packages),
  ];
  const packageDependencyNames = (value: unknown): ReadonlyArray<string> => {
    const entry = objectValue(value);
    if (entry === undefined) return [];
    return [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      ...(production ? [] : ["devDependencies"]),
    ].flatMap((field) => Object.keys(objectValue(entry[field]) ?? {}));
  };
  const dependencyLocation = (
    location: string,
    name: string,
  ): string | undefined => {
    const segments = location === "" ? [] : location.split("/");
    while (true) {
      const candidate = [...segments, "node_modules", name].join("/");
      if (candidate in packages) return candidate;
      if (segments.length === 0) return undefined;
      segments.pop();
    }
  };
  const selectedLinkTarget = (value: unknown): boolean => {
    const entry = objectValue(value);
    if (entry?.link !== true || typeof entry.resolved !== "string") {
      return true;
    }
    return selectedWorkspaces.has(entry.resolved.replace(/^\.\//, ""));
  };
  for (const [location, value] of Object.entries(packages)) {
    const entry = objectValue(value);
    if (
      location.startsWith("node_modules/") &&
      entry?.link === true &&
      selectedLinkTarget(entry)
    ) {
      pending.push(location);
    }
  }
  while (pending.length > 0) {
    const location = pending.pop()!;
    if (retained.has(location) || !(location in packages)) continue;
    const value = packages[location];
    if (!selectedLinkTarget(value)) continue;
    retained.add(location);
    for (const name of packageDependencyNames(value)) {
      const dependency = dependencyLocation(location, name);
      if (dependency !== undefined && !retained.has(dependency)) {
        pending.push(dependency);
      }
    }
  }
  document.packages = Object.fromEntries(
    Object.entries(packages)
      .filter(([path]) => retained.has(path))
      .map(([path, value]) => {
        if (!production) return [path, value];
        const entry = objectValue(value);
        if (entry === undefined) return [path, value];
        const { devDependencies: _devDependencies, ...productionEntry } = entry;
        return [path, productionEntry];
      }),
  );
  if (document.dependencies !== undefined) {
    const pruneLegacyDependencies = (
      value: unknown,
      parentLocation = "",
    ): Readonly<Record<string, unknown>> =>
      Object.fromEntries(
        Object.entries(objectValue(value) ?? {}).flatMap(([name, rawEntry]) => {
          const location = `${parentLocation === "" ? "" : `${parentLocation}/`}node_modules/${name}`;
          if (!retained.has(location)) return [];
          const entry = objectValue(rawEntry);
          if (entry?.dependencies === undefined) return [[name, rawEntry]];
          return [
            [
              name,
              {
                ...entry,
                dependencies: pruneLegacyDependencies(
                  entry.dependencies,
                  location,
                ),
              },
            ],
          ];
        }),
      );
    document.dependencies = pruneLegacyDependencies(document.dependencies);
  }
  return `${JSON.stringify(document, undefined, 2)}\n`;
};

export interface LockfilePruneManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

export interface LockfilePruneOptions {
  readonly production?: boolean;
  readonly manifests?: ReadonlyArray<LockfilePruneManifest>;
}

const withoutDevelopmentDependencies = (value: unknown): unknown => {
  const object = objectValue(value);
  if (object === undefined || object.devDependencies === undefined)
    return value;
  const { devDependencies: _devDependencies, ...productionValue } = object;
  return productionValue;
};

const selectedWorkspacePaths = (
  workspacePaths: ReadonlySet<string>,
): ReadonlySet<string> =>
  new Set([".", ...[...workspacePaths].map(normalizeWorkspacePath)]);

const pruneDependencySeeds = (
  options: LockfilePruneOptions,
): ReadonlyArray<LockfileDependencyReference> =>
  (options.manifests ?? []).flatMap((manifest) =>
    dependencyObjectEntries(manifest, options.production !== true),
  );

const yarnClassicBlocks = (
  source: string,
): {
  readonly preamble: string;
  readonly entries: ReadonlyArray<{
    readonly source: string;
    readonly aliases: ReadonlyArray<string>;
  }>;
} => {
  const lines = source.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
  let preamble = "";
  const entries: Array<{ source: string; aliases: ReadonlyArray<string> }> = [];
  for (const line of lines) {
    const content = line.replace(/\r?\n$/, "");
    if (content !== "" && !content.startsWith(" ") && content.endsWith(":")) {
      entries.push({
        source: line,
        aliases: content
          .slice(0, -1)
          .split(",")
          .map((entry) => entry.trim().replace(/^"|"$/g, "")),
      });
      continue;
    }
    const current = entries.at(-1);
    if (current === undefined) {
      preamble += line;
    } else {
      entries[entries.length - 1] = {
        ...current,
        source: current.source + line,
      };
    }
  }
  return { preamble, entries };
};

const pruneYarnClassicLockfile = (
  source: string,
  dependencies: ReadonlyArray<LockfileDependencyReference>,
): string => {
  const closure = resolveGraphEntryClosure(
    parseYarnClassicGraph(source),
    dependencies,
  );
  const retainedAliases = new Set(
    [...closure].flatMap((entry) => entry.aliases),
  );
  const document = yarnClassicBlocks(source);
  return (
    document.preamble +
    document.entries
      .filter((entry) =>
        entry.aliases.some((alias) => retainedAliases.has(alias)),
      )
      .map((entry) => entry.source)
      .join("")
  );
};

const pruneYarnBerryLockfile = (
  source: string,
  workspacePaths: ReadonlySet<string>,
  dependencies: ReadonlyArray<LockfileDependencyReference>,
  production: boolean,
): string => {
  const document = objectValue(parseYamlDocument(source));
  if (document === undefined)
    throw new TypeError("Yarn Berry lockfile is not an object");
  const selectedPaths = selectedWorkspacePaths(workspacePaths);
  const graph = parseYarnBerryGraph(source, !production);
  const workspaceEntries = graph.filter((entry) =>
    entry.aliases.some((alias) => {
      const path = workspaceReferencePath(alias);
      return path !== undefined && selectedPaths.has(path);
    }),
  );
  const closure = resolveGraphEntryClosure(
    graph,
    dependencies,
    workspaceEntries,
  );
  const retainedKeys = new Set(
    [...closure].flatMap((entry) =>
      entry.sourceKey === undefined ? [] : [entry.sourceKey],
    ),
  );
  return stringifyYaml(
    Object.fromEntries(
      Object.entries(document).flatMap(([key, value]) =>
        key === "__metadata" || retainedKeys.has(key)
          ? [[key, production ? withoutDevelopmentDependencies(value) : value]]
          : [],
      ),
    ),
    { lineWidth: 0, singleQuote: true },
  );
};

const pruneBunLockfile = (
  source: string,
  workspacePaths: ReadonlySet<string>,
  dependencies: ReadonlyArray<LockfileDependencyReference>,
  production: boolean,
): string => {
  const document = objectValue(parseYamlDocument(source));
  if (document === undefined)
    throw new TypeError("Bun lockfile is not an object");
  const selectedPaths = selectedWorkspacePaths(workspacePaths);
  const workspaces = objectValue(document.workspaces) ?? {};
  const retainedWorkspaces = Object.fromEntries(
    Object.entries(workspaces)
      .filter(([path]) => selectedPaths.has(normalizeWorkspacePath(path)))
      .map(([path, value]) => [
        path,
        production ? withoutDevelopmentDependencies(value) : value,
      ]),
  );
  const graph = parseBunGraph(source, !production).entries;
  const workspaceEntries = graph.filter((entry) =>
    entry.aliases.some((alias) => {
      const path = workspaceReferencePath(alias);
      return path !== undefined && selectedPaths.has(path);
    }),
  );
  const workspaceDependencies = Object.values(retainedWorkspaces).flatMap(
    (workspace) => dependencyObjectEntries(workspace, !production),
  );
  const closure = resolveGraphEntryClosure(
    graph,
    [...dependencies, ...workspaceDependencies],
    workspaceEntries,
  );
  const retainedPackageKeys = new Set(
    [...closure].flatMap((entry) =>
      entry.sourceKey === undefined ? [] : [entry.sourceKey],
    ),
  );
  const packages = objectValue(document.packages) ?? {};
  return `${JSON.stringify(
    {
      ...document,
      workspaces: retainedWorkspaces,
      packages: Object.fromEntries(
        Object.entries(packages).filter(([key]) =>
          retainedPackageKeys.has(key),
        ),
      ),
    },
    undefined,
    2,
  )}\n`;
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
  options: LockfilePruneOptions = {},
): Uint8Array => {
  const parsed = parseLockfile(path, contents);
  if (parsed.format === "bun-binary" || parsed.format === "yarn-pnp") {
    return contents;
  }
  const source = validateSource(contents);
  const dependencies = pruneDependencySeeds(options);
  const output =
    parsed.format === "pnpm"
      ? prunePnpmLockfile(source, workspacePaths, options.production === true)
      : parsed.format === "npm"
        ? pruneNpmLockfile(source, workspacePaths, options.production === true)
        : parsed.format === "yarn-classic"
          ? pruneYarnClassicLockfile(source, dependencies)
          : parsed.format === "yarn-berry"
            ? pruneYarnBerryLockfile(
                source,
                workspacePaths,
                dependencies,
                options.production === true,
              )
            : parsed.format === "bun-text"
              ? pruneBunLockfile(
                  source,
                  workspacePaths,
                  dependencies,
                  options.production === true,
                )
              : source;
  return new TextEncoder().encode(output);
};

export const resolveLockfilePackageClosure = (
  path: string,
  contents: Uint8Array,
  context: LockfilePackageClosureContext,
): ReadonlyArray<LockfilePackage> => {
  const parsed = parseLockfile(path, contents);
  const includeRoot = context.workspacePath === ".";
  const workspacePaths = new Set(includeRoot ? [] : [context.workspacePath]);
  const directDependencyNames = new Set(
    context.directDependencies.map(([name]) => name),
  );
  if (
    parsed.format === "pnpm" ||
    parsed.format === "aube" ||
    parsed.format === "nub"
  ) {
    const source = validateSource(contents);
    return parseLockfile(
      path,
      new TextEncoder().encode(
        prunePnpmLockfile(source, workspacePaths, false, includeRoot),
      ),
    ).packages;
  }
  if (parsed.format === "npm") {
    const source = validateSource(contents);
    return parseLockfile(
      path,
      new TextEncoder().encode(
        pruneNpmLockfile(source, workspacePaths, false, includeRoot),
      ),
    ).packages;
  }
  const source = validateSource(contents);
  if (parsed.format === "yarn-classic") {
    return resolveGraphPackageClosure(
      parseYarnClassicGraph(source),
      context.directDependencies,
    );
  }
  if (parsed.format === "yarn-berry") {
    const graph = parseYarnBerryGraph(source);
    const workspacePath = normalizeWorkspacePath(context.workspacePath);
    const localWorkspaceEntries = graph.filter(
      (entry) => entry.localWorkspace === true,
    );
    const workspaceEntries = graph.filter((entry) =>
      entry.aliases.some(
        (alias) => workspaceReferencePath(alias) === workspacePath,
      ),
    );
    return resolveGraphPackageClosure(
      graph,
      context.directDependencies,
      workspaceEntries,
      localWorkspaceEntries,
    );
  }
  if (parsed.format === "cargo") {
    const graph = parseCargoGraph(source);
    const workspacePackageIdentities = new Set(
      (context.workspacePackages ?? []).map(lockfilePackageIdentity),
    );
    const localWorkspaceEntries = graph.filter(
      (entry) =>
        entry.localWorkspace === true &&
        entry.packages.some((package_) =>
          workspacePackageIdentities.has(lockfilePackageIdentity(package_)),
        ),
    );
    const workspaceEntries = graph.filter(
      (entry) =>
        entry.localWorkspace === true &&
        entry.packages.some(
          (package_) =>
            package_.name === context.packageName &&
            (context.packageVersion === undefined ||
              package_.version === context.packageVersion),
        ),
    );
    return resolveGraphPackageClosure(
      graph,
      workspaceEntries.length === 0 ? context.directDependencies : [],
      workspaceEntries,
      localWorkspaceEntries,
    );
  }
  if (parsed.format === "uv") {
    const graph = parseUvGraph(source);
    const workspacePath = normalizeWorkspacePath(context.workspacePath);
    const matchingPaths = graph.filter((entry) =>
      entry.workspacePaths?.includes(workspacePath),
    );
    const workspaceEntries =
      matchingPaths.length > 0
        ? matchingPaths
        : graph.filter(
            (entry) =>
              entry.localWorkspace === true &&
              entry.packages.some(
                (package_) =>
                  package_.name === context.packageName &&
                  (context.packageVersion === undefined ||
                    package_.version === context.packageVersion),
              ),
          );
    return resolveGraphPackageClosure(
      graph,
      workspaceEntries.length === 0 ? context.directDependencies : [],
      workspaceEntries,
      graph.filter((entry) => entry.localWorkspace === true),
    );
  }
  if (parsed.format === "bun-text") {
    const graph = parseBunGraph(source);
    const workspaceKey =
      context.workspacePath === "."
        ? ""
        : context.workspacePath.replace(/^\.\//, "");
    const workspaceReferences = dependencyObjectEntries(
      graph.workspaces[workspaceKey],
      true,
    ).filter(([name]) => directDependencyNames.has(name));
    return resolveGraphPackageClosure(graph.entries, [
      ...context.directDependencies,
      ...workspaceReferences,
    ]);
  }
  return parsed.packages.filter((dependency) =>
    directDependencyNames.has(dependency.name),
  );
};
