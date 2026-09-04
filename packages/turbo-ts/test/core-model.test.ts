import { describe, expect, it } from "@rstest/core";
import {
  createTarArchive,
  maximumCacheArchiveOverheadBytes,
  parseTarArchive,
  tarBlockSize,
} from "../src/cache/archive.js";
import { evidenceId } from "../src/compatibility/ledger.js";
import {
  mergePipeline,
  parseJsonConfiguration,
} from "../src/config/runtime.js";
import { matchesGlob, selectByGlobs } from "../src/core/glob.js";
import {
  isAbsolutePath,
  isPathContained,
  joinPath,
  joinPathWithSeparators,
  normalizePath,
  parentPath,
  relativePath,
} from "../src/core/path.js";
import { GraphError } from "../src/effect/errors.js";
import {
  buildTaskGraph,
  selectPackages,
  type TaskGraph,
  type TaskNode,
  topologicalOrder,
} from "../src/graph/task-graph.js";
import {
  canonicalStringify,
  implicitTaskInputCandidates,
  selectEnvironment,
} from "../src/hash/task-hash.js";
import { createXxhash64, xxhash64Hex } from "../src/hash/xxhash64.js";
import {
  finishTaskOutput,
  initialTaskOutputRenderState,
  renderLogEvent,
  renderTaskOutputChunk,
} from "../src/logging/events.js";
import {
  parseLockfile,
  resolveLockfilePackageClosure,
} from "../src/repository/lockfiles.js";
import type {
  RepositoryModel,
  RepositoryPackage,
} from "../src/repository/model.js";
import {
  managerFromIdentity,
  parseCargoMetadata,
} from "../src/repository/model.js";
import {
  cargoWorkspaceHash,
  isTaskScopeCacheable,
  packageManagerCommand,
  parseCacheSpecification,
  planCargoWorkspaceTasks,
  resolveOptions,
  taskIdsWithUnrestorableCacheInputs,
  taskScopeEnvironment,
} from "../src/run/engine.js";
import { parseConcurrency, parseRunArguments } from "../src/run/options.js";

const encoder = new TextEncoder();

const updateTarChecksum = (archive: Uint8Array): void => {
  const checksum = archive
    .subarray(0, tarBlockSize)
    .reduce(
      (total, byte, index) =>
        total + (index >= 148 && index < 156 ? 0x20 : byte),
      0,
    );
  archive.fill(0, 148, 156);
  archive.set(encoder.encode(checksum.toString(8).padStart(6, "0")), 148);
  archive[154] = 0;
  archive[155] = 0x20;
};

const packageModel = (
  name: string,
  dependencies: ReadonlyArray<string>,
  task: Record<string, unknown> = {},
): RepositoryPackage => ({
  identity: name,
  name,
  directory: `/repo/packages/${name}`,
  relativeDirectory: `packages/${name}`,
  canonicalRelativeDirectory: `packages/${name}`,
  cachePathRestorable: true,
  cacheInputsComplete: true,
  manager: "pnpm",
  scripts: {
    build: `node -e "console.log('${name}')"`,
    dev: 'node -e "setInterval(() => {}, 1000)"',
  },
  dependencyNames: dependencies,
  internalDependencies: dependencies,
  excludedTasks: new Set(),
  tasks: { build: task, dev: { persistent: true } },
  manifest: { name, scripts: {} },
});

const repository = (
  packages: ReadonlyArray<RepositoryPackage>,
): RepositoryModel => {
  const rootPackage = {
    ...packageModel("//", []),
    directory: "/repo",
    relativeDirectory: ".",
    canonicalRelativeDirectory: ".",
  } satisfies RepositoryPackage;
  const packagesByIdentity = new Map([
    [rootPackage.identity, rootPackage],
    ...packages.map((entry) => [entry.identity, entry] as const),
  ]);
  return {
    root: "/repo",
    manager: "pnpm",
    managerVersion: "10.34.5",
    rootManifest: { name: "root", private: true },
    rootConfiguration: {
      path: "/repo/turbo.json",
      value: {},
      hiddenFutureFlags: {},
    },
    rootPackage,
    packages,
    packagesByIdentity,
    packagesByName: packagesByIdentity,
  };
};

