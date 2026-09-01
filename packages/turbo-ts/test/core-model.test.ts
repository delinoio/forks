import { describe, expect, it } from "@rstest/core";
import { createTarArchive, parseTarArchive } from "../src/cache/archive.js";
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
  normalizePath,
  parentPath,
  relativePath,
} from "../src/core/path.js";
import { GraphError } from "../src/effect/errors.js";
import {
  buildTaskGraph,
  selectPackages,
  type TaskNode,
  topologicalOrder,
} from "../src/graph/task-graph.js";
import { selectEnvironment } from "../src/hash/task-hash.js";
import { createXxhash64, xxhash64Hex } from "../src/hash/xxhash64.js";
import {
  finishTaskOutput,
  initialTaskOutputRenderState,
  renderLogEvent,
  renderTaskOutputChunk,
} from "../src/logging/events.js";
import { parseLockfile } from "../src/repository/lockfiles.js";
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
  takePersistentDisplayOutput,
  taskScopeEnvironment,
} from "../src/run/engine.js";
import { parseConcurrency, parseRunArguments } from "../src/run/options.js";

const encoder = new TextEncoder();

const packageModel = (
  name: string,
  dependencies: ReadonlyArray<string>,
  task: Record<string, unknown> = {},
): RepositoryPackage => ({
  name,
  directory: `/repo/packages/${name}`,
  relativeDirectory: `packages/${name}`,
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
  } satisfies RepositoryPackage;
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
    packagesByName: new Map([
      [rootPackage.name, rootPackage],
      ...packages.map((entry) => [entry.name, entry] as const),
    ]),
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
    expect(isAbsolutePath("C:\\repo")).toBe(true);
    expect(isAbsolutePath("packages/app")).toBe(false);
    expect(isAbsolutePath("\\\\server\\share\\repo")).toBe(true);
    expect(normalizePath("\\\\server\\share\\repo\\packages\\..\\app")).toBe(
      "//server/share/repo/app",
    );
    expect(joinPath("\\\\server\\share", "repo", "app")).toBe(
      "//server/share/repo/app",
    );
    expect(parentPath("//server/share")).toBe("//server/share");
    expect(parentPath("//server/share/repo")).toBe("//server/share");
    expect(relativePath("//server/share/repo", "//server/share/repo/app")).toBe(
      "app",
    );
    expect(isPathContained("//SERVER/Share", "//server/share/repo")).toBe(true);
    expect(isPathContained("//server/share", "//server/other/repo")).toBe(
      false,
    );
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
          '{"lockfileVersion":3,"packages":{"node_modules/a":{"name":"a","version":"1.0.0"}}}',
        ),
      ),
    ).toMatchObject({
      format: "npm",
      packages: [{ name: "a", version: "1.0.0" }],
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
          '# This file is generated by Yarn.\n# Manual changes may be lost.\n\n__metadata:\n  version: 8\n"a@npm:1.0.0":\n  version: 1.0.0\n',
        ),
      ).format,
    ).toBe("yarn-berry");
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

  it("bounds persistent output without a newline", () => {
    const pending = "x".repeat(64 * 1024 + 7);
    expect(takePersistentDisplayOutput(pending)).toEqual({
      output: "x".repeat(64 * 1024),
      remainder: "x".repeat(7),
    });
    expect(takePersistentDisplayOutput("partial")).toBeUndefined();
    expect(takePersistentDisplayOutput("complete\npartial")).toEqual({
      output: "complete\n",
      remainder: "partial",
    });
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

  it("uses available parallelism and preserves Cargo pass-through arguments", () => {
    expect(parseConcurrency("50%", 8)).toBe(4);
    expect(parseConcurrency("100%", 1)).toBe(1);
    const packageModel = {
      name: "app",
      directory: "/repo/crates/app",
      relativeDirectory: "crates/app",
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

  it("plans one unfiltered Cargo verification per workspace", () => {
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
    const workspacePlan = planCargoWorkspaceTasks(graph, ["test"], true);
    expect(workspacePlan.graph.entrypoints).toEqual(["app#test"]);
    const workspaceNode = workspacePlan.graph.nodes.get("app#test")!;
    const workspaceScope = workspacePlan.scopes.get("app#test")!;
    expect(packageManagerCommand(workspaceNode, [], workspaceScope)).toEqual({
      command: "cargo",
      arguments: ["test", "--workspace", "--locked"],
      cwd: "/repo",
    });
    expect(isTaskScopeCacheable(workspaceNode, [], workspaceScope)).toBe(false);

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
    const formatPlan = planCargoWorkspaceTasks(formatGraph, ["format"], true);
    const formatNode = formatPlan.graph.nodes.get("app#format")!;
    expect(
      packageManagerCommand(
        formatNode,
        [],
        formatPlan.scopes.get("app#format")!,
      ),
    ).toEqual({ command: "cargo", arguments: ["fmt", "--all"], cwd: "/repo" });

    const filteredPlan = planCargoWorkspaceTasks(graph, ["test"], false);
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
      ["--lib"],
      ["--bin", "tool"],
      ["--bins"],
      ["--example=demo"],
      ["--examples"],
      ["--test", "integration"],
      ["--tests"],
      ["--bench=throughput"],
      ["--benches"],
      ["--all-targets"],
    ]) {
      expect(isTaskScopeCacheable(node, arguments_)).toBe(false);
    }
    expect(
      isTaskScopeCacheable(
        node,
        [],
        { kind: "package" },
        { CARGO_BUILD_TARGET: "synthetic-target" },
      ),
    ).toBe(false);
    expect(
      isTaskScopeCacheable(
        node,
        [],
        { kind: "package" },
        { cargo_build_target: "synthetic-target" },
        true,
      ),
    ).toBe(false);
    expect(isTaskScopeCacheable(node, ["--features=integration"])).toBe(true);
  });

  it("rejects unknown output log modes", () => {
    expect(() =>
      parseRunArguments(["run", "build", "--output-logs=unexpected"]),
    ).toThrow(/invalid output log mode/);
  });
});

describe("cache archive safety", () => {
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