describe("core repository model", () => {
  it("renders streamed task output identically with bounded chunks", () => {
    const output = `${"🙂value".repeat(20_000)}\nsecond line`;
    const inputChunks = [
      output.slice(0, 7),
      output.slice(7, 70_003),
      output.slice(70_003),
    ];
    let state = initialTaskOutputRenderState;
    const renderedChunks: Array<string> = [];
    for (const input of inputChunks) {
      const rendered = renderTaskOutputChunk(
        state,
        "package:build",
        input,
        true,
      );
      state = rendered.state;
      renderedChunks.push(...rendered.chunks);
    }
    renderedChunks.push(...finishTaskOutput(state));
    expect(renderedChunks.join("")).toBe(
      renderLogEvent(
        { kind: "task-output", task: "package:build", output },
        true,
      ),
    );
    expect(
      Math.max(...renderedChunks.map((chunk) => chunk.length)),
    ).toBeLessThanOrEqual(64 * 1024);
    expect(
      renderTaskOutputChunk(
        initialTaskOutputRenderState,
        "package:build",
        "ready\n",
        false,
      ),
    ).toEqual({
      state: { atLineStart: true, pending: "" },
      chunks: ["package:build: ready\n"],
    });
  });

  it(evidenceId.coreModel, () => {
    expect(xxhash64Hex("")).toBe("ef46db3751d8e999");
    expect(xxhash64Hex("a")).toBe("d24ec4f1a98c6e5b");
    expect(xxhash64Hex("abc")).toBe("44bc2cf5ad770999");
    const bytes = new Uint8Array(257).map((_, index) => index % 251);
    const streamed = createXxhash64();
    for (const [start, end] of [
      [0, 1],
      [1, 31],
      [31, 32],
      [32, 95],
      [95, bytes.length],
    ] as const) {
      streamed.update(bytes.subarray(start, end));
    }
    expect(streamed.digest().toString(16).padStart(16, "0")).toBe(
      xxhash64Hex(bytes),
    );
  });

  it("normalizes and contains repository paths", () => {
    expect(normalizePath("/repo/packages/../apps/web")).toBe("/repo/apps/web");
    expect(joinPath("/repo", "packages", "app")).toBe("/repo/packages/app");
    expect(relativePath("/repo", "/repo/packages/app")).toBe("packages/app");
    expect(isPathContained("/repo", "/repo/packages/app")).toBe(true);
    expect(isPathContained("/repo", "/outside")).toBe(false);
    expect(isAbsolutePath("C:\\repo", true)).toBe(true);
    expect(isAbsolutePath("packages/app")).toBe(false);
    expect(isAbsolutePath("\\\\server\\share\\repo", true)).toBe(true);
    expect(normalizePath("/repo/dist\\artifact", false)).toBe(
      "/repo/dist\\artifact",
    );
    expect(relativePath("/repo", "/repo/dist\\artifact", false)).toBe(
      "dist\\artifact",
    );
    expect(isPathContained("/repo", "/repo/dist\\artifact", false)).toBe(true);
    expect(
      normalizePath("\\\\server\\share\\repo\\packages\\..\\app", true),
    ).toBe("//server/share/repo/app");
    expect(
      joinPathWithSeparators(true, "\\\\server\\share", "repo", "app"),
    ).toBe("//server/share/repo/app");
    expect(parentPath("//server/share", true)).toBe("//server/share");
    expect(parentPath("//server/share/repo", true)).toBe("//server/share");
    expect(
      relativePath("//server/share/repo", "//server/share/repo/app", true),
    ).toBe("app");
    expect(isPathContained("//SERVER/Share", "//server/share/repo", true)).toBe(
      true,
    );
    expect(isPathContained("//server/share", "//server/other/repo", true)).toBe(
      false,
    );
    if (process.platform !== "win32") {
      expect(joinPath("/tmp/repo\\copy", "package.json")).toBe(
        "/tmp/repo\\copy/package.json",
      );
      expect(normalizePath("/tmp/repo\\copy")).toBe("/tmp/repo\\copy");
    }
  });

  it("matches workspace and input globs with negation", () => {
    expect(matchesGlob("packages/app/src/index.ts", "packages/*/**")).toBe(
      true,
    );
    expect(
      selectByGlobs(
        ["src/a.ts", "src/a.test.ts", "README.md"],
        ["src/**", "!**/*.test.ts"],
      ),
    ).toEqual(["src/a.ts"]);
    expect(matchesGlob("src/app.tsx", "src/**/*.{ts,tsx}")).toBe(true);
    expect(matchesGlob("assets/7-logo.png", "assets/[0-9]*.png")).toBe(true);
    expect(matchesGlob("assets/a-logo.png", "assets/[0-9]*.png")).toBe(false);
    expect(matchesGlob("src\\config.json", "src/**")).toBe(false);
    expect(matchesGlob("src\\config.json", "src/**", true)).toBe(true);
    expect(
      selectByGlobs(["src\\config.json", "src/config.json"], ["**", "!src/**"]),
    ).toEqual(["src\\config.json"]);
  });

  it("parses JSONC without interpreting comment markers inside strings", () => {
    expect(
      parseJsonConfiguration(
        '{ // comment\n "url": "https://example.test/a//b", "description": "keep, } and, ]", "tasks": { "build": {}, }, }',
        "turbo.jsonc",
      ),
    ).toEqual({
      url: "https://example.test/a//b",
      description: "keep, } and, ]",
      tasks: { build: {} },
    });
    expect(() =>
      parseJsonConfiguration('{"tasks": {}} /* unfinished', "turbo.jsonc"),
    ).toThrow(/unterminated block comment/);
  });

  it("merges package task arrays and the explicit inheritance marker", () => {
    expect(
      mergePipeline(
        { dependsOn: ["^build"], outputs: ["dist/**"], cache: true },
        { dependsOn: ["$TURBO_EXTENDS$", "lint"], outputs: ["build/**"] },
      ),
    ).toEqual({
      dependsOn: ["^build", "lint"],
      outputs: ["build/**"],
      cache: true,
      env: undefined,
      inputs: undefined,
      passThroughEnv: undefined,
      with: undefined,
    });
  });

  it("parses every lockfile family and rejects malicious text", () => {
    expect(
      parseLockfile(
        "/repo/package-lock.json",
        encoder.encode(
          '{"lockfileVersion":3,"packages":{"node_modules/a":{"version":"1.0.0"},"node_modules/@scope/b":{"version":"2.0.0"},"node_modules/parent/node_modules/nested":{"version":"3.0.0"}}}',
        ),
      ),
    ).toMatchObject({
      format: "npm",
      packages: [
        { name: "@scope/b", version: "2.0.0" },
        { name: "a", version: "1.0.0" },
        { name: "nested", version: "3.0.0" },
      ],
    });
    expect(
      parseLockfile(
        "/repo/pnpm-lock.yaml",
        encoder.encode("lockfileVersion: '9.0'\npackages:\n  a@1.0.0: {}\n"),
      ).format,
    ).toBe("pnpm");
    expect(
      parseLockfile(
        "/repo/yarn.lock",
        encoder.encode('a@^1.0.0:\n  version "1.0.1"\n'),
      ),
    ).toMatchObject({
      format: "yarn-classic",
      packages: [{ name: "a", version: "1.0.1" }],
    });
    expect(
      parseLockfile(
        "/repo/Cargo.lock",
        encoder.encode(
          'version = 4\n\n[[package]]\nname = "crate-a"\nversion = "1.2.3"\n',
        ),
      ),
    ).toMatchObject({
      format: "cargo",
      packages: [{ name: "crate-a", version: "1.2.3" }],
    });
    expect(
      parseLockfile(
        "/repo/yarn.lock",
        encoder.encode(
          '# This file is generated by Yarn.\n# Manual changes may be lost.\n\n__metadata:\n  version: 8\n"a@npm:^1.0.0":\n  version: 1.0.1\n  resolution: "a@npm:1.0.1"\n"@scope/b@npm:^2.0.0, @scope/b@npm:~2.1.0":\n  version: 2.1.3\n  resolution: "@scope/b@npm:2.1.3"\n',
        ),
      ),
    ).toMatchObject({
      format: "yarn-berry",
      packages: expect.arrayContaining([
        { name: "a", version: "1.0.1" },
        { name: "@scope/b", version: "2.1.3" },
      ]),
    });
    expect(
      parseLockfile("/repo/.pnp.cjs", encoder.encode("module.exports = {};")),
    ).toMatchObject({ format: "yarn-pnp" });
    expect(
      parseLockfile("/repo/bun.lockb", Uint8Array.from([1, 2, 3])),
    ).toMatchObject({ format: "bun-binary" });
    expect(
      parseLockfile("/repo/bun.lock", encoder.encode("packages: {}\n")).format,
    ).toBe("bun-text");
    expect(
      parseLockfile("/repo/aube.lock", encoder.encode("packages: {}\n")).format,
    ).toBe("aube");
    expect(
      parseLockfile("/repo/nub.lock", encoder.encode("packages: {}\n")).format,
    ).toBe("nub");
    expect(
      parseLockfile(
        "/repo/uv.lock",
        encoder.encode(
          'version = 1\n\n[[package]]\nname = "python-package"\nversion = "1.2.3"\nsource = { registry = "https://example.test/simple" }\n',
        ),
      ),
    ).toMatchObject({
      format: "uv",
      packages: [{ name: "python-package", version: "1.2.3" }],
    });
    expect(() =>
      parseLockfile("/repo/pnpm-lock.yaml", new Uint8Array([0])),
    ).toThrow(/NUL/);
    expect(
      parseLockfile(
        "/repo/package-lock.json",
        encoder.encode(
          '{"lockfileVersion":3,"dependencies":{"constructor":{"name":"constructor","version":"1.0.0"},"__proto__":{"name":"__proto__","version":"2.0.0","polluted":true}}}',
        ),
      ).packages,
    ).toEqual([
      { name: "__proto__", version: "2.0.0" },
      { name: "constructor", version: "1.0.0" },
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("resolves transitive dependency closures for graph-bearing lockfiles", () => {
    const pnpmCompatible = `lockfileVersion: '9.0'
importers:
  packages/app:
    dependencies:
      a:
        version: 1.0.0
packages:
  a@1.0.0: {}
  b@2.0.0: {}
  c@3.0.0: {}
  unused@4.0.0: {}
snapshots:
  a@1.0.0:
    dependencies:
      b: 2.0.0
  b@2.0.0:
    dependencies:
      c: 3.0.0
  c@3.0.0: {}
  unused@4.0.0: {}
`;
    const cases = [
      {
        path: "/repo/yarn.lock",
        source: `a@^1.0.0:
  version "1.0.0"
  dependencies:
    b "^2.0.0"
b@^2.0.0:
  version "2.0.0"
  dependencies:
    c "^3.0.0"
c@^3.0.0:
  version "3.0.0"
unused@^4.0.0:
  version "4.0.0"
`,
      },
      {
        path: "/repo/yarn.lock",
        source: `__metadata:
  version: 8
"a@npm:^1.0.0":
  version: 1.0.0
  resolution: "a@npm:1.0.0"
  dependencies:
    b: "npm:^2.0.0"
"b@npm:^2.0.0":
  version: 2.0.0
  resolution: "b@npm:2.0.0"
  dependencies:
    c: "npm:^3.0.0"
"c@npm:^3.0.0":
  version: 3.0.0
  resolution: "c@npm:3.0.0"
"unused@npm:^4.0.0":
  version: 4.0.0
  resolution: "unused@npm:4.0.0"
`,
      },
      {
        path: "/repo/Cargo.lock",
        source: `version = 4

[[package]]
name = "a"
version = "1.0.0"
dependencies = ["b 2.0.0"]

[[package]]
name = "b"
version = "2.0.0"
dependencies = ["c 3.0.0"]

[[package]]
name = "c"
version = "3.0.0"

[[package]]
name = "unused"
version = "4.0.0"
`,
      },
      {
        path: "/repo/uv.lock",
        source: `version = 1

[[package]]
name = "a"
version = "1.0.0"
dependencies = [{ name = "b", version = "2.0.0" }]

[[package]]
name = "b"
version = "2.0.0"
dependencies = [{ name = "c" }]

[[package]]
name = "c"
version = "3.0.0"

[[package]]
name = "unused"
version = "4.0.0"
`,
      },
      {
        path: "/repo/bun.lock",
        source: JSON.stringify({
          lockfileVersion: 1,
          workspaces: {
            "packages/app": {
              name: "app",
              version: "1.0.0",
              dependencies: { a: "a@1.0.0" },
            },
          },
          packages: {
            "a@1.0.0": ["a@1.0.0", "", { dependencies: { b: "b@2.0.0" } }, ""],
            "b@2.0.0": ["b@2.0.0", "", { dependencies: { c: "c@3.0.0" } }, ""],
            "c@3.0.0": ["c@3.0.0", "", {}, ""],
            "unused@4.0.0": ["unused@4.0.0", "", {}, ""],
          },
        }),
      },
      { path: "/repo/aube.lock", source: pnpmCompatible },
      { path: "/repo/nub.lock", source: pnpmCompatible },
    ];
    for (const { path, source } of cases) {
      expect(
        resolveLockfilePackageClosure(path, encoder.encode(source), {
          workspacePath: "packages/app",
          packageName: "app",
          directDependencies: [["a", undefined]],
        }).map((dependency) => `${dependency.name}@${dependency.version}`),
      ).toEqual(["a@1.0.0", "b@2.0.0", "c@3.0.0"]);
    }
  });

  it("uses declaring references to disambiguate lockfile graph closures", () => {
    const cases = [
      {
        path: "/repo/yarn.lock",
        source: `a@^1.0.0:
  version "1.0.0"
  dependencies:
    selected "^1.0.0"
a@^2.0.0:
  version "2.0.0"
  dependencies:
    unselected "^2.0.0"
selected@^1.0.0:
  version "1.0.0"
unselected@^2.0.0:
  version "2.0.0"
`,
        context: {
          workspacePath: "packages/app",
          packageName: "app",
          directDependencies: [["a", "^1.0.0"]] as const,
        },
      },
      {
        path: "/repo/yarn.lock",
        source: `__metadata:
  version: 8
"a@npm:^1.0.0":
  version: 1.0.0
  resolution: "a@npm:1.0.0"
  dependencies:
    selected: "npm:^1.0.0"
"a@npm:^2.0.0":
  version: 2.0.0
  resolution: "a@npm:2.0.0"
  dependencies:
    unselected: "npm:^2.0.0"
"selected@npm:^1.0.0":
  version: 1.0.0
  resolution: "selected@npm:1.0.0"
"unselected@npm:^2.0.0":
  version: 2.0.0
  resolution: "unselected@npm:2.0.0"
`,
        context: {
          workspacePath: "packages/app",
          packageName: "app",
          directDependencies: [["a", "^1.0.0"]] as const,
        },
      },
      {
        path: "/repo/Cargo.lock",
        source: `version = 4

[[package]]
name = "app"
version = "0.1.0"
dependencies = ["a 1.0.0"]

[[package]]
name = "a"
version = "1.0.0"
dependencies = ["selected 1.0.0"]

[[package]]
name = "a"
version = "2.0.0"
dependencies = ["unselected 2.0.0"]

[[package]]
name = "selected"
version = "1.0.0"

[[package]]
name = "unselected"
version = "2.0.0"
`,
        context: {
          workspacePath: "packages/app",
          packageName: "app",
          packageVersion: "0.1.0",
          directDependencies: [["a", undefined]] as const,
        },
      },
      {
        path: "/repo/uv.lock",
        source: `version = 1

[[package]]
name = "app"
version = "0.1.0"
source = { editable = "packages/app" }
dependencies = [{ name = "a", version = "1.0.0" }]

[[package]]
name = "a"
version = "1.0.0"
source = { registry = "https://example.test/simple" }
dependencies = [{ name = "selected", version = "1.0.0" }]

[[package]]
name = "a"
version = "2.0.0"
source = { registry = "https://example.test/simple" }
dependencies = [{ name = "unselected", version = "2.0.0" }]

[[package]]
name = "selected"
version = "1.0.0"
source = { registry = "https://example.test/simple" }

[[package]]
name = "unselected"
version = "2.0.0"
source = { registry = "https://example.test/simple" }
`,
        context: {
          workspacePath: "packages/app",
          packageName: "app",
          packageVersion: "0.1.0",
          directDependencies: [["a", undefined]] as const,
        },
      },
    ];
    for (const { path, source, context } of cases) {
      expect(
        resolveLockfilePackageClosure(
          path,
          encoder.encode(source),
          context,
        ).map((dependency) => `${dependency.name}@${dependency.version}`),
      ).toEqual(["a@1.0.0", "selected@1.0.0"]);
    }
  });

  it("accepts the complete core package-manager version matrix", () => {
    const identities = [
      "npm@8.0.0",
      "npm@8.19.4",
      "npm@9.9.4",
      "npm@10.9.9",
      "npm@11.19.1",
      "npm@12.0.2",
      "pnpm@8.0.0",
      "pnpm@8.15.9",
      "pnpm@9.15.9",
      "pnpm@10.34.5",
      "pnpm@11.25.0",
      "pnpm@12.1.0",
      "yarn@1.0.0",
      "yarn@1.22.22",
      "yarn@2.4.2",
      "yarn@3.8.7",
      "yarn@4.18.0",
      "bun@1.2.0",
      "bun@1.4.0",
      "aube@2.2.0",
      "nub@0.1.0",
      "cargo@1.97.1",
      "uv@0.12.7",
    ];
    for (const identity of identities) {
      const [name, version] = identity.split("@");
      expect(managerFromIdentity(identity)).toEqual({ name, version });
    }
    expect(managerFromIdentity("pnpmn@10")).toBeUndefined();
  });

  it("retains repository manager controls and absent lockfiles as task inputs", () => {
    const cases = [
      {
        manager: "npm" as const,
        names: [
          "package.json",
          ".npmrc",
          "package-lock.json",
          "npm-shrinkwrap.json",
        ],
      },
      {
        manager: "pnpm" as const,
        names: [
          "package.json",
          ".npmrc",
          "pnpm-workspace.yaml",
          ".pnpmfile.cjs",
          "pnpm-lock.yaml",
        ],
      },
      {
        manager: "yarn" as const,
        names: [
          "package.json",
          ".npmrc",
          ".yarnrc",
          ".yarnrc.yml",
          "yarn.lock",
          ".pnp.cjs",
        ],
      },
      {
        manager: "bun" as const,
        names: [
          "package.json",
          ".npmrc",
          "bunfig.toml",
          "packages/app/bunfig.toml",
          "bun.lock",
          "bun.lockb",
        ],
      },
      {
        manager: "aube" as const,
        names: [
          "package.json",
          ".npmrc",
          "aube-workspace.yaml",
          ".config/aube/config.toml",
          "aube.lock",
          "package-lock.json",
          "pnpm-lock.yaml",
          "yarn.lock",
          "bun.lock",
        ],
      },
      {
        manager: "nub" as const,
        names: [
          "package.json",
          ".npmrc",
          "nub.jsonc",
          "nub.lock",
          "package-lock.json",
          "pnpm-lock.yaml",
          "yarn.lock",
          "bun.lock",
        ],
      },
    ];
    for (const { manager, names } of cases) {
      const packageValue = { ...packageModel("app", []), manager };
      const model = { ...repository([packageValue]), manager };
      const node: TaskNode = {
        id: "app#build",
        package: packageValue,
        task: "build",
        command: "build",
        definition: {},
        dependencies: [],
        with: [],
      };
      const candidates = implicitTaskInputCandidates(model, node).map((path) =>
        relativePath(model.root, path),
      );
      expect(candidates).toEqual(expect.arrayContaining(names));
    }
  });

  it("resolves run option environment names case-insensitively on Windows", () => {
    const model = repository([]);
    const parsed = parseRunArguments(["run", "build"]);
    const environment = {
      turbo_cache: "local:rw,remote:rw",
      turbo_remote_only: "1",
      turbo_remote_cache_read_only: "1",
      turbo_concurrency: "2",
      turbo_env_mode: "loose",
      turbo_cache_dir: ".cache",
      turbo_api: "https://cache.example.test/api",
      turbo_token: "token",
      turbo_remote_cache_signature_key: "signature",
      turbo_remote_cache_timeout: "4",
      turbo_remote_cache_upload_timeout: "5",
      turbo_teamid: "team-id",
      turbo_team: "team-slug",
      turbo_force: "true",
      no_color: "1",
    };
    const options = resolveOptions(
      parsed,
      model.root,
      environment,
      model.rootConfiguration,
      8,
      true,
    );
    expect(options).toMatchObject({
      concurrency: 2,
      environmentMode: "loose",
      cacheDirectory: "/repo/.cache",
      cachePolicy: {
        localRead: false,
        localWrite: false,
        remoteRead: true,
        remoteWrite: false,
      },
      force: true,
      colorEnabled: false,
      remote: {
        apiUrl: "https://cache.example.test/api",
        token: "token",
        teamId: "team-id",
        teamSlug: "team-slug",
        timeoutMilliseconds: 4_000,
        uploadTimeoutMilliseconds: 5_000,
        signatureKey: "signature",
      },
    });
    expect(
      resolveOptions(
        parsed,
        model.root,
        environment,
        model.rootConfiguration,
        8,
      ),
    ).toMatchObject({
      cacheDirectory: "/repo/.turbo/cache",
      force: false,
      colorEnabled: true,
      remote: undefined,
    });
  });

  it("builds dependency graphs, filters closures, and rejects cycles", () => {
    const library = packageModel("library", []);
    const app = packageModel("app", ["library"], { dependsOn: ["^build"] });
    const model = repository([app, library]);
    expect(
      selectPackages(model, ["app..."]).map((entry) => entry.name),
    ).toEqual(["app", "library"]);
    expect(
      selectPackages(model, ["!library"]).map((entry) => entry.name),
    ).toEqual(["app"]);
    expect(
      selectPackages(model, ["!app", "*"]).map((entry) => entry.name),
    ).toEqual(["library"]);
    const ranges = new Map<string, ReadonlySet<string>>([
      ["main", new Set(["app", "library"])],
      ["app-only", new Set(["app"])],
    ]);
    expect(
      selectPackages(model, ["{./packages/app}[main]"], ranges).map(
        (entry) => entry.name,
      ),
    ).toEqual(["app"]);
    expect(
      selectPackages(model, ["library{./packages/app}[main]"], ranges),
    ).toEqual([]);
    expect(
      selectPackages(model, ["app...[app-only]"], ranges).map(
        (entry) => entry.name,
      ),
    ).toEqual(["app", "library"]);
    const base = packageModel("base", []);
    const target = packageModel("target", ["base"]);
    const sibling = packageModel("sibling", ["base"]);
    const bidirectional = repository([base, target, sibling]);
    expect(
      selectPackages(bidirectional, ["...target..."]).map(
        (entry) => entry.name,
      ),
    ).toEqual(["base", "target"]);
    expect(
      selectPackages(bidirectional, ["!...target..."]).map(
        (entry) => entry.name,
      ),
    ).toEqual(["sibling"]);
    const graph = buildTaskGraph(model, [app], ["build"], false);
    expect(topologicalOrder(graph)).toEqual(["library#build", "app#build"]);

    const cyclicLibrary = packageModel("library", ["app"], {
      dependsOn: ["^build"],
    });
    const cyclic = repository([app, cyclicLibrary]);
    expect(() => buildTaskGraph(cyclic, [app], ["build"], false)).toThrow(
      GraphError,
    );
  });

  it("prefers package-qualified task definitions", () => {
    const library = packageModel("library", []);
    const app = {
      ...packageModel("app", ["library"]),
      tasks: {
        build: { cache: true },
        "app#build": { cache: false, dependsOn: ["library#build"] },
      },
    } satisfies RepositoryPackage;
    const graph = buildTaskGraph(
      repository([app, library]),
      [app],
      ["build"],
      false,
    );
    expect(graph.nodes.get("app#build")?.definition).toMatchObject({
      cache: false,
      dependsOn: ["library#build"],
    });
    expect(graph.nodes.get("app#build")?.dependencies).toEqual([
      "library#build",
    ]);
  });

  it("resolves renamed Cargo dependencies from metadata", () => {
    expect(
      parseCargoMetadata(
        JSON.stringify({
          workspace_root: "/repo",
          packages: [
            {
              name: "app",
              version: "0.1.0",
              manifest_path: "/repo/crates/app/Cargo.toml",
              dependencies: [{ name: "util", rename: "util_alias" }],
              targets: [
                { kind: ["bin"], name: "app" },
                { kind: ["custom-build"], name: "build-script-build" },
              ],
            },
          ],
          target_directory: "/repo/target",
        }),
        "/repo/crates/app/Cargo.toml",
      ),
    ).toEqual({
      name: "app",
      version: "0.1.0",
      dependencies: [{ name: "util" }],
      dependencyNames: ["util"],
      entrypointNames: ["app"],
      hasLibraryTarget: false,
      targetDirectory: "/repo/target",
      workspaceDirectory: "/repo",
    });
  });

  it("identifies mixed Cargo library and binary metadata", () => {
    expect(
      parseCargoMetadata(
        JSON.stringify({
          packages: [
            {
              name: "mixed",
              manifest_path: "/repo/mixed/Cargo.toml",
              targets: [
                { kind: ["lib"], name: "mixed" },
                { kind: ["bin"], name: "mixed-cli" },
              ],
            },
          ],
        }),
        "/repo/mixed/Cargo.toml",
      ),
    ).toMatchObject({
      entrypointNames: ["mixed-cli"],
      hasLibraryTarget: true,
    });
  });

  it("rejects unresolved with companions", () => {
    const missingLocal = {
      ...packageModel("app", []),
      tasks: { build: { with: ["serve"] } },
    } satisfies RepositoryPackage;
    expect(() =>
      buildTaskGraph(
        repository([missingLocal]),
        [missingLocal],
        ["build"],
        false,
      ),
    ).toThrow(/cannot resolve with task serve/);

    const missingPackage = {
      ...packageModel("app", []),
      tasks: { build: { with: ["missing#dev"] } },
    } satisfies RepositoryPackage;
    expect(() =>
      buildTaskGraph(
        repository([missingPackage]),
        [missingPackage],
        ["build"],
        false,
      ),
    ).toThrow(/cannot resolve with task missing#dev/);

    const library = packageModel("library", []);
    const missingTask = {
      ...packageModel("app", []),
      tasks: { build: { with: ["library#serve"] } },
    } satisfies RepositoryPackage;
    expect(() =>
      buildTaskGraph(
        repository([missingTask, library]),
        [missingTask],
        ["build"],
        false,
      ),
    ).toThrow(/cannot resolve with task library#serve/);
  });

  it("models root task entrypoints and dependencies in the //# namespace", () => {
    const app = packageModel("app", [], { dependsOn: ["//#build"] });
    const model = repository([app]);
    expect(
      buildTaskGraph(model, [app], ["//#build"], false).entrypoints,
    ).toEqual(["//#build"]);
    expect(
      topologicalOrder(buildTaskGraph(model, [app], ["build"], false)),
    ).toEqual(["//#build", "app#build"]);
  });

  it("rejects dependencies on persistent tasks", () => {
    const app = packageModel("app", [], { dependsOn: ["dev"] });
    expect(() =>
      buildTaskGraph(repository([app]), [app], ["build"], false),
    ).toThrow(/persistent/);
  });

  it("keeps persistent task scopes uncacheable", () => {
    const app = packageModel("app", []);
    const node = buildTaskGraph(
      repository([app]),
      [app],
      ["dev"],
      false,
    ).nodes.get("app#dev")!;
    expect(isTaskScopeCacheable(node, [])).toBe(false);
    expect(
      isTaskScopeCacheable(
        { ...node, definition: { ...node.definition, cache: true } },
        [],
      ),
    ).toBe(false);
  });

  it("preserves transit tasks and applies strict entrypoint selection", () => {
    const transit = {
      ...packageModel("transit", []),
      scripts: { build: 'node -e "process.exit(0)"' },
      tasks: { build: {}, test: { dependsOn: ["build"] } },
    } satisfies RepositoryPackage;
    const executable = {
      ...packageModel("executable", []),
      scripts: {
        build: 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
      },
      tasks: { build: {}, test: { dependsOn: ["build"] } },
    } satisfies RepositoryPackage;
    const model = repository([transit, executable]);
    const defaultGraph = buildTaskGraph(model, model.packages, ["test"], false);
    expect(defaultGraph.entrypoints).toEqual([
      "executable#test",
      "transit#test",
    ]);
    expect(defaultGraph.nodes.get("transit#test")?.command).toBeUndefined();
    const strictGraph = buildTaskGraph(
      model,
      model.packages,
      ["test"],
      false,
      true,
    );
    expect(strictGraph.entrypoints).toEqual(["executable#test"]);
    expect(strictGraph.nodes.has("transit#test")).toBe(false);
    const allCommandlessStrictGraph = buildTaskGraph(
      model,
      [transit],
      ["test"],
      false,
      true,
    );
    expect(allCommandlessStrictGraph.entrypoints).toEqual([]);
    expect(allCommandlessStrictGraph.nodes.size).toBe(0);
    expect(
      buildTaskGraph(model, model.packages, ["missing"], false).entrypoints,
    ).toEqual([]);
  });

  it("selects strict environments with wildcard negation", () => {
    expect(
      selectEnvironment(
        {
          PATH: "/bin",
          PUBLIC_VALUE: "yes",
          PUBLIC_SECRET: "no",
          SECRET: "hidden",
        },
        ["PATH", "PUBLIC_*", "!PUBLIC_SECRET"],
      ),
    ).toEqual({ PATH: "/bin", PUBLIC_VALUE: "yes" });
  });

  it("matches environment names case-insensitively only when requested", () => {
    const environment = {
      Path: "C:/Windows/System32",
      SystemRoot: "C:/Windows",
    };
    expect(selectEnvironment(environment, ["PATH", "SYSTEMROOT"])).toEqual({});
    expect(
      selectEnvironment(environment, ["PATH", "SYSTEMROOT"], true),
    ).toEqual({ Path: "C:/Windows/System32", SystemRoot: "C:/Windows" });
  });

  it("orders canonical object and environment keys by code unit", () => {
    expect(canonicalStringify({ äValue: "unicode", zValue: "ascii" })).toBe(
      '{"zValue":"ascii","äValue":"unicode"}',
    );
    expect(
      Object.keys(
        selectEnvironment({ ä_VALUE: "unicode", Z_VALUE: "ascii" }, [
          "*_VALUE",
        ]),
      ),
    ).toEqual(["Z_VALUE", "ä_VALUE"]);
  });

  it("preserves pass-through arguments as literal argv values", () => {
    const parsed = parseRunArguments([
      "run",
      "build",
      "--filter=app",
      "--",
      "$(touch /tmp/not-executed)",
      "; echo injected",
    ]);
    expect(parsed.tasks).toEqual(["build"]);
    expect(parsed.filters).toEqual(["app"]);
    expect(parsed.passThroughArguments).toEqual([
      "$(touch /tmp/not-executed)",
      "; echo injected",
    ]);
  });

  it("validates values for ignored value-taking run options", () => {
    expect(() =>
      parseRunArguments(["run", "build", "--ui", "--no-cache"]),
    ).toThrow(/--ui requires a value/);
    expect(() =>
      parseRunArguments(["run", "build", "--verbosity", "--no-cache"]),
    ).toThrow(/--verbosity requires a value/);
    expect(
      parseRunArguments([
        "run",
        "build",
        "--ui",
        "stream",
        "--verbosity=2",
        "--no-cache",
      ]).noCache,
    ).toBe(true);
  });

  it("rejects blank remote cache timeout arguments", () => {
    for (const value of ["", "   "]) {
      expect(() =>
        parseRunArguments(["run", "build", `--remote-cache-timeout=${value}`]),
      ).toThrow(/invalid remote cache timeout/);
    }
    expect(
      parseRunArguments(["run", "build", "--remote-cache-timeout=0"])
        .remoteCacheTimeoutSeconds,
    ).toBe(0);
  });

  it("uses available parallelism and preserves Cargo pass-through arguments", () => {
    expect(parseConcurrency("50%", 8)).toBe(4);
    expect(parseConcurrency("100%", 1)).toBe(1);
    const packageModel = {
      identity: "app",
      name: "app",
      directory: "/repo/crates/app",
      relativeDirectory: "crates/app",
      canonicalRelativeDirectory: "crates/app",
      cachePathRestorable: true,
      cacheInputsComplete: true,
      manager: "cargo" as const,
      scripts: { dev: "cargo run" },
      dependencyNames: [],
      internalDependencies: [],
      excludedTasks: new Set<string>(),
      tasks: { dev: {} },
      manifest: { name: "app" },
    };
    const node: TaskNode = {
      id: "app#dev",
      package: packageModel,
      task: "dev",
      command: "cargo run",
      definition: {},
      dependencies: [],
      with: [],
    };
    expect(packageManagerCommand(node, [])).toEqual({
      command: "cargo",
      arguments: ["run", "--package=app", "--locked"],
      cwd: "/repo/crates/app",
    });
    expect(packageManagerCommand(node, ["--release"])).toEqual({
      command: "cargo",
      arguments: ["run", "--package=app", "--locked", "--release"],
      cwd: "/repo/crates/app",
    });
    expect(packageManagerCommand(node, ["--", "--example=demo"])).toEqual({
      command: "cargo",
      arguments: ["run", "--package=app", "--locked", "--", "--example=demo"],
      cwd: "/repo/crates/app",
    });
    expect(
      packageManagerCommand(
        { ...node, id: "app#test", task: "test", command: "cargo test" },
        ["--features=integration"],
      ),
    ).toEqual({
      command: "cargo",
      arguments: [
        "test",
        "--package=app",
        "--locked",
        "--features=integration",
      ],
      cwd: "/repo/crates/app",
    });
  });

  it("parses cache provider modes and rejects malformed specifications", () => {
    expect(parseCacheSpecification("local:rw,remote:r")).toEqual({
      localRead: true,
      localWrite: true,
      remoteRead: true,
      remoteWrite: false,
    });
    expect(parseCacheSpecification("remote:w")).toEqual({
      localRead: false,
      localWrite: false,
      remoteRead: false,
      remoteWrite: true,
    });
    expect(() => parseCacheSpecification("local:read")).toThrow(
      /invalid cache specification/,
    );
    expect(() => parseCacheSpecification("local:rw;remote:rw")).toThrow(
      /invalid cache specification/,
    );
  });

  it("plans complete Cargo workspaces without broadening task exclusions", () => {
    const cargoPackage = (name: string): RepositoryPackage => ({
      ...packageModel(name, []),
      directory: `/repo/crates/${name}`,
      relativeDirectory: `crates/${name}`,
      workspaceDirectory: "/repo",
      manager: "cargo",
      scripts: { format: "cargo fmt", test: "cargo test" },
      tasks: { format: {}, test: {} },
    });
    const app = cargoPackage("app");
    const library = {
      ...cargoPackage("library"),
      tasks: { format: {}, test: { cache: false } },
    };
    const model = repository([app, library]);
    const graph = buildTaskGraph(model, model.packages, ["test"], false);
    const workspacePlan = planCargoWorkspaceTasks(model, graph, ["test"], true);
    expect(workspacePlan.graph.entrypoints).toEqual(["app#test"]);
    const workspaceNode = workspacePlan.graph.nodes.get("app#test")!;
    const workspaceScope = workspacePlan.scopes.get("app#test")!;
    expect(packageManagerCommand(workspaceNode, [], workspaceScope)).toEqual({
      command: "cargo",
      arguments: ["test", "--workspace", "--locked"],
      cwd: "/repo",
    });
    expect(isTaskScopeCacheable(workspaceNode, [], workspaceScope)).toBe(false);

    for (const definition of [
      { cache: false, interactive: true },
      { outputLogs: "errors-only" as const },
      { cache: false, persistent: true },
    ]) {
      const incompatibleLibrary = {
        ...library,
        tasks: { format: {}, test: definition },
      };
      const incompatibleModel = repository([app, incompatibleLibrary]);
      const incompatibleGraph = buildTaskGraph(
        incompatibleModel,
        incompatibleModel.packages,
        ["test"],
        false,
      );
      const incompatiblePlan = planCargoWorkspaceTasks(
        incompatibleModel,
        incompatibleGraph,
        ["test"],
        true,
      );
      expect(incompatiblePlan.graph.entrypoints).toEqual([
        "app#test",
        "library#test",
      ]);
      expect(incompatiblePlan.scopes.size).toBe(0);
    }

    if (workspaceScope.kind !== "cargo-workspace") {
      throw new Error("expected a Cargo workspace scope");
    }
    const environmentScope = {
      ...workspaceScope,
      members: [
        {
          ...workspaceScope.members[0]!,
          definition: { env: ["APP_ENV"] },
        },
        {
          ...workspaceScope.members[1]!,
          definition: { passThroughEnv: ["LIBRARY_ENV"] },
        },
      ],
    } satisfies typeof workspaceScope;
    expect(
      taskScopeEnvironment(
        model,
        workspaceNode,
        {
          APP_ENV: "app",
          LIBRARY_ENV: "library",
          UNSELECTED_ENV: "hidden",
        },
        "strict",
        false,
        environmentScope,
      ),
    ).toEqual({ APP_ENV: "app", LIBRARY_ENV: "library" });

    const formatGraph = buildTaskGraph(
      model,
      model.packages,
      ["format"],
      false,
    );
    const formatPlan = planCargoWorkspaceTasks(
      model,
      formatGraph,
      ["format"],
      true,
    );
    const formatNode = formatPlan.graph.nodes.get("app#format")!;
    expect(
      packageManagerCommand(
        formatNode,
        [],
        formatPlan.scopes.get("app#format")!,
      ),
    ).toEqual({ command: "cargo", arguments: ["fmt", "--all"], cwd: "/repo" });

    const filteredPlan = planCargoWorkspaceTasks(model, graph, ["test"], false);
    expect(filteredPlan.graph.entrypoints).toEqual([
      "app#test",
      "library#test",
    ]);
    expect(filteredPlan.scopes.size).toBe(0);
    expect(packageManagerCommand(graph.nodes.get("app#test")!, [])).toEqual({
      command: "cargo",
      arguments: ["test", "--package=app", "--locked"],
      cwd: "/repo/crates/app",
    });
    expect(
      cargoWorkspaceHash([
        ["app#test", "aaaa"],
        ["library#test", "bbbb"],
      ]),
    ).not.toBe(
      cargoWorkspaceHash([
        ["app#test", "aaaa"],
        ["library#test", "cccc"],
      ]),
    );
    expect(
      cargoWorkspaceHash([
        ["ä#test", "aaaa"],
        ["z#test", "bbbb"],
      ]),
    ).toBe(
      xxhash64Hex(
        JSON.stringify({
          scope: "cargo-workspace",
          members: [
            ["z#test", "bbbb"],
            ["ä#test", "aaaa"],
          ],
        }),
      ),
    );

    const excludedModel = repository([
      app,
      {
        ...library,
        excludedTasks: new Set(["test"]),
        tasks: { format: {} },
      },
    ]);
    const partialGraph = buildTaskGraph(
      excludedModel,
      excludedModel.packages,
      ["test"],
      false,
    );
    const partialPlan = planCargoWorkspaceTasks(
      excludedModel,
      partialGraph,
      ["test"],
      true,
    );
    expect(partialPlan.graph.entrypoints).toEqual(["app#test"]);
    expect(partialPlan.scopes.size).toBe(0);
    expect(
      packageManagerCommand(partialGraph.nodes.get("app#test")!, []),
    ).toEqual({
      command: "cargo",
      arguments: ["test", "--package=app", "--locked"],
      cwd: "/repo/crates/app",
    });
  });

  it("runs uv commands from the discovered project directory", () => {
    const uvPackage = {
      ...packageModel("python-app", []),
      directory: "/repo/python/app",
      relativeDirectory: "python/app",
      manager: "uv" as const,
      scripts: { test: "uv run --frozen pytest" },
      tasks: { test: {} },
    } satisfies RepositoryPackage;
    const graph = buildTaskGraph(
      repository([uvPackage]),
      [uvPackage],
      ["test"],
      false,
    );
    expect(
      packageManagerCommand(graph.nodes.get("python-app#test")!, []),
    ).toEqual({
      command: "uv",
      arguments: ["run", "--frozen", "--package", "python-app", "pytest"],
      cwd: "/repo/python/app",
    });
    expect(
      packageManagerCommand(graph.nodes.get("python-app#test")!, [
        "tests/unit",
      ]),
    ).toEqual({
      command: "uv",
      arguments: [
        "run",
        "--frozen",
        "--package",
        "python-app",
        "pytest",
        "tests/unit",
      ],
      cwd: "/repo/python/app",
    });
  });

  it("disables uv build caching for alternate output directories", () => {
    const uvPackage = {
      ...packageModel("python-app", []),
      directory: "/repo/python/app",
      relativeDirectory: "python/app",
      manager: "uv" as const,
      scripts: { build: "uv build" },
      tasks: { build: { cache: true, outputs: ["dist/**"] } },
    } satisfies RepositoryPackage;
    const node = buildTaskGraph(
      repository([uvPackage]),
      [uvPackage],
      ["build"],
      false,
    ).nodes.get("python-app#build")!;
    expect(isTaskScopeCacheable(node, [])).toBe(true);
    expect(isTaskScopeCacheable(node, ["-o", "wheelhouse"])).toBe(false);
    expect(isTaskScopeCacheable(node, ["-owheelhouse"])).toBe(false);
    expect(isTaskScopeCacheable(node, ["--out-dir", "wheelhouse"])).toBe(false);
    expect(isTaskScopeCacheable(node, ["--out-dir=wheelhouse"])).toBe(false);
    expect(isTaskScopeCacheable(node, ["--project", "../alternate"])).toBe(
      false,
    );
    expect(isTaskScopeCacheable(node, ["--project=../alternate"])).toBe(false);
    expect(isTaskScopeCacheable(node, ["--directory", "../alternate"])).toBe(
      false,
    );
    expect(isTaskScopeCacheable(node, ["--directory=../alternate"])).toBe(
      false,
    );
    expect(
      isTaskScopeCacheable(
        node,
        [],
        { kind: "package" },
        {},
        false,
        {},
        false,
        false,
        false,
        false,
      ),
    ).toBe(false);
  });

  it("disables uv build caching for explicit configuration files", () => {
    const uvPackage = {
      ...packageModel("python-app", []),
      directory: "/repo/python/app",
      relativeDirectory: "python/app",
      manager: "uv" as const,
      scripts: { build: "uv build" },
      tasks: { build: { cache: true, outputs: ["dist/**"] } },
    } satisfies RepositoryPackage;
    const node = buildTaskGraph(
      repository([uvPackage]),
      [uvPackage],
      ["build"],
      false,
    ).nodes.get("python-app#build")!;
    expect(isTaskScopeCacheable(node, [])).toBe(true);
    expect(
      isTaskScopeCacheable(node, ["--config-file", "alternate-uv.toml"]),
    ).toBe(false);
    expect(
      isTaskScopeCacheable(node, ["--config-file=alternate-uv.toml"]),
    ).toBe(false);
  });

  it("disables Cargo build caching for unmodeled target selectors", () => {
    const cargoPackage: RepositoryPackage = {
      ...packageModel("app", []),
      manager: "cargo",
      scripts: { build: "cargo build" },
      tasks: { build: {} },
    };
    const node: TaskNode = {
      id: "app#build",
      package: cargoPackage,
      task: "build",
      command: "cargo build",
      definition: {},
      dependencies: [],
      with: [],
    };
    for (const arguments_ of [
      ["-p", "helper"],
      ["-phelper"],
      ["--package", "helper"],
      ["--package=helper"],
      ["--lib"],
      ["--bin", "tool"],
      ["--bins"],
      ["--example=demo"],
      ["--examples"],
      ["--test", "integration"],
      ["--tests"],
      ["--bench=throughput"],
      ["--benches"],
      ["--workspace"],
      ["--all"],
      ["--all-targets"],
      ["--manifest-path", "../alternate/Cargo.toml"],
      ["--manifest-path=../alternate/Cargo.toml"],
    ]) {
      expect(isTaskScopeCacheable(node, arguments_)).toBe(false);
    }
    for (const task of ["build", "check", "dev", "lint", "run", "test"]) {
      const compilationNode = {
        ...node,
        id: `app#${task}`,
        task,
        command: `cargo ${task}`,
      };
      for (const arguments_ of [
        ["--release"],
        ["-r"],
        ["--manifest-path", "../alternate/Cargo.toml"],
        ["--manifest-path=../alternate/Cargo.toml"],
        ["--profile", "release"],
        ["--target=synthetic-target"],
        ["--target-dir", "../alternate-target"],
        ["--timings"],
        ["--timings=html"],
      ]) {
        expect(isTaskScopeCacheable(compilationNode, arguments_)).toBe(false);
      }
      expect(
        isTaskScopeCacheable(compilationNode, [
          "--config",
          "../external-cargo.toml",
        ]),
      ).toBe(false);
      expect(
        isTaskScopeCacheable(compilationNode, [
          "--config=../external-cargo.toml",
        ]),
      ).toBe(false);
      expect(
        isTaskScopeCacheable(
          compilationNode,
          [],
          { kind: "package" },
          { CARGO_BUILD_TARGET: "synthetic-target" },
        ),
      ).toBe(false);
      expect(
        isTaskScopeCacheable(
          compilationNode,
          [],
          { kind: "package" },
          { cargo_build_target: "synthetic-target" },
          true,
        ),
      ).toBe(false);
      expect(
        isTaskScopeCacheable(
          compilationNode,
          [],
          { kind: "package" },
          {},
          false,
          { CARGO_TARGET_DIR: "/repo/custom-target" },
        ),
      ).toBe(false);
      for (const name of [
        "RUSTC",
        "RUSTC_WRAPPER",
        "RUSTC_WORKSPACE_WRAPPER",
      ]) {
        expect(
          isTaskScopeCacheable(
            compilationNode,
            [],
            { kind: "package" },
            { [name]: "/toolchains/custom-tool" },
          ),
        ).toBe(false);
      }
    }
    expect(
      isTaskScopeCacheable(node, [], { kind: "package" }, {}, false, {
        CARGO_TARGET_DIR: "/repo/custom-target",
      }),
    ).toBe(false);
    expect(
      isTaskScopeCacheable(
        node,
        [],
        { kind: "package" },
        { CARGO_TARGET_DIR: "/repo/custom-target" },
        false,
        { CARGO_TARGET_DIR: "/repo/custom-target" },
      ),
    ).toBe(true);
    expect(
      isTaskScopeCacheable(node, [], { kind: "package" }, {}, false, {}, true),
    ).toBe(false);
    expect(isTaskScopeCacheable(node, ["--features=integration"])).toBe(true);
    expect(
      isTaskScopeCacheable(
        node,
        [],
        { kind: "package" },
        { rustc_workspace_wrapper: "C:/toolchains/custom-wrapper.exe" },
        true,
      ),
    ).toBe(false);
  });

  it("disables npm and pnpm caching when user configuration is present", () => {
    for (const manager of ["npm", "pnpm"] as const) {
      const packageValue = {
        ...packageModel("app", []),
        manager,
      };
      const node: TaskNode = {
        id: "app#build",
        package: packageValue,
        task: "build",
        command: packageValue.scripts.build,
        definition: packageValue.tasks.build!,
        dependencies: [],
        with: [],
      };
      expect(isTaskScopeCacheable(node, [])).toBe(true);
      expect(
        isTaskScopeCacheable(
          node,
          [],
          { kind: "package" },
          {},
          false,
          {},
          false,
          true,
        ),
      ).toBe(false);
    }
  });

  it("requires verified JavaScript package-manager runtime identities", () => {
    for (const manager of [
      "npm",
      "pnpm",
      "yarn",
      "bun",
      "aube",
      "nub",
    ] as const) {
      const packageValue = {
        ...packageModel("app", []),
        manager,
      };
      const node: TaskNode = {
        id: "app#build",
        package: packageValue,
        task: "build",
        command: packageValue.scripts.build,
        definition: packageValue.tasks.build!,
        dependencies: [],
        with: [],
      };
      expect(
        isTaskScopeCacheable(
          node,
          [],
          { kind: "package" },
          {},
          false,
          {},
          false,
          false,
          false,
          true,
          false,
        ),
      ).toBe(false);
    }
  });

  it("propagates unrestorable workspace inputs through hash edges", () => {
    const unrestorablePackage: RepositoryPackage = {
      ...packageModel("linked", []),
      cachePathRestorable: false,
    };
    const node = (
      packageModelValue: RepositoryPackage,
      dependencies: ReadonlyArray<string> = [],
      withTasks: ReadonlyArray<string> = [],
    ): TaskNode => ({
      id: `${packageModelValue.name}#build`,
      package: packageModelValue,
      task: "build",
      command: packageModelValue.scripts.build,
      definition: packageModelValue.tasks.build!,
      dependencies,
      with: withTasks,
    });
    const linked = node(unrestorablePackage);
    const incomplete = node({
      ...packageModel("incomplete", []),
      cacheInputsComplete: false,
    });
    const dependent = node(packageModel("dependent", ["linked"]), [linked.id]);
    const incompleteDependent = node(
      packageModel("incomplete-dependent", ["incomplete"]),
      [incomplete.id],
    );
    const companionOwner = node(packageModel("owner", []), [], [linked.id]);
    const runtimeBypassed = node(packageModel("runtime-bypassed", []));
    const runtimeDependent = node(
      packageModel("runtime-dependent", ["runtime-bypassed"]),
      [runtimeBypassed.id],
    );
    const unrelated = node(packageModel("unrelated", []));
    const graph: TaskGraph = {
      nodes: new Map(
        [
          linked,
          incomplete,
          dependent,
          incompleteDependent,
          companionOwner,
          runtimeBypassed,
          runtimeDependent,
          unrelated,
        ].map((task) => [task.id, task]),
      ),
      entrypoints: [
        dependent.id,
        incompleteDependent.id,
        companionOwner.id,
        runtimeDependent.id,
        unrelated.id,
      ],
    };
    expect(
      [
        ...taskIdsWithUnrestorableCacheInputs(
          graph,
          new Map(),
          new Set([runtimeBypassed.id]),
        ),
      ].sort(),
    ).toEqual(
      [
        companionOwner.id,
        dependent.id,
        incomplete.id,
        incompleteDependent.id,
        linked.id,
        runtimeBypassed.id,
        runtimeDependent.id,
      ].sort(),
    );
  });

  it("rejects unknown output log modes", () => {
    expect(() =>
      parseRunArguments(["run", "build", "--output-logs=unexpected"]),
    ).toThrow(/invalid output log mode/);
  });
});

describe("cache archive safety", () => {
  it("rejects excessive tar metadata overhead before constructing chunks", () => {
    const entry = {
      kind: "directory" as const,
      path: "packages/app/dist/empty",
      mode: 0o755,
      modifiedSeconds: 1,
    };
    const entries = new Array(
      maximumCacheArchiveOverheadBytes / tarBlockSize,
    ).fill(entry) as ReadonlyArray<typeof entry>;
    expect(() => createTarArchive(entries)).toThrow(
      /cache archive overhead exceeds/,
    );
  });

  it("round trips deterministic archives", () => {
    const entries = [
      {
        path: "packages/app/dist/a.txt",
        contents: encoder.encode("a"),
        mode: 0o644,
        modifiedSeconds: 1,
      },
      {
        path: "packages/app/.turbo/turbo-build.log",
        contents: encoder.encode("log"),
        mode: 0o600,
        modifiedSeconds: 2,
      },
    ];
    expect(parseTarArchive(createTarArchive(entries))).toEqual(
      entries.sort((left, right) => left.path.localeCompare(right.path)),
    );
  });

  it("round trips safe symlink entries and rejects escaping targets", () => {
    const entry = {
      kind: "symlink" as const,
      path: "packages/app/dist/current.txt",
      linkTarget: "value.txt",
      contents: new Uint8Array(),
      mode: 0o777,
      modifiedSeconds: 2,
    };
    expect(parseTarArchive(createTarArchive([entry]))).toEqual([entry]);
    expect(() =>
      createTarArchive([{ ...entry, linkTarget: "../../../../outside" }]),
    ).toThrow(/escapes repository/);
  });

  it("preserves POSIX backslashes and normalizes Windows archive inputs", () => {
    const file = {
      path: "packages/app/dist/output\\artifact.txt",
      contents: encoder.encode("literal backslash"),
      mode: 0o644,
      modifiedSeconds: 2,
    };
    const symlink = {
      kind: "symlink" as const,
      path: "packages/app/dist/current",
      linkTarget: "output\\artifact.txt",
      contents: new Uint8Array(),
      mode: 0o777,
      modifiedSeconds: 3,
    };
    expect(parseTarArchive(createTarArchive([file, symlink]))).toEqual([
      symlink,
      file,
    ]);
    expect(parseTarArchive(createTarArchive([file, symlink], true))).toEqual([
      { ...symlink, linkTarget: "output/artifact.txt" },
      { ...file, path: "packages/app/dist/output/artifact.txt" },
    ]);
  });

  it("round trips empty directory entries", () => {
    const entry = {
      kind: "directory" as const,
      path: "packages/app/dist",
      mode: 0o755,
      modifiedSeconds: 2,
    };
    expect(parseTarArchive(createTarArchive([entry]))).toEqual([entry]);
  });

  it("round trips ustar paths longer than the name field", () => {
    const path = `packages/app/${"nested-segment/".repeat(7)}dist/output.txt`;
    expect(new TextEncoder().encode(path).length).toBeGreaterThan(100);
    const entry = {
      path,
      contents: encoder.encode("long path"),
      mode: 0o644,
      modifiedSeconds: 3,
    };
    expect(parseTarArchive(createTarArchive([entry]))).toEqual([entry]);
  });

  it("round trips PAX paths and link targets beyond ustar limits", () => {
    const longName = `${"generated-output-".repeat(8)}artifact.txt`;
    const file = {
      path: `packages/app/dist/${longName}`,
      contents: encoder.encode("PAX path"),
      mode: 0o644,
      modifiedSeconds: 4,
    };
    const symlink = {
      kind: "symlink" as const,
      path: "packages/app/dist/current.txt",
      linkTarget: `${"nested/".repeat(18)}artifact.txt`,
      contents: new Uint8Array(),
      mode: 0o777,
      modifiedSeconds: 5,
    };
    expect(new TextEncoder().encode(longName).length).toBeGreaterThan(100);
    expect(new TextEncoder().encode(symlink.linkTarget).length).toBeGreaterThan(
      100,
    );
    expect(parseTarArchive(createTarArchive([file, symlink]))).toEqual([
      symlink,
      file,
    ]);
  });

  it("rejects non-octal bytes around tar numeric terminators", () => {
    const archive = createTarArchive([
      {
        path: "packages/app/dist/output.txt",
        contents: encoder.encode("output"),
        mode: 0o644,
        modifiedSeconds: 1,
      },
    ]);
    for (const [offset, length] of [
      [100, 8],
      [124, 12],
    ] as const) {
      const invalid = archive.slice();
      invalid.fill(0, offset, offset + length);
      invalid.set(encoder.encode(`${"0".repeat(length - 2)}8`), offset);
      updateTarChecksum(invalid);
      expect(() => parseTarArchive(invalid)).toThrow(
        /invalid tar numeric field/,
      );

      const invalidAfterTerminator = archive.slice();
      invalidAfterTerminator.fill(0, offset, offset + length);
      invalidAfterTerminator.set(
        encoder.encode("0".repeat(length - 2)),
        offset,
      );
      invalidAfterTerminator[offset + length - 1] = 0x38;
      updateTarChecksum(invalidAfterTerminator);
      expect(() => parseTarArchive(invalidAfterTerminator)).toThrow(
        /invalid tar numeric field/,
      );
    }
  });

  it("rejects tar header text that is not valid UTF-8", () => {
    const withInvalidHeaderText = (
      archive: Uint8Array,
      offset: number,
    ): Uint8Array => {
      const invalid = archive.slice();
      invalid[offset] = 0xff;
      updateTarChecksum(invalid);
      return invalid;
    };
    const file = {
      path: "packages/app/dist/output.txt",
      contents: encoder.encode("output"),
      mode: 0o644,
      modifiedSeconds: 1,
    };
    const prefixedFile = {
      ...file,
      path: `packages/app/${"nested-segment/".repeat(7)}dist/output.txt`,
    };
    const symlink = {
      kind: "symlink" as const,
      path: "packages/app/dist/current.txt",
      linkTarget: "output.txt",
      contents: new Uint8Array(),
      mode: 0o777,
      modifiedSeconds: 1,
    };
    for (const [archive, offset] of [
      [createTarArchive([file]), 0],
      [createTarArchive([prefixedFile]), 345],
      [createTarArchive([symlink]), 157],
    ] as const) {
      expect(() =>
        parseTarArchive(withInvalidHeaderText(archive, offset)),
      ).toThrow(/valid for encoding utf-8/i);
    }
  });

  it(evidenceId.coreSecurity, () => {
    for (const path of [
      "../escape",
      "/absolute",
      "C:/escape",
      "a/../../escape",
    ]) {
      expect(() =>
        createTarArchive([
          { path, contents: new Uint8Array(), mode: 0o644, modifiedSeconds: 0 },
        ]),
      ).toThrow(/unsafe archive path/);
    }
  });

  it("property-tests fixed-seed archive round trips", () => {
    let state = 0x5eed1234;
    const random = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    for (let run = 0; run < 100; run += 1) {
      const entries = Array.from({ length: 1 + (random() % 8) }, (_, index) => {
        const contents = Uint8Array.from(
          { length: random() % 128 },
          () => random() & 0xff,
        );
        return {
          path: `packages/p${run}/out/f${index}-${random().toString(16)}.bin`,
          contents,
          mode: index % 2 === 0 ? 0o644 : 0o755,
          modifiedSeconds: random() % 1_000_000,
        };
      });
      expect(parseTarArchive(createTarArchive(entries))).toEqual(
        [...entries].sort((left, right) => left.path.localeCompare(right.path)),
      );
    }
  });
});
