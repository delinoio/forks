import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "@rstest/core";
import { Effect } from "effect";
import {
  evictLocalCache,
  restoreLocalCache,
  writeLocalCache,
} from "../src/cache/local-cache.js";
import {
  restoreRemoteCache,
  writeRemoteCache,
} from "../src/cache/remote-cache.js";
import { evidenceId } from "../src/compatibility/ledger.js";
import { loadRootConfiguration } from "../src/config/runtime.js";
import { nodeFoundationLayer } from "../src/effect/node-layer.js";
import { ProcessService } from "../src/effect/services.js";
import { buildTaskGraph } from "../src/graph/task-graph.js";
import { hashTask } from "../src/hash/task-hash.js";
import { discoverRepository } from "../src/repository/model.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixtureRoot = `${packageRoot}/test/fixtures/basic-workspace`;
const candidateEntrypoint = `${packageRoot}/dist/bin/turbo-ts.js`;
const officialExecutable = `${repositoryRoot}/node_modules/.bin/turbo`;

const makeFixture = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "turbo-ts-core-"));
  await cp(fixtureRoot, directory, { recursive: true });
  return directory;
};

const run = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const processService = yield* ProcessService;
        return yield* processService.run({ command, args, cwd, env });
      }),
    ).pipe(Effect.provide(nodeFoundationLayer)),
  );

describe("core CLI execution", () => {
  it(evidenceId.coreExecution, async () => {
    const directory = await makeFixture();
    try {
      const explicit = await run(
        process.execPath,
        [candidateEntrypoint, "run", "build", "--cwd", directory, "--no-cache"],
        repositoryRoot,
      );
      expect(explicit.exitCode).toBe(0);
      expect(explicit.stdout.indexOf("synthetic-library:build")).toBeLessThan(
        explicit.stdout.indexOf("synthetic-app:build"),
      );
      const implicit = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "build",
          "--cwd",
          directory,
          "--filter",
          "synthetic-library",
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(implicit.exitCode).toBe(0);
      expect(implicit.stdout).toContain("library build");
      expect(implicit.stdout).not.toContain("app build");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("rejects every unresolved requested task before execution", async () => {
    const directory = await makeFixture();
    try {
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "verify",
          "--cwd",
          directory,
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("task not found: verify");
      expect(result.stdout).not.toContain("library build");
      expect(result.stdout).not.toContain("app build");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("writes and restores local cache entries", async () => {
    const directory = await makeFixture();
    try {
      const args = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--output-logs=hash-only",
      ];
      const cold = await run(process.execPath, args, repositoryRoot);
      const warm = await run(process.execPath, args, repositoryRoot);
      expect(cold.exitCode).toBe(0);
      expect(cold.stdout).toContain("cache miss");
      expect(warm.exitCode).toBe(0);
      expect(warm.stdout).toContain("cache hit");
      expect(
        await readFile(
          `${directory}/packages/app/.turbo/turbo-build.log`,
          "utf8",
        ),
      ).toContain("app build");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("excludes a configured workspace cache directory from task inputs", async () => {
    const directory = await makeFixture();
    try {
      const args = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--filter=synthetic-library",
        "--cache-dir=packages/library/task-cache",
        "--output-logs=hash-only",
      ];
      const cold = await run(process.execPath, args, repositoryRoot);
      const warm = await run(process.execPath, args, repositoryRoot);
      expect(cold.exitCode).toBe(0);
      expect(cold.stdout).toContain("cache miss");
      expect(warm.exitCode).toBe(0);
      expect(warm.stdout).toContain("cache hit");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("treats zero cache eviction limits as disabled", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as Record<string, unknown>;
      configuration.cacheMaxAge = "0";
      configuration.cacheMaxSize = "0";
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const args = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--filter=synthetic-library",
        "--output-logs=hash-only",
      ];
      expect(
        (await run(process.execPath, args, repositoryRoot)).stdout,
      ).toContain("cache miss");
      expect(
        (await run(process.execPath, args, repositoryRoot)).stdout,
      ).toContain("cache hit");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("accepts the documented week unit for cache age", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as Record<string, unknown>;
      configuration.cacheMaxAge = "2w";
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "--cwd",
          directory,
          "--filter=synthetic-library",
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("library build");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("skips local eviction when local caching is disabled", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as Record<string, unknown>;
      configuration.cacheDir = "blocked-cache";
      configuration.cacheMaxAge = "1h";
      configuration.cacheMaxSize = "1kb";
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const blockedCachePath = `${directory}/blocked-cache`;
      await writeFile(blockedCachePath, "not a directory\n");
      for (const cacheArguments of [
        ["--no-cache"],
        ["--remote-only"],
        ["--cache=remote:rw"],
      ]) {
        const result = await run(
          process.execPath,
          [
            candidateEntrypoint,
            "run",
            "build",
            "--cwd",
            directory,
            "--filter=synthetic-library",
            ...cacheArguments,
          ],
          repositoryRoot,
        );
        expect(result.exitCode, result.stderr).toBe(0);
        expect(await readFile(blockedCachePath, "utf8")).toBe(
          "not a directory\n",
        );
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("evicts expired cache entries before read-only restores", async () => {
    const directory = await makeFixture();
    const cacheDirectory = `${directory}/.turbo/cache`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as Record<string, unknown>;
      configuration.cacheMaxAge = "1h";
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const args = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--filter=synthetic-library",
        "--output-logs=hash-only",
      ];
      expect(
        (await run(process.execPath, args, repositoryRoot)).stdout,
      ).toContain("cache miss");
      const archiveName = (await readdir(cacheDirectory)).find((name) =>
        name.endsWith(".tar.zst"),
      );
      expect(archiveName).toBeDefined();
      const archivePath = `${cacheDirectory}/${archiveName!}`;
      const stale = new Date(Date.now() - 2 * 60 * 60 * 1_000);
      await utimes(archivePath, stale, stale);
      const readOnly = await run(
        process.execPath,
        [...args, "--cache=local:r"],
        repositoryRoot,
      );
      expect(readOnly.exitCode).toBe(0);
      expect(readOnly.stdout).toContain("cache miss");
      expect(readOnly.stdout).not.toContain("cache hit");
      await expect(lstat(archivePath)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("accepts documented cache policies and rejects malformed policies", async () => {
    const directory = await makeFixture();
    try {
      const args = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--filter=synthetic-library",
        "--cache=local:rw",
        "--output-logs=hash-only",
      ];
      expect(
        (await run(process.execPath, args, repositoryRoot)).stdout,
      ).toContain("cache miss");
      expect(
        (await run(process.execPath, args, repositoryRoot)).stdout,
      ).toContain("cache hit");
      const malformed = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "--cwd",
          directory,
          "--cache=local:read",
        ],
        repositoryRoot,
      );
      expect(malformed.exitCode).not.toBe(0);
      expect(malformed.stderr).toContain("invalid cache specification");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("merges qualified root tasks before validating workspace overrides", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      configuration.tasks["synthetic-app#build"] = {
        cache: false,
        outputs: ["qualified/**"],
      };
      configuration.tasks["synthetic-app#fail"] = { persistent: true };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const workspacePath = `${directory}/packages/app/turbo.json`;
      const workspace = JSON.parse(await readFile(workspacePath, "utf8")) as {
        tasks: Record<string, Record<string, unknown>>;
      };
      workspace.tasks.build!.interactive = true;
      workspace.tasks.fail = { interruptible: true };
      await writeFile(workspacePath, `${JSON.stringify(workspace, null, 2)}\n`);
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(
        model.packagesByName.get("synthetic-app")?.tasks["synthetic-app#build"],
      ).toMatchObject({
        cache: false,
        interactive: true,
        outputs: ["build/**"],
      });
      expect(
        model.packagesByName.get("synthetic-app")?.tasks["synthetic-app#fail"],
      ).toMatchObject({ interruptible: true, persistent: true });

      configuration.tasks["synthetic-app#build"] = {
        cache: false,
        interactive: true,
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      workspace.tasks.build!.cache = true;
      await writeFile(workspacePath, `${JSON.stringify(workspace, null, 2)}\n`);
      const invalid = await run(
        process.execPath,
        [candidateEntrypoint, "run", "build", "--cwd", directory],
        repositoryRoot,
      );
      expect(invalid.exitCode).not.toBe(0);
      expect(invalid.stderr).toContain(
        "interactive tasks must disable caching",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("links JavaScript workspaces only when declared ranges match", async () => {
    const directory = await makeFixture();
    try {
      const appManifestPath = `${directory}/packages/app/package.json`;
      const libraryManifestPath = `${directory}/packages/library/package.json`;
      const appManifest = JSON.parse(
        await readFile(appManifestPath, "utf8"),
      ) as {
        dependencies: Record<string, string>;
      };
      const libraryManifest = JSON.parse(
        await readFile(libraryManifestPath, "utf8"),
      ) as { version: string };
      appManifest.dependencies["synthetic-library"] = "^1.0.0";
      libraryManifest.version = "2.0.0";
      await writeFile(
        appManifestPath,
        `${JSON.stringify(appManifest, null, 2)}\n`,
      );
      await writeFile(
        libraryManifestPath,
        `${JSON.stringify(libraryManifest, null, 2)}\n`,
      );
      const discover = () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const rootConfiguration = yield* loadRootConfiguration(directory);
            return yield* discoverRepository(directory, rootConfiguration);
          }).pipe(Effect.provide(nodeFoundationLayer)),
        );
      const incompatible = await discover();
      const incompatibleApp = incompatible.packagesByName.get("synthetic-app")!;
      expect(incompatibleApp.internalDependencies).toEqual([]);
      expect(
        buildTaskGraph(
          incompatible,
          [incompatibleApp],
          ["build"],
          false,
        ).nodes.has("synthetic-library#build"),
      ).toBe(false);

      libraryManifest.version = "1.2.0";
      await writeFile(
        libraryManifestPath,
        `${JSON.stringify(libraryManifest, null, 2)}\n`,
      );
      const compatible = await discover();
      const compatibleApp = compatible.packagesByName.get("synthetic-app")!;
      expect(compatibleApp.internalDependencies).toEqual(["synthetic-library"]);
      expect(
        buildTaskGraph(compatible, [compatibleApp], ["build"], false).nodes.has(
          "synthetic-library#build",
        ),
      ).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("uses workspace globs from the resolved package manager", async () => {
    const directory = await makeFixture();
    try {
      const manifestPath = `${directory}/package.json`;
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as Record<string, unknown>;
      manifest.packageManager = "npm@11.6.0";
      manifest.workspaces = ["packages/app"];
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(model.manager).toBe("npm");
      expect(model.packages.map((packageModel) => packageModel.name)).toEqual([
        "synthetic-app",
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("reads uv project names and dependencies from their TOML sections", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        tasks: Record<string, unknown>;
      };
      configuration.futureFlags = { experimentalPythonWorkspaces: true };
      configuration.tasks.build = { dependsOn: ["^build"] };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await writeFile(
        `${directory}/pyproject.toml`,
        `[project]\n` +
          `name = "python-root"\n` +
          `version = "0.1.0"\n` +
          `dependencies = []\n` +
          `\n` +
          `[tool.uv.workspace]\n` +
          `members = ["python/*"]\n` +
          `exclude = ["python/excluded"]\n`,
      );
      await mkdir(`${directory}/python/app`, { recursive: true });
      await mkdir(`${directory}/python/library`, { recursive: true });
      await mkdir(`${directory}/python/excluded`, { recursive: true });
      await mkdir(`${directory}/examples/unrelated`, { recursive: true });
      await writeFile(
        `${directory}/python/app/pyproject.toml`,
        `[tool.uv]\n` +
          `dev-dependencies = ["types-requests>=2"]\n` +
          `\n` +
          `[[tool.uv.index]]\n` +
          `name = "internal"\n` +
          `url = "https://example.test/simple"\n` +
          `\n` +
          `[project]\n` +
          `name = "app"\n` +
          `dependencies = ["my-util>=1", "requests>=2"]\n` +
          `\n` +
          `[project.optional-dependencies]\n` +
          `test = ["pytest>=8"]\n` +
          `\n` +
          `[dependency-groups]\n` +
          `dev = ["ruff>=1", { include-group = "lint" }]\n` +
          `lint = ["mypy>=1"]\n`,
      );
      await writeFile(
        `${directory}/python/library/pyproject.toml`,
        `[project]\nname = "my_util"\ndependencies = []\n`,
      );
      await writeFile(
        `${directory}/python/excluded/pyproject.toml`,
        `[project]\nname = "excluded-project"\ndependencies = []\n`,
      );
      await writeFile(
        `${directory}/examples/unrelated/pyproject.toml`,
        `[project]\nname = "unrelated-project"\ndependencies = []\n`,
      );
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      const app = model.packagesByName.get("app");
      expect(app?.dependencyNames).toEqual([
        "my-util",
        "mypy",
        "pytest",
        "requests",
        "ruff",
        "types-requests",
      ]);
      expect(app?.internalDependencies).toEqual(["my_util"]);
      expect(model.packagesByName.has("internal")).toBe(false);
      expect(model.packagesByName.has("python-root")).toBe(true);
      expect(model.packagesByName.has("excluded-project")).toBe(false);
      expect(model.packagesByName.has("unrelated-project")).toBe(false);
      expect(Object.keys(app?.scripts ?? {}).sort()).toEqual(["build", "test"]);
      expect(app?.tasks.build).toMatchObject({ cache: false });
      expect(
        [
          ...buildTaskGraph(model, [app!], ["build"], false).nodes.keys(),
        ].sort(),
      ).toEqual(["app#build", "my_util#build"]);

      configuration.tasks.build = {
        cache: true,
        dependsOn: ["^build"],
        outputs: ["dist/**"],
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const explicitlyCached = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(
        explicitlyCached.packagesByName.get("app")?.tasks.build,
      ).toMatchObject({ cache: true, outputs: ["dist/**"] });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("hashes the owning Cargo and uv workspace lockfiles", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        tasks: Record<string, unknown>;
      };
      configuration.futureFlags = {
        experimentalCargoWorkspaces: true,
        experimentalPythonWorkspaces: true,
      };
      configuration.tasks.test = {
        inputs: ["Cargo.toml", "pyproject.toml"],
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await writeFile(
        `${directory}/pyproject.toml`,
        `[tool.uv.workspace]\nmembers = ["python/*"]\n`,
      );
      await mkdir(`${directory}/rust/tool/src`, { recursive: true });
      await writeFile(
        `${directory}/rust/Cargo.toml`,
        '[workspace]\nmembers = ["tool"]\nresolver = "3"\n',
      );
      await writeFile(
        `${directory}/rust/tool/Cargo.toml`,
        '[package]\nname = "rust-tool"\nversion = "0.1.0"\nedition = "2024"\n',
      );
      await writeFile(`${directory}/rust/tool/src/main.rs`, "fn main() {}\n");
      await cp(
        `${repositoryRoot}/rust-toolchain`,
        `${directory}/rust-toolchain`,
      );
      const generatedLockfile = await run(
        "cargo",
        [
          "generate-lockfile",
          "--manifest-path",
          `${directory}/rust/Cargo.toml`,
        ],
        directory,
      );
      expect(generatedLockfile.exitCode, generatedLockfile.stderr).toBe(0);
      await mkdir(`${directory}/python/app`, { recursive: true });
      await writeFile(
        `${directory}/python/app/pyproject.toml`,
        '[project]\nname = "python-app"\nversion = "0.1.0"\ndependencies = []\n',
      );
      const uvLockfile = `${directory}/uv.lock`;
      await writeFile(uvLockfile, "version = 1\nrevision = 1\n");
      await writeFile(
        `${directory}/pnpm-lock.yaml`,
        "lockfileVersion: '9.0'\n",
      );
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      const cargoPackage = model.packagesByName.get("rust-tool")!;
      const uvPackage = model.packagesByName.get("python-app")!;
      const graph = buildTaskGraph(
        model,
        [cargoPackage, uvPackage],
        ["test"],
        false,
      );
      const compute = (id: string) =>
        Effect.runPromise(
          hashTask(
            model,
            graph.nodes.get(id)!,
            [],
            true,
            [],
            `${directory}/.turbo/cache`,
          ).pipe(Effect.provide(nodeFoundationLayer)),
        );
      const cargoBefore = await compute("rust-tool#test");
      const uvBefore = await compute("python-app#test");
      const cargoLockfile = `${directory}/rust/Cargo.lock`;
      await writeFile(
        cargoLockfile,
        `${await readFile(cargoLockfile, "utf8")}# changed\n`,
      );
      const cargoAfter = await compute("rust-tool#test");
      const uvAfterCargoChange = await compute("python-app#test");
      expect(cargoAfter.hash).not.toBe(cargoBefore.hash);
      expect(uvAfterCargoChange.hash).toBe(uvBefore.hash);
      await writeFile(uvLockfile, "version = 1\nrevision = 2\n");
      expect((await compute("python-app#test")).hash).not.toBe(uvBefore.hash);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);

  it("includes pass-through arguments in task hashes", async () => {
    const directory = await makeFixture();
    try {
      const manifestPath = `${directory}/packages/library/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.build =
        "node -e \"console.log(process.argv.slice(1).join(':'))\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const common = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--filter",
        "synthetic-library",
        "--output-logs=hash-only",
      ];
      const production = await run(
        process.execPath,
        [...common, "--", "--mode=production"],
        repositoryRoot,
      );
      const development = await run(
        process.execPath,
        [...common, "--", "--mode=development"],
        repositoryRoot,
      );
      expect(production.stdout).toContain("cache miss");
      expect(development.stdout).toContain("cache miss");
      expect(
        await readFile(
          `${directory}/packages/library/.turbo/turbo-build.log`,
          "utf8",
        ),
      ).toContain("--mode=development");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("excludes deleted tracked files from task hash inputs", async () => {
    const directory = await mkdtemp(join(packageRoot, "test-deleted-input-"));
    await cp(fixtureRoot, directory, { recursive: true });
    const trackedPath = `${directory}/packages/library/tracked.txt`;
    try {
      await writeFile(trackedPath, "tracked\n");
      for (const args of [["init"], ["add", "."]]) {
        const result = await run("git", args, directory);
        expect(result.exitCode, `${args.join(" ")}: ${result.stderr}`).toBe(0);
      }
      const command = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--filter=synthetic-library",
        "--output-logs=hash-only",
      ];
      expect(
        (await run(process.execPath, command, repositoryRoot)).stdout,
      ).toContain("cache miss");
      await rm(trackedPath);
      const result = await run(process.execPath, command, repositoryRoot);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("cache miss");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("includes repository-root task inputs in task hashes", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, { inputs?: Array<string> }> };
      configuration.tasks.build!.inputs = ["$TURBO_ROOT$/shared/config.json"];
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await mkdir(`${directory}/shared`, { recursive: true });
      const sharedConfiguration = `${directory}/shared/config.json`;
      await writeFile(sharedConfiguration, '{"value":"first"}\n');
      const command = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--filter=synthetic-library",
        "--output-logs=hash-only",
      ];
      expect(
        (await run(process.execPath, command, repositoryRoot)).stdout,
      ).toContain("cache miss");
      await writeFile(sharedConfiguration, '{"value":"second"}\n');
      expect(
        (await run(process.execPath, command, repositoryRoot)).stdout,
      ).toContain("cache miss");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("includes Git file modes and kinds in task hashes", async () => {
    if (process.platform === "win32") return;
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    const inputPath = `${packageDirectory}/input.txt`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, { inputs?: Array<string> }> };
      configuration.tasks.build!.inputs = ["input.txt"];
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await writeFile(inputPath, "payload");
      await chmod(inputPath, 0o644);
      const args = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--filter=synthetic-library",
        "--output-logs=hash-only",
      ];
      expect(
        (await run(process.execPath, args, repositoryRoot)).stdout,
      ).toContain("cache miss");
      await chmod(inputPath, 0o755);
      expect(
        (await run(process.execPath, args, repositoryRoot)).stdout,
      ).toContain("cache miss");
      await rm(inputPath);
      await symlink("payload", inputPath);
      expect(
        (await run(process.execPath, args, repositoryRoot)).stdout,
      ).toContain("cache miss");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("rejects a missing explicit root configuration", async () => {
    const directory = await makeFixture();
    try {
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "--cwd",
          directory,
          "--root-turbo-json=missing-turbo.json",
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("missing-turbo.json");
      expect(result.stdout).not.toContain("library build");
      expect(result.stdout).not.toContain("app build");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("preserves dependency hashes in parallel mode", async () => {
    const directory = await makeFixture();
    const args = [
      candidateEntrypoint,
      "run",
      "build",
      "--cwd",
      directory,
      "--parallel",
      "--concurrency=2",
      "--output-logs=hash-only",
    ];
    try {
      const first = await run(process.execPath, args, repositoryRoot);
      expect((first.stdout.match(/cache miss/g) ?? []).length).toBe(2);
      await writeFile(
        `${directory}/packages/library/source.txt`,
        "changed dependency\n",
      );
      const second = await run(process.execPath, args, repositoryRoot);
      expect((second.stdout.match(/cache miss/g) ?? []).length).toBe(2);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("honors Git revisions encoded in package filters", async () => {
    await mkdir(`${repositoryRoot}/.turbo`, { recursive: true });
    const directory = await mkdtemp(
      join(repositoryRoot, ".turbo/turbo-ts-git-range-"),
    );
    await cp(fixtureRoot, directory, { recursive: true });
    try {
      for (const args of [
        ["init"],
        ["config", "user.email", "synthetic@example.test"],
        ["config", "user.name", "Synthetic Fixture"],
        ["add", "."],
        ["commit", "-m", "base"],
        ["branch", "release"],
      ]) {
        const result = await run("git", args, directory);
        expect(result.exitCode, `${args.join(" ")}: ${result.stderr}`).toBe(0);
      }
      await writeFile(`${directory}/packages/library/source.txt`, "library\n");
      expect((await run("git", ["add", "."], directory)).exitCode).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "library"], directory)).exitCode,
      ).toBe(0);
      expect(
        (await run("git", ["branch", "develop"], directory)).exitCode,
      ).toBe(0);
      await writeFile(`${directory}/packages/app/source.txt`, "app\n");
      expect((await run("git", ["add", "."], directory)).exitCode).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "app"], directory)).exitCode,
      ).toBe(0);
      const execute = (filter: string) =>
        run(
          process.execPath,
          [
            candidateEntrypoint,
            "run",
            "build",
            "--cwd",
            directory,
            `--filter=${filter}`,
            "--only",
            "--no-cache",
          ],
          repositoryRoot,
        );
      const characterClass = await execute("synthetic-[al]*");
      expect(characterClass.exitCode).toBe(0);
      expect(characterClass.stdout).toContain("app build");
      expect(characterClass.stdout).toContain("library build");
      const sinceDevelop = await execute("[develop]");
      expect(sinceDevelop.stdout).toContain("app build");
      expect(sinceDevelop.stdout).not.toContain("library build");
      const releaseToDevelop = await execute("[release...develop]");
      expect(releaseToDevelop.stdout).toContain("library build");
      expect(releaseToDevelop.stdout).not.toContain("app build");
      const invalid = await execute("[missing-reference]");
      expect(invalid.exitCode).not.toBe(0);
      expect(invalid.stderr).toContain(
        "invalid Git range filter: [missing-reference]",
      );
      expect(invalid.stdout).not.toContain("library build");
      expect(invalid.stdout).not.toContain("app build");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("treats global dependencies and both rename paths as affected", async () => {
    await mkdir(`${repositoryRoot}/.turbo`, { recursive: true });
    const directory = await mkdtemp(
      join(repositoryRoot, ".turbo/turbo-ts-affected-paths-"),
    );
    await cp(fixtureRoot, directory, { recursive: true });
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        globalDependencies?: Array<string>;
        tasks: Record<string, unknown>;
      };
      configuration.globalDependencies = ["packages/app/global.txt"];
      configuration.tasks.check = { cache: false };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      for (const packageName of ["app", "library"]) {
        const manifestPath = `${directory}/packages/${packageName}/package.json`;
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          scripts: Record<string, string>;
        };
        manifest.scripts.check = `node -e "console.log('${packageName} check')"`;
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      await writeFile(`${directory}/packages/library/moved.txt`, "shared\n");
      await writeFile(`${directory}/packages/app/global.txt`, "first\n");
      for (const args of [
        ["init"],
        ["config", "user.email", "synthetic@example.test"],
        ["config", "user.name", "Synthetic Fixture"],
        ["add", "."],
        ["commit", "-m", "base"],
      ]) {
        const result = await run("git", args, directory);
        expect(result.exitCode, `${args.join(" ")}: ${result.stderr}`).toBe(0);
      }
      expect(
        (
          await run(
            "git",
            ["mv", "packages/library/moved.txt", "packages/app/moved.txt"],
            directory,
          )
        ).exitCode,
      ).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "move input"], directory)).exitCode,
      ).toBe(0);
      const executeAffected = () =>
        run(
          process.execPath,
          [
            candidateEntrypoint,
            "run",
            "check",
            "--cwd",
            directory,
            "--affected",
            "--no-cache",
          ],
          repositoryRoot,
          { TURBO_SCM_BASE: "HEAD~1", TURBO_SCM_HEAD: "HEAD" },
        );
      const renamed = await executeAffected();
      expect(renamed.exitCode).toBe(0);
      expect(renamed.stdout).toContain("app check");
      expect(renamed.stdout).toContain("library check");

      await writeFile(`${directory}/packages/app/global.txt`, "second\n");
      expect((await run("git", ["add", "."], directory)).exitCode).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "global input"], directory))
          .exitCode,
      ).toBe(0);
      const global = await executeAffected();
      expect(global.exitCode).toBe(0);
      expect(global.stdout).toContain("app check");
      expect(global.stdout).toContain("library check");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("treats new global inputs as package-level affected paths", async () => {
    await mkdir(`${repositoryRoot}/.turbo`, { recursive: true });
    const directory = await mkdtemp(
      join(repositoryRoot, ".turbo/turbo-ts-global-inputs-affected-"),
    );
    await cp(fixtureRoot, directory, { recursive: true });
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        global?: Record<string, unknown>;
        tasks: Record<string, unknown>;
      };
      configuration.futureFlags = { globalConfiguration: true };
      configuration.global = { inputs: ["./packages/app/global.txt"] };
      configuration.tasks.check = { cache: false };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      for (const packageName of ["app", "library"]) {
        const manifestPath = `${directory}/packages/${packageName}/package.json`;
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          scripts: Record<string, string>;
        };
        manifest.scripts.check = `node -e "console.log('${packageName} check')"`;
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      await writeFile(`${directory}/packages/app/global.txt`, "first\n");
      for (const args of [
        ["init"],
        ["config", "user.email", "synthetic@example.test"],
        ["config", "user.name", "Synthetic Fixture"],
        ["add", "."],
        ["commit", "-m", "base"],
      ]) {
        const result = await run("git", args, directory);
        expect(result.exitCode, `${args.join(" ")}: ${result.stderr}`).toBe(0);
      }
      await writeFile(`${directory}/packages/app/global.txt`, "second\n");
      expect((await run("git", ["add", "."], directory)).exitCode).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "global input"], directory))
          .exitCode,
      ).toBe(0);
      const affected = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "check",
          "--cwd",
          directory,
          "--affected",
          "--no-cache",
        ],
        repositoryRoot,
        { TURBO_SCM_BASE: "HEAD~1", TURBO_SCM_HEAD: "HEAD" },
      );
      expect(affected.exitCode).toBe(0);
      expect(affected.stdout).toContain("app check");
      expect(affected.stdout).toContain("library check");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("discovers the root from a nested workspace and applies exclusions", async () => {
    const directory = await makeFixture();
    try {
      await mkdir(`${directory}/packages/legacy`, { recursive: true });
      await writeFile(
        `${directory}/packages/legacy/package.json`,
        JSON.stringify({
          name: "synthetic-legacy",
          private: true,
          scripts: { build: "node -e \"console.log('legacy build')\"" },
        }),
      );
      await writeFile(
        `${directory}/pnpm-workspace.yaml`,
        "packages:\n  - packages/*\n  - '!packages/legacy'\n",
      );
      const result = await run(
        process.execPath,
        [candidateEntrypoint, "run", "build", "--no-cache"],
        `${directory}/packages/app`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("app build");
      expect(result.stdout).toContain("library build");
      expect(result.stdout).not.toContain("legacy build");
      const explicit = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "--cwd",
          `${directory}/packages/app`,
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(explicit.exitCode).toBe(0);
      expect(explicit.stdout).toContain("app build");
      expect(explicit.stdout).toContain("library build");
      expect(explicit.stdout).not.toContain("legacy build");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("hashes input links and restores output links from cache", async () => {
    if (process.platform === "win32") return;
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        tasks: Record<
          string,
          { inputs?: Array<string>; outputs?: Array<string> }
        >;
      };
      configuration.tasks.build = {
        inputs: ["input.txt"],
        outputs: ["dist/**"],
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.build =
        "node -e \"const fs=require('node:fs'); fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/value.txt',fs.readFileSync('input.txt')); fs.symlinkSync('value.txt','dist/current.txt')\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await writeFile(`${packageDirectory}/source-a.txt`, "same\n");
      await writeFile(`${packageDirectory}/source-b.txt`, "same\n");
      await symlink("source-a.txt", `${packageDirectory}/input.txt`);
      const args = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--filter=synthetic-library",
        "--output-logs=hash-only",
      ];
      expect(
        (await run(process.execPath, args, repositoryRoot)).stdout,
      ).toContain("cache miss");
      await rm(`${packageDirectory}/dist`, { force: true, recursive: true });
      await rm(`${packageDirectory}/input.txt`, { force: true });
      await symlink("source-b.txt", `${packageDirectory}/input.txt`);
      expect(
        (await run(process.execPath, args, repositoryRoot)).stdout,
      ).toContain("cache miss");
      await rm(`${packageDirectory}/dist`, { force: true, recursive: true });
      expect(
        (await run(process.execPath, args, repositoryRoot)).stdout,
      ).toContain("cache hit");
      expect(await readlink(`${packageDirectory}/dist/current.txt`)).toBe(
        "value.txt",
      );
      await writeFile(`${packageDirectory}/source-b.txt`, "changed target\n");
      await rm(`${packageDirectory}/dist`, { force: true, recursive: true });
      expect(
        (await run(process.execPath, args, repositoryRoot)).stdout,
      ).toContain("cache hit");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("starts persistent with companions inside one concurrency slot", async () => {
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      configuration.tasks.check = { cache: false, with: ["serve"] };
      configuration.tasks.serve = { cache: false, persistent: true };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.serve =
        "node -e \"const fs=require('node:fs'); console.log('persistent server ready'); fs.writeFileSync('serve.ready','1'); setInterval(()=>{},1000)\"";
      manifest.scripts.check =
        "node -e \"const fs=require('node:fs'); const started=Date.now(); const timer=setInterval(()=>{if(fs.existsSync('serve.ready')){fs.writeFileSync('owner.done','1'); clearInterval(timer)}else if(Date.now()-started>3000){process.exit(7)}},10)\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "check",
          "--cwd",
          directory,
          "--filter=synthetic-library",
          "--concurrency=1",
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("persistent server ready");
      expect(await readFile(`${packageDirectory}/serve.ready`, "utf8")).toBe(
        "1",
      );
      expect(await readFile(`${packageDirectory}/owner.done`, "utf8")).toBe(
        "1",
      );
      expect(
        await readFile(`${packageDirectory}/.turbo/turbo-serve.log`, "utf8"),
      ).toContain("persistent server ready");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("limits foreground owners that share a persistent companion", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      configuration.tasks.check = {
        cache: false,
        with: ["synthetic-library#serve"],
      };
      configuration.tasks.serve = { cache: false, persistent: true };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      for (const packageName of ["app", "library"]) {
        const manifestPath = `${directory}/packages/${packageName}/package.json`;
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          scripts: Record<string, string>;
        };
        manifest.scripts.check = `node -e "const fs=require('node:fs'); const path='../../foreground.lock'; let handle; try { handle=fs.openSync(path,'wx'); } catch { process.exit(9); } setTimeout(() => { fs.closeSync(handle); fs.unlinkSync(path); console.log('${packageName} check'); }, 200);"`;
        if (packageName === "library") {
          manifest.scripts.serve = 'node -e "setInterval(() => {}, 1000)"';
        }
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "check",
          "--cwd",
          directory,
          "--concurrency=1",
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("app check");
      expect(result.stdout).toContain("library check");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("preserves dependencies between foreground tasks in a with group", async () => {
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      configuration.tasks.setup = { cache: false, with: ["serve"] };
      configuration.tasks.test = {
        cache: false,
        dependsOn: ["setup"],
        with: ["serve"],
      };
      configuration.tasks.serve = { cache: false, persistent: true };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.serve =
        "node -e \"const fs=require('node:fs'); fs.writeFileSync('server.ready','1'); setInterval(()=>{},1000)\"";
      manifest.scripts.setup =
        "node -e \"const fs=require('node:fs'); const started=Date.now(); const timer=setInterval(()=>{if(fs.existsSync('server.ready')){clearInterval(timer); setTimeout(()=>fs.writeFileSync('setup.done','1'),150)}else if(Date.now()-started>3000){process.exit(8)}},10)\"";
      manifest.scripts.test =
        "node -e \"const fs=require('node:fs'); if(!fs.existsSync('setup.done')) process.exit(7); fs.writeFileSync('test.done','1')\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "test",
          "--cwd",
          directory,
          "--filter=synthetic-library",
          "--concurrency=1",
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode).toBe(0);
      expect(await readFile(`${packageDirectory}/setup.done`, "utf8")).toBe(
        "1",
      );
      expect(await readFile(`${packageDirectory}/test.done`, "utf8")).toBe("1");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("backgrounds persistent companions that own nested companions", async () => {
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      configuration.tasks.check = { cache: false, with: ["serve"] };
      configuration.tasks.serve = {
        cache: false,
        persistent: true,
        with: ["database"],
      };
      configuration.tasks.database = { cache: false, persistent: true };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.database =
        "node -e \"require('node:fs').writeFileSync('database.ready','1'); setTimeout(()=>process.exit(9),3000); setInterval(()=>{},1000)\"";
      manifest.scripts.serve =
        "node -e \"const fs=require('node:fs'); const started=Date.now(); const timer=setInterval(()=>{if(fs.existsSync('database.ready')){fs.writeFileSync('serve.ready','1'); clearInterval(timer); setInterval(()=>{},1000)}else if(Date.now()-started>2000){process.exit(8)}},10); setTimeout(()=>process.exit(8),3000)\"";
      manifest.scripts.check =
        "node -e \"const fs=require('node:fs'); const started=Date.now(); const timer=setInterval(()=>{if(fs.existsSync('database.ready')&&fs.existsSync('serve.ready')){fs.writeFileSync('check.done','1'); clearInterval(timer)}else if(Date.now()-started>2000){process.exit(7)}},10)\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "check",
          "--cwd",
          directory,
          "--filter=synthetic-library",
          "--concurrency=1",
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode).toBe(0);
      expect(await readFile(`${packageDirectory}/database.ready`, "utf8")).toBe(
        "1",
      );
      expect(await readFile(`${packageDirectory}/serve.ready`, "utf8")).toBe(
        "1",
      );
      expect(await readFile(`${packageDirectory}/check.done`, "utf8")).toBe(
        "1",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("propagates persistent companion failures", async () => {
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      configuration.tasks.check = { cache: false, with: ["serve"] };
      configuration.tasks.serve = { cache: false, persistent: true };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.serve = 'node -e "process.exit(8)"';
      manifest.scripts.check =
        "node -e \"setTimeout(() => require('node:fs').writeFileSync('owner.finished', '1'), 1000)\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "check",
          "--cwd",
          directory,
          "--filter=synthetic-library",
          "--concurrency=1",
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode).not.toBe(0);
      await expect(
        readFile(`${packageDirectory}/owner.finished`, "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("fails when persistent companions exit successfully before owners", async () => {
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      configuration.tasks.check = { cache: false, with: ["serve"] };
      configuration.tasks.serve = { cache: false, persistent: true };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.serve = 'node -e "process.exit(0)"';
      manifest.scripts.check =
        "node -e \"setTimeout(() => require('node:fs').writeFileSync('owner.finished', '1'), 1000)\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "check",
          "--cwd",
          directory,
          "--filter=synthetic-library",
          "--concurrency=1",
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode).not.toBe(0);
      await expect(
        readFile(`${packageDirectory}/owner.finished`, "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("includes companion task hashes in an owner's cache key", async () => {
    const directory = await makeFixture();
    const libraryDirectory = `${directory}/packages/library`;
    const appDirectory = `${directory}/packages/app`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      configuration.tasks.integration = {
        with: ["synthetic-app#serve"],
      };
      configuration.tasks.serve = { cache: false, persistent: true };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const appManifestPath = `${appDirectory}/package.json`;
      const appManifest = JSON.parse(
        await readFile(appManifestPath, "utf8"),
      ) as { scripts: Record<string, string> };
      appManifest.scripts.serve = 'node -e "setInterval(() => {}, 1000)"';
      await writeFile(
        appManifestPath,
        `${JSON.stringify(appManifest, null, 2)}\n`,
      );
      await writeFile(`${appDirectory}/server.txt`, "first\n");
      const libraryManifestPath = `${libraryDirectory}/package.json`;
      const libraryManifest = JSON.parse(
        await readFile(libraryManifestPath, "utf8"),
      ) as { scripts: Record<string, string> };
      libraryManifest.scripts.integration =
        "node -e \"const fs=require('node:fs'); const path='../../owner-runs.txt'; const count=fs.existsSync(path)?Number(fs.readFileSync(path,'utf8')):0; fs.writeFileSync(path,String(count+1))\"";
      await writeFile(
        libraryManifestPath,
        `${JSON.stringify(libraryManifest, null, 2)}\n`,
      );
      const args = [
        candidateEntrypoint,
        "run",
        "integration",
        "--cwd",
        directory,
        "--filter=synthetic-library",
        "--concurrency=1",
        "--output-logs=hash-only",
      ];
      const cold = await run(process.execPath, args, repositoryRoot);
      const warm = await run(process.execPath, args, repositoryRoot);
      expect(cold.exitCode).toBe(0);
      expect(warm.stdout).toContain("synthetic-library:integration: cache hit");
      expect(await readFile(`${directory}/owner-runs.txt`, "utf8")).toBe("1");

      await writeFile(`${appDirectory}/server.txt`, "second\n");
      const changed = await run(process.execPath, args, repositoryRoot);
      expect(changed.exitCode).toBe(0);
      expect(changed.stdout).toContain(
        "synthetic-library:integration: cache miss",
      );
      expect(await readFile(`${directory}/owner-runs.txt`, "utf8")).toBe("2");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("restores implicit Cargo binary outputs and leaves libraries uncached", async () => {
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/rust-tool`;
    const libraryDirectory = `${directory}/packages/rust-library`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        tasks: Record<string, { cache?: boolean; outputs?: Array<string> }>;
      };
      configuration.futureFlags = { experimentalCargoWorkspaces: true };
      delete configuration.tasks.build?.outputs;
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await mkdir(`${packageDirectory}/src`, { recursive: true });
      await writeFile(
        `${packageDirectory}/Cargo.toml`,
        '[package]\nname = "synthetic-rust-tool"\nversion = "0.1.0"\nedition = "2024"\n',
      );
      await writeFile(`${packageDirectory}/src/main.rs`, "fn main() {}\n");
      await mkdir(`${libraryDirectory}/src`, { recursive: true });
      await writeFile(
        `${libraryDirectory}/Cargo.toml`,
        '[package]\nname = "synthetic-rust-library"\nversion = "0.1.0"\nedition = "2024"\n',
      );
      await writeFile(`${libraryDirectory}/src/lib.rs`, "pub fn value() {}\n");
      await cp(
        `${repositoryRoot}/rust-toolchain`,
        `${directory}/rust-toolchain`,
      );
      const lockfile = await run(
        "cargo",
        [
          "generate-lockfile",
          "--manifest-path",
          `${packageDirectory}/Cargo.toml`,
        ],
        packageDirectory,
      );
      expect(lockfile.exitCode, lockfile.stderr).toBe(0);
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(
        model.packagesByName.get("synthetic-rust-tool")?.tasks.build?.outputs,
      ).toContain(
        "$TURBO_ROOT$/packages/rust-tool/target/debug/synthetic-rust-tool",
      );
      expect(
        model.packagesByName.get("synthetic-rust-library")?.tasks.build,
      ).toMatchObject({ cache: false });
      expect(
        model.packagesByName.get("synthetic-rust-tool")?.tasks.format,
      ).toMatchObject({ cache: false });
      expect(
        model.packagesByName.get("synthetic-rust-tool")?.scripts,
      ).toMatchObject({ dev: "cargo run", run: "cargo run" });
      expect(
        model.packagesByName.get("synthetic-rust-library")?.scripts.run,
      ).toBeUndefined();
      expect(
        model.packagesByName.get("synthetic-rust-library")?.scripts.dev,
      ).toBeUndefined();
      const libraryRun = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "run",
          "--cwd",
          directory,
          "--filter=synthetic-rust-library",
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(libraryRun.exitCode).not.toBe(0);
      expect(libraryRun.stderr).toContain("task not found: run");
      const args = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--filter=synthetic-rust-tool",
        "--output-logs=hash-only",
      ];
      const cold = await run(process.execPath, args, repositoryRoot);
      expect(cold.exitCode).toBe(0);
      expect(cold.stdout).toContain("cache miss");
      const executable = `${packageDirectory}/target/debug/synthetic-rust-tool${
        process.platform === "win32" ? ".exe" : ""
      }`;
      expect((await lstat(executable)).isFile()).toBe(true);
      await rm(`${packageDirectory}/target`, { force: true, recursive: true });
      const warm = await run(process.execPath, args, repositoryRoot);
      expect(warm.exitCode).toBe(0);
      expect(warm.stdout).toContain("cache hit");
      expect((await lstat(executable)).isFile()).toBe(true);
      const releaseArgs = [...args, "--", "--release"];
      const releaseExecutable = `${packageDirectory}/target/release/synthetic-rust-tool${
        process.platform === "win32" ? ".exe" : ""
      }`;
      const releaseCold = await run(
        process.execPath,
        releaseArgs,
        repositoryRoot,
      );
      expect(releaseCold.exitCode).toBe(0);
      expect((await lstat(releaseExecutable)).isFile()).toBe(true);
      await rm(`${packageDirectory}/target`, { force: true, recursive: true });
      const releaseWarm = await run(
        process.execPath,
        releaseArgs,
        repositoryRoot,
      );
      expect(releaseWarm.exitCode).toBe(0);
      expect(releaseWarm.stdout).not.toContain("cache hit");
      expect((await lstat(releaseExecutable)).isFile()).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 60_000);

  it("hashes global dependency contents and restores declared dist outputs", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        globalDependencies?: Array<string>;
        tasks: Record<string, { outputs?: Array<string> }>;
      };
      configuration.globalDependencies = ["global.txt"];
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const manifestPath = `${directory}/packages/library/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.build =
        "node -e \"const fs = require('node:fs'); fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/value.txt', fs.readFileSync('../../global.txt', 'utf8')); console.log('built dist')\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await writeFile(`${directory}/global.txt`, "first\n");
      const args = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--filter",
        "synthetic-library",
        "--output-logs=hash-only",
      ];
      expect(
        (await run(process.execPath, args, repositoryRoot)).stdout,
      ).toContain("cache miss");
      await rm(`${directory}/packages/library/dist`, {
        force: true,
        recursive: true,
      });
      await rm(`${directory}/packages/library/.turbo`, {
        force: true,
        recursive: true,
      });
      expect(
        (await run(process.execPath, args, repositoryRoot)).stdout,
      ).toContain("cache hit");
      expect(
        await readFile(`${directory}/packages/library/dist/value.txt`, "utf8"),
      ).toBe("first\n");
      expect(
        await readFile(
          `${directory}/packages/library/.turbo/turbo-build.log`,
          "utf8",
        ),
      ).toContain("built dist");
      await writeFile(`${directory}/global.txt`, "second\n");
      expect(
        (await run(process.execPath, args, repositoryRoot)).stdout,
      ).toContain("cache miss");
      expect(
        await readFile(`${directory}/packages/library/dist/value.txt`, "utf8"),
      ).toBe("second\n");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("removes stale declared outputs before restoring a cache hit", async () => {
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        tasks: Record<
          string,
          { inputs?: Array<string>; outputs?: Array<string> }
        >;
      };
      configuration.tasks.build = {
        inputs: ["input.txt"],
        outputs: ["dist/**"],
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.build =
        "node -e \"const fs=require('node:fs'); const name=fs.readFileSync('input.txt','utf8').trim(); fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/'+name+'.js',name)\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const args = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--filter=synthetic-library",
        "--output-logs=hash-only",
      ];
      await writeFile(`${packageDirectory}/input.txt`, "new\n");
      expect(
        (await run(process.execPath, args, repositoryRoot)).stdout,
      ).toContain("cache miss");
      await rm(`${packageDirectory}/dist`, { force: true, recursive: true });
      await writeFile(`${packageDirectory}/input.txt`, "old\n");
      expect(
        (await run(process.execPath, args, repositoryRoot)).stdout,
      ).toContain("cache miss");
      await writeFile(`${packageDirectory}/input.txt`, "new\n");
      expect(
        (await run(process.execPath, args, repositoryRoot)).stdout,
      ).toContain("cache hit");
      expect(await readFile(`${packageDirectory}/dist/new.js`, "utf8")).toBe(
        "new",
      );
      await expect(lstat(`${packageDirectory}/dist/old.js`)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("uses future global configuration in per-task input and environment selection", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        global?: Record<string, unknown>;
        tasks: Record<string, { inputs?: Array<string> }>;
      };
      configuration.futureFlags = { globalConfiguration: true };
      configuration.global = {
        inputs: ["global.txt"],
        env: ["HASHED_VALUE"],
        passThroughEnv: ["PASSED_VALUE"],
      };
      configuration.tasks.build!.inputs = [
        "$TURBO_DEFAULT$",
        "!$TURBO_ROOT$/global.txt",
      ];
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await writeFile(`${directory}/global.txt`, "global\n");
      const manifestPath = `${directory}/packages/library/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.build =
        "node -e \"console.log(String(process.env.HASHED_VALUE) + ':' + String(process.env.PASSED_VALUE))\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const args = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--filter",
        "synthetic-library",
        "--output-logs=hash-only",
      ];
      const first = await run(process.execPath, args, repositoryRoot, {
        HASHED_VALUE: "one",
        PASSED_VALUE: "visible",
      });
      const second = await run(process.execPath, args, repositoryRoot, {
        HASHED_VALUE: "two",
        PASSED_VALUE: "visible",
      });
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain("cache miss");
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("cache miss");
      await writeFile(`${directory}/global.txt`, "excluded change\n");
      expect(
        (
          await run(process.execPath, args, repositoryRoot, {
            HASHED_VALUE: "two",
            PASSED_VALUE: "visible",
          })
        ).stdout,
      ).toContain("cache hit");
      configuration.tasks.build!.inputs = ["$TURBO_DEFAULT$"];
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      expect(
        (
          await run(process.execPath, args, repositoryRoot, {
            HASHED_VALUE: "two",
            PASSED_VALUE: "visible",
          })
        ).stdout,
      ).toContain("cache miss");
      await writeFile(`${directory}/global.txt`, "included change\n");
      expect(
        (
          await run(process.execPath, args, repositoryRoot, {
            HASHED_VALUE: "two",
            PASSED_VALUE: "visible",
          })
        ).stdout,
      ).toContain("cache miss");
      expect(
        await readFile(
          `${directory}/packages/library/.turbo/turbo-build.log`,
          "utf8",
        ),
      ).toContain("two:visible");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);

  it("honors NO_COLOR and rejects Cargo sccache before task execution", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as Record<string, unknown>;
      configuration.futureFlags = { experimentalCargoSccache: true };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const result = await run(
        process.execPath,
        [candidateEntrypoint, "run", "build", "--cwd", directory],
        repositoryRoot,
        { NO_COLOR: "1" },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("futureFlags.experimentalCargoSccache");
      expect(result.stderr).not.toContain("\u001B[");
      await expect(
        lstat(`${directory}/packages/app/.turbo/turbo-build.log`),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("passes command-injection strings as task arguments without shell evaluation", async () => {
    const directory = await makeFixture();
    const marker = `${directory}/injected`;
    try {
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "--cwd",
          directory,
          "--filter",
          "synthetic-library",
          "--no-cache",
          "--",
          `$(touch ${marker})`,
          `;touch ${marker}`,
        ],
        repositoryRoot,
      );
      expect(result.exitCode).toBe(0);
      await expect(lstat(marker)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("applies CLI over environment over configuration precedence for environment modes", async () => {
    const directory = await makeFixture();
    try {
      const manifestPath = `${directory}/packages/library/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.build =
        'node -e "process.stdout.write(String(process.env.CORE_TEST_SECRET))"';
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const common = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--filter",
        "synthetic-library",
        "--no-cache",
      ];
      const loose = await run(process.execPath, common, repositoryRoot, {
        CORE_TEST_SECRET: "visible",
        TURBO_ENV_MODE: "loose",
      });
      expect(loose.stdout).toContain("visible");
      const strict = await run(
        process.execPath,
        [...common, "--env-mode", "strict"],
        repositoryRoot,
        { CORE_TEST_SECRET: "visible", TURBO_ENV_MODE: "loose" },
      );
      expect(strict.stdout).not.toContain("visible");
      expect(strict.exitCode).toBe(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("requires a package-manager declaration unless inference is enabled", async () => {
    const directory = await makeFixture();
    try {
      const manifestPath = `${directory}/package.json`;
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as Record<string, unknown>;
      delete manifest.packageManager;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const common = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--filter",
        "synthetic-library",
        "--no-cache",
      ];
      const rejected = await run(process.execPath, common, repositoryRoot);
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stderr).toContain("packageManager must be declared");
      const inferred = await run(
        process.execPath,
        [...common, "--dangerously-disable-package-manager-check"],
        repositoryRoot,
      );
      expect(inferred.exitCode).toBe(0);
      expect(inferred.stdout).toContain("library build");
      manifest.packageManager = "pnpmn@10";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const invalid = await run(process.execPath, common, repositoryRoot);
      expect(invalid.exitCode).not.toBe(0);
      expect(invalid.stderr).toContain(
        "unsupported package manager identity: pnpmn@10",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("executes root tasks through the //# namespace", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      configuration.tasks["//#root-build"] = { cache: false };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const manifestPath = `${directory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts["root-build"] =
        "node -e \"console.log('root namespace build')\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "//#root-build",
          "--cwd",
          directory,
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("root namespace build");
      expect(result.stdout).not.toContain("app build");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("runs dependency graphs without reading unfinished outcomes in parallel mode", async () => {
    const directory = await makeFixture();
    try {
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "--cwd",
          directory,
          "--parallel",
          "--concurrency=2",
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("library build");
      expect(result.stdout).toContain("app build");
      expect(result.stderr).not.toContain("TypeError");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("implements never and always continue modes", async () => {
    const directory = await makeFixture();
    try {
      for (const packageName of ["app", "library"]) {
        const manifestPath = `${directory}/packages/${packageName}/package.json`;
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          scripts: Record<string, string>;
        };
        manifest.scripts.fail = `node -e "console.log('${packageName} failed'); process.exit(7)"`;
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      const common = [
        candidateEntrypoint,
        "run",
        "fail",
        "--cwd",
        directory,
        "--no-cache",
        "--concurrency",
        "1",
      ];
      const stopped = await run(process.execPath, common, repositoryRoot);
      expect(stopped.exitCode).not.toBe(0);
      expect(stopped.stdout).toContain("app failed");
      expect(stopped.stdout).not.toContain("library failed");
      const continued = await run(
        process.execPath,
        [...common, "--continue=always"],
        repositoryRoot,
      );
      expect(continued.exitCode).not.toBe(0);
      expect(continued.stdout).toContain("app failed");
      expect(continued.stdout).toContain("library failed");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("uses task inputs for affected selection when the future flag is enabled", async () => {
    await mkdir(`${repositoryRoot}/.turbo`, { recursive: true });
    const directory = await mkdtemp(
      join(repositoryRoot, ".turbo/turbo-ts-affected-"),
    );
    await cp(fixtureRoot, directory, { recursive: true });
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        tasks: Record<string, { inputs?: Array<string> }>;
      };
      configuration.futureFlags = { affectedUsingTaskInputs: true };
      configuration.tasks.build!.inputs = ["$TURBO_DEFAULT$", "!README.md"];
      configuration.tasks["//#root-check"] = {
        inputs: ["$TURBO_ROOT$/packages/**"],
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const rootManifestPath = `${directory}/package.json`;
      const rootManifest = JSON.parse(
        await readFile(rootManifestPath, "utf8"),
      ) as { scripts: Record<string, string> };
      rootManifest.scripts["root-check"] =
        "node -e \"console.log('root affected check')\"";
      await writeFile(
        rootManifestPath,
        `${JSON.stringify(rootManifest, null, 2)}\n`,
      );
      await writeFile(`${directory}/packages/library/README.md`, "first\n");
      for (const args of [
        ["init"],
        ["config", "user.email", "synthetic@example.test"],
        ["config", "user.name", "Synthetic Fixture"],
        ["add", "."],
        ["commit", "-m", "fixture base"],
      ]) {
        const git = await run("git", args, directory);
        expect(git.exitCode, `${args.join(" ")}: ${git.stderr}`).toBe(0);
      }
      await writeFile(`${directory}/packages/library/README.md`, "second\n");
      expect((await run("git", ["add", "."], directory)).exitCode).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "readme only"], directory)).exitCode,
      ).toBe(0);
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "--cwd",
          directory,
          "--affected",
          "--no-cache",
        ],
        repositoryRoot,
        { TURBO_SCM_BASE: "HEAD~1", TURBO_SCM_HEAD: "HEAD" },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("library build");
      expect(result.stdout).not.toContain("app build");
      const rootResult = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "//#root-check",
          "--cwd",
          directory,
          "--affected",
          "--no-cache",
        ],
        repositoryRoot,
        { TURBO_SCM_BASE: "HEAD~1", TURBO_SCM_HEAD: "HEAD" },
      );
      expect(rootResult.exitCode).toBe(0);
      expect(rootResult.stdout).toContain("root affected check");
      await writeFile(
        `${directory}/packages/library/source.txt`,
        "changed library input\n",
      );
      expect((await run("git", ["add", "."], directory)).exitCode).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "library input"], directory))
          .exitCode,
      ).toBe(0);
      const dependencyResult = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "--cwd",
          directory,
          "--affected",
          "--no-cache",
        ],
        repositoryRoot,
        { TURBO_SCM_BASE: "HEAD~1", TURBO_SCM_HEAD: "HEAD" },
      );
      expect(dependencyResult.exitCode).toBe(0);
      expect(dependencyResult.stdout).toContain("library build");
      expect(dependencyResult.stdout).toContain("app build");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("applies ordered negations in structured task inputs", async () => {
    const directory = await mkdtemp(join(packageRoot, "turbo-ts-inputs-"));
    await cp(fixtureRoot, directory, { recursive: true });
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        tasks: Record<string, unknown>;
      };
      configuration.futureFlags = { affectedUsingTaskInputs: true };
      configuration.tasks.build = {
        inputs: [
          {
            globs: ["**", "!generated/**"],
            withDefaults: false,
          },
        ],
        outputs: ["dist/**"],
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const packageDirectory = `${directory}/packages/library`;
      await mkdir(`${packageDirectory}/generated`, { recursive: true });
      await writeFile(`${packageDirectory}/source.txt`, "first\n");
      await writeFile(`${packageDirectory}/generated/value.txt`, "first\n");
      for (const args of [
        ["init"],
        ["config", "user.email", "synthetic@example.test"],
        ["config", "user.name", "Synthetic Fixture"],
        ["add", "."],
        ["commit", "-m", "fixture base"],
      ]) {
        const git = await run("git", args, directory);
        expect(git.exitCode, `${args.join(" ")}: ${git.stderr}`).toBe(0);
      }
      const computeHash = async () => {
        const model = await Effect.runPromise(
          Effect.gen(function* () {
            const rootConfiguration = yield* loadRootConfiguration(directory);
            return yield* discoverRepository(directory, rootConfiguration);
          }).pipe(Effect.provide(nodeFoundationLayer)),
        );
        const library = model.packagesByName.get("synthetic-library")!;
        const graph = buildTaskGraph(model, [library], ["build"], false);
        return Effect.runPromise(
          hashTask(
            model,
            graph.nodes.get("synthetic-library#build")!,
            [],
            true,
            [],
            `${directory}/.turbo/cache`,
          ).pipe(Effect.provide(nodeFoundationLayer)),
        );
      };
      const initialHash = await computeHash();
      expect(initialHash.inputFiles).toContain("source.txt");
      expect(initialHash.inputFiles).not.toContain("generated/value.txt");
      const cachedArgs = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--filter=synthetic-library",
        "--output-logs=hash-only",
      ];
      expect(
        (await run(process.execPath, cachedArgs, repositoryRoot)).stdout,
      ).toContain("cache miss");
      await writeFile(`${packageDirectory}/generated/value.txt`, "second\n");
      expect(
        (
          await run(
            "git",
            ["add", "packages/library/generated/value.txt"],
            directory,
          )
        ).exitCode,
      ).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "generated output"], directory))
          .exitCode,
      ).toBe(0);
      expect((await computeHash()).hash).toBe(initialHash.hash);
      expect(
        (await run(process.execPath, cachedArgs, repositoryRoot)).stdout,
      ).toContain("cache hit");
      const excludedAffected = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "--cwd",
          directory,
          "--affected",
          "--no-cache",
        ],
        repositoryRoot,
        { TURBO_SCM_BASE: "HEAD~1", TURBO_SCM_HEAD: "HEAD" },
      );
      expect(excludedAffected.exitCode).toBe(0);
      expect(excludedAffected.stdout).not.toContain("library build");
      expect(excludedAffected.stdout).not.toContain("app build");

      await writeFile(`${packageDirectory}/source.txt`, "second\n");
      expect(
        (await run("git", ["add", "packages/library/source.txt"], directory))
          .exitCode,
      ).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "source input"], directory))
          .exitCode,
      ).toBe(0);
      expect((await computeHash()).hash).not.toBe(initialHash.hash);
      expect(
        (await run(process.execPath, cachedArgs, repositoryRoot)).stdout,
      ).toContain("cache miss");
      const includedAffected = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "--cwd",
          directory,
          "--affected",
          "--no-cache",
        ],
        repositoryRoot,
        { TURBO_SCM_BASE: "HEAD~1", TURBO_SCM_HEAD: "HEAD" },
      );
      expect(includedAffected.exitCode).toBe(0);
      expect(includedAffected.stdout).toContain("library build");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);

  it("selects cross-workspace owners from effective task inputs", async () => {
    await mkdir(`${repositoryRoot}/.turbo`, { recursive: true });
    const directory = await mkdtemp(
      join(repositoryRoot, ".turbo/turbo-ts-cross-workspace-affected-"),
    );
    await cp(fixtureRoot, directory, { recursive: true });
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        global?: Record<string, unknown>;
        tasks: Record<string, unknown>;
      };
      configuration.futureFlags = {
        affectedUsingTaskInputs: true,
        filterUsingTasks: true,
        globalConfiguration: true,
      };
      configuration.global = { inputs: ["packages/app/config/**"] };
      configuration.tasks.check = {
        cache: false,
        inputs: ["local-only/**"],
      };
      configuration.tasks.negated = {
        cache: false,
        inputs: ["!$TURBO_ROOT$/packages/app/config/**"],
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      for (const packageName of ["app", "library"]) {
        const manifestPath = `${directory}/packages/${packageName}/package.json`;
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          scripts: Record<string, string>;
        };
        manifest.scripts.check = `node -e "console.log('${packageName} check')"`;
        manifest.scripts.negated = `node -e "console.log('${packageName} negated')"`;
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      await mkdir(`${directory}/packages/app/config`, { recursive: true });
      await writeFile(`${directory}/packages/app/config/value.txt`, "first\n");
      for (const args of [
        ["init"],
        ["config", "user.email", "synthetic@example.test"],
        ["config", "user.name", "Synthetic Fixture"],
        ["add", "."],
        ["commit", "-m", "fixture base"],
      ]) {
        const git = await run("git", args, directory);
        expect(git.exitCode, `${args.join(" ")}: ${git.stderr}`).toBe(0);
      }
      await writeFile(`${directory}/packages/app/config/value.txt`, "second\n");
      expect((await run("git", ["add", "."], directory)).exitCode).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "shared input"], directory))
          .exitCode,
      ).toBe(0);
      const affected = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "check",
          "--cwd",
          directory,
          "--affected",
          "--no-cache",
        ],
        repositoryRoot,
        { TURBO_SCM_BASE: "HEAD~1", TURBO_SCM_HEAD: "HEAD" },
      );
      expect(affected.exitCode).toBe(0);
      expect(affected.stdout).toContain("app check");
      expect(affected.stdout).toContain("library check");
      const filtered = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "check",
          "--cwd",
          directory,
          "--filter=[HEAD~1]",
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(filtered.exitCode).toBe(0);
      expect(filtered.stdout).toContain("app check");
      expect(filtered.stdout).toContain("library check");
      const negated = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "negated",
          "--cwd",
          directory,
          "--affected",
          "--no-cache",
        ],
        repositoryRoot,
        { TURBO_SCM_BASE: "HEAD~1", TURBO_SCM_HEAD: "HEAD" },
      );
      expect(negated.exitCode).toBe(0);
      expect(negated.stdout).not.toContain("app negated");
      expect(negated.stdout).not.toContain("library negated");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);

  it("preserves ellipsis traversal in task-aware Git filters", async () => {
    await mkdir(`${repositoryRoot}/.turbo`, { recursive: true });
    const directory = await mkdtemp(
      join(repositoryRoot, ".turbo/turbo-ts-task-filter-traversal-"),
    );
    await cp(fixtureRoot, directory, { recursive: true });
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        tasks: Record<string, unknown>;
      };
      configuration.futureFlags = { filterUsingTasks: true };
      configuration.tasks.check = {
        cache: false,
        inputs: ["source.txt"],
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      for (const packageName of ["app", "library"]) {
        const packageDirectory = `${directory}/packages/${packageName}`;
        const manifestPath = `${packageDirectory}/package.json`;
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          scripts: Record<string, string>;
        };
        manifest.scripts.check = `node -e "console.log('${packageName} check')"`;
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        await writeFile(`${packageDirectory}/source.txt`, "first\n");
      }
      for (const args of [
        ["init"],
        ["config", "user.email", "synthetic@example.test"],
        ["config", "user.name", "Synthetic Fixture"],
        ["add", "."],
        ["commit", "-m", "fixture base"],
      ]) {
        const git = await run("git", args, directory);
        expect(git.exitCode, `${args.join(" ")}: ${git.stderr}`).toBe(0);
      }
      const execute = (filter: string) =>
        run(
          process.execPath,
          [
            candidateEntrypoint,
            "run",
            "check",
            "--cwd",
            directory,
            `--filter=${filter}`,
            "--only",
            "--no-cache",
          ],
          repositoryRoot,
        );

      await writeFile(`${directory}/packages/library/source.txt`, "second\n");
      expect((await run("git", ["add", "."], directory)).exitCode).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "library input"], directory))
          .exitCode,
      ).toBe(0);
      const plain = await execute("[HEAD~1]");
      expect(plain.exitCode).toBe(0);
      expect(plain.stdout).toContain("library check");
      expect(plain.stdout).not.toContain("app check");
      const dependents = await execute("...[HEAD~1]");
      expect(dependents.exitCode).toBe(0);
      expect(dependents.stdout).toContain("library check");
      expect(dependents.stdout).toContain("app check");

      await writeFile(`${directory}/packages/app/source.txt`, "second\n");
      expect((await run("git", ["add", "."], directory)).exitCode).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "app input"], directory)).exitCode,
      ).toBe(0);
      const dependencies = await execute("[HEAD~1]...");
      expect(dependencies.exitCode).toBe(0);
      expect(dependencies.stdout).toContain("app check");
      expect(dependencies.stdout).toContain("library check");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);

  it("applies negative Git ranges after task-input selection", async () => {
    await mkdir(`${repositoryRoot}/.turbo`, { recursive: true });
    const directory = await mkdtemp(
      join(repositoryRoot, ".turbo/turbo-ts-negative-range-"),
    );
    await cp(fixtureRoot, directory, { recursive: true });
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        tasks: Record<string, unknown>;
      };
      configuration.futureFlags = { filterUsingTasks: true };
      configuration.tasks.check = { cache: false };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      for (const packageName of ["app", "library"]) {
        const packageDirectory = `${directory}/packages/${packageName}`;
        const manifestPath = `${packageDirectory}/package.json`;
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          scripts: Record<string, string>;
        };
        manifest.scripts.check = `node -e "console.log('${packageName} check')"`;
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        await writeFile(`${packageDirectory}/source.txt`, "first\n");
      }
      for (const args of [
        ["init"],
        ["config", "user.email", "synthetic@example.test"],
        ["config", "user.name", "Synthetic Fixture"],
        ["add", "."],
        ["commit", "-m", "fixture base"],
      ]) {
        const git = await run("git", args, directory);
        expect(git.exitCode, `${args.join(" ")}: ${git.stderr}`).toBe(0);
      }
      await writeFile(`${directory}/packages/app/source.txt`, "second\n");
      expect((await run("git", ["add", "."], directory)).exitCode).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "app input"], directory)).exitCode,
      ).toBe(0);
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "check",
          "--cwd",
          directory,
          "--filter=![HEAD~1]",
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("app check");
      expect(result.stdout).toContain("library check");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("retains an affected owner when only a with companion input changed", async () => {
    await mkdir(`${repositoryRoot}/.turbo`, { recursive: true });
    const directory = await mkdtemp(
      join(repositoryRoot, ".turbo/turbo-ts-affected-with-"),
    );
    await cp(fixtureRoot, directory, { recursive: true });
    const packageDirectory = `${directory}/packages/library`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        tasks: Record<string, unknown>;
      };
      configuration.futureFlags = { affectedUsingTaskInputs: true };
      configuration.tasks.check = {
        cache: false,
        inputs: ["tests/**"],
        with: ["serve"],
      };
      configuration.tasks.serve = {
        cache: false,
        inputs: ["server/**"],
        persistent: true,
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.serve =
        "node -e \"require('node:fs').writeFileSync('serve.ready','1'); setInterval(()=>{},1000)\"";
      manifest.scripts.check =
        "node -e \"const fs=require('node:fs'); const started=Date.now(); const timer=setInterval(()=>{if(fs.existsSync('serve.ready')){fs.writeFileSync('owner.done','1'); clearInterval(timer)}else if(Date.now()-started>3000){process.exit(7)}},10)\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await mkdir(`${packageDirectory}/tests`, { recursive: true });
      await mkdir(`${packageDirectory}/server`, { recursive: true });
      await writeFile(`${packageDirectory}/tests/input.txt`, "stable\n");
      await writeFile(`${packageDirectory}/server/input.txt`, "first\n");
      for (const args of [
        ["init"],
        ["config", "user.email", "synthetic@example.test"],
        ["config", "user.name", "Synthetic Fixture"],
        ["add", "."],
        ["commit", "-m", "fixture base"],
      ]) {
        const git = await run("git", args, directory);
        expect(git.exitCode, `${args.join(" ")}: ${git.stderr}`).toBe(0);
      }
      await writeFile(`${packageDirectory}/server/input.txt`, "second\n");
      expect((await run("git", ["add", "."], directory)).exitCode).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "server input"], directory))
          .exitCode,
      ).toBe(0);
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "check",
          "--cwd",
          directory,
          "--affected",
          "--no-cache",
        ],
        repositoryRoot,
        { TURBO_SCM_BASE: "HEAD~1", TURBO_SCM_HEAD: "HEAD" },
      );
      expect(result.exitCode).toBe(0);
      expect(await readFile(`${packageDirectory}/owner.done`, "utf8")).toBe(
        "1",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("rejects dependency-output inputs in root and workspace configuration", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, Record<string, unknown>> };
      configuration.tasks.build!.inputs = [
        {
          mode: "dependencyOutputs",
          from: ["^build"],
          globs: ["dist/**"],
        },
      ];
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const args = [candidateEntrypoint, "run", "build", "--cwd", directory];
      const rootResult = await run(process.execPath, args, repositoryRoot);
      expect(rootResult.exitCode).not.toBe(0);
      expect(rootResult.stderr).toContain(
        "dependencyOutputs inputs are not implemented",
      );

      delete configuration.tasks.build!.inputs;
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const workspacePath = `${directory}/packages/app/turbo.json`;
      const workspace = JSON.parse(await readFile(workspacePath, "utf8")) as {
        tasks: Record<string, Record<string, unknown>>;
      };
      workspace.tasks.build!.inputs = [
        {
          mode: "dependencyOutputs",
          from: ["^build"],
          globs: ["dist/**"],
        },
      ];
      await writeFile(workspacePath, `${JSON.stringify(workspace, null, 2)}\n`);
      const workspaceResult = await run(process.execPath, args, repositoryRoot);
      expect(workspaceResult.exitCode).not.toBe(0);
      expect(workspaceResult.stderr).toContain(
        "dependencyOutputs inputs are not implemented",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("rejects unknown configuration keys before execution", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as Record<string, unknown>;
      configuration.unknownRuntimeKey = true;
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const result = await run(
        process.execPath,
        [candidateEntrypoint, "run", "build", "--cwd", directory],
        repositoryRoot,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("unknown key: unknownRuntimeKey");
      delete configuration.unknownRuntimeKey;
      configuration.remoteCache = { unknownRemoteKey: true };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const nested = await run(
        process.execPath,
        [candidateEntrypoint, "run", "build", "--cwd", directory],
        repositoryRoot,
      );
      expect(nested.exitCode).not.toBe(0);
      expect(nested.stderr).toContain("unknown key: unknownRemoteKey");
      delete configuration.remoteCache;
      configuration.pipeline = configuration.tasks;
      delete configuration.tasks;
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const deprecatedPipeline = await run(
        process.execPath,
        [candidateEntrypoint, "run", "build", "--cwd", directory],
        repositoryRoot,
      );
      expect(deprecatedPipeline.exitCode).not.toBe(0);
      expect(deprecatedPipeline.stderr).toContain("unknown key: pipeline");
      await expect(
        lstat(`${directory}/packages/app/.turbo/turbo-build.log`),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);
});

describe("cache interoperability and safety", () => {
  it("counts cache sidecars and orphaned sidecars during size eviction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-cache-size-"));
    const cacheDirectory = `${directory}/cache`;
    const hash = "0123456789abcdef";
    try {
      await Effect.runPromise(
        writeLocalCache(
          { directory: cacheDirectory },
          hash,
          [
            {
              path: "packages/app/out.txt",
              contents: new TextEncoder().encode("cached"),
              mode: 0o644,
              modifiedSeconds: 1,
            },
          ],
          1,
        ).pipe(Effect.provide(nodeFoundationLayer)),
      );
      const archivePath = `${cacheDirectory}/${hash}.tar.zst`;
      const manifestPath = `${cacheDirectory}/${hash}-manifest.json`;
      const metadataPath = `${cacheDirectory}/${hash}-meta.json`;
      const archiveSize = (await lstat(archivePath)).size;
      const sidecarSize =
        (await lstat(manifestPath)).size + (await lstat(metadataPath)).size;
      await Effect.runPromise(
        evictLocalCache({
          directory: cacheDirectory,
          maxSizeBytes: archiveSize + sidecarSize - 1,
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      await expect(lstat(archivePath)).rejects.toThrow();
      await expect(lstat(manifestPath)).rejects.toThrow();
      await expect(lstat(metadataPath)).rejects.toThrow();

      const orphanHash = "fedcba9876543210";
      const orphanManifest = `${cacheDirectory}/${orphanHash}-manifest.json`;
      const orphanMetadata = `${cacheDirectory}/${orphanHash}-meta.json`;
      await writeFile(orphanManifest, "manifest");
      await writeFile(orphanMetadata, "metadata");
      await Effect.runPromise(
        evictLocalCache({ directory: cacheDirectory, maxSizeBytes: 1 }).pipe(
          Effect.provide(nodeFoundationLayer),
        ),
      );
      await expect(lstat(orphanManifest)).rejects.toThrow();
      await expect(lstat(orphanMetadata)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("reads official Turbo local archives", async () => {
    const directory = await makeFixture();
    try {
      const official = await run(
        officialExecutable,
        [
          "run",
          "build",
          "--cwd",
          directory,
          "--dangerously-disable-package-manager-check",
          "--output-logs=hash-only",
        ],
        repositoryRoot,
        { TURBO_TELEMETRY_DISABLED: "1", NO_COLOR: "1" },
      );
      expect(official.exitCode).toBe(0);
      await rm(`${directory}/packages/library/.turbo`, {
        force: true,
        recursive: true,
      });
      const restored = await Effect.runPromise(
        restoreLocalCache(
          directory,
          { directory: `${directory}/.turbo/cache` },
          "97b263bfd7db31de",
        ).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(restored).toBe(true);
      expect(
        await readFile(
          `${directory}/packages/library/.turbo/turbo-build.log`,
          "utf8",
        ),
      ).toContain("library build");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("writes local archives that official Turbo consumes", async () => {
    const directory = await makeFixture();
    try {
      const now = Date.now() / 1_000;
      await Effect.runPromise(
        Effect.all(
          [
            writeLocalCache(
              { directory: `${directory}/.turbo/cache` },
              "97b263bfd7db31de",
              [
                {
                  path: "packages/library/.turbo/turbo-build.log",
                  contents: new TextEncoder().encode(
                    "candidate library cache\n",
                  ),
                  mode: 0o644,
                  modifiedSeconds: now,
                },
              ],
              1,
            ),
            writeLocalCache(
              { directory: `${directory}/.turbo/cache` },
              "569ade98bac3b054",
              [
                {
                  path: "packages/app/.turbo/turbo-build.log",
                  contents: new TextEncoder().encode("candidate app cache\n"),
                  mode: 0o644,
                  modifiedSeconds: now,
                },
              ],
              1,
            ),
          ],
          { concurrency: 2 },
        ).pipe(Effect.provide(nodeFoundationLayer)),
      );
      const official = await run(
        officialExecutable,
        [
          "run",
          "build",
          "--cwd",
          directory,
          "--dangerously-disable-package-manager-check",
          "--output-logs=hash-only",
        ],
        repositoryRoot,
        { TURBO_TELEMETRY_DISABLED: "1", NO_COLOR: "1" },
      );
      expect(official.exitCode).toBe(0);
      expect(stripVTControlCharacters(official.stdout)).toContain(
        "2 cached, 2 total",
      );
      expect(
        await readFile(
          `${directory}/packages/app/.turbo/turbo-build.log`,
          "utf8",
        ),
      ).toBe("candidate app cache\n");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it(evidenceId.coreCache, async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-cache-race-"));
    const cacheDirectory = `${directory}/.turbo/cache`;
    const entry = {
      path: "packages/app/out.txt",
      contents: new TextEncoder().encode("safe"),
      mode: 0o644,
      modifiedSeconds: 1,
    };
    try {
      await Effect.runPromise(
        Effect.all(
          Array.from({ length: 12 }, () =>
            writeLocalCache(
              { directory: cacheDirectory },
              "0123456789abcdef",
              [entry],
              1,
            ),
          ),
          { concurrency: "unbounded" },
        ).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(
        await Effect.runPromise(
          restoreLocalCache(
            directory,
            { directory: cacheDirectory },
            "0123456789abcdef",
          ).pipe(Effect.provide(nodeFoundationLayer)),
        ),
      ).toBe(true);
      await writeFile(`${cacheDirectory}/0123456789abcdef.tar.zst`, "corrupt");
      expect(
        await Effect.runPromise(
          restoreLocalCache(
            directory,
            { directory: cacheDirectory },
            "0123456789abcdef",
          ).pipe(Effect.provide(nodeFoundationLayer)),
        ),
      ).toBe(false);
      await expect(
        lstat(`${cacheDirectory}/0123456789abcdef.tar.zst`),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("reclaims cache writer locks left by terminated writers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-stale-lock-"));
    const cacheDirectory = `${directory}/cache`;
    const hash = "1111222233334444";
    try {
      await mkdir(cacheDirectory, { recursive: true });
      const lockPath = `${cacheDirectory}/${hash}.turbo-ts.lock`;
      await writeFile(
        lockPath,
        JSON.stringify({
          owner: "00000000-0000-7000-8000-000000000000",
          createdAt: 0,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60 * 1_000);
      await utimes(lockPath, staleTime, staleTime);
      await Effect.runPromise(
        writeLocalCache(
          { directory: cacheDirectory },
          hash,
          [
            {
              path: "packages/app/out.txt",
              contents: new TextEncoder().encode("recovered"),
              mode: 0o644,
              modifiedSeconds: 1,
            },
          ],
          1,
        ).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(
        await Effect.runPromise(
          restoreLocalCache(
            directory,
            { directory: cacheDirectory },
            hash,
          ).pipe(Effect.provide(nodeFoundationLayer)),
        ),
      ).toBe(true);
      expect(await readFile(`${directory}/packages/app/out.txt`, "utf8")).toBe(
        "recovered",
      );
      await expect(lstat(lockPath)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("restores local cache entries through a symlinked repository root", async () => {
    if (process.platform === "win32") return;
    const container = await mkdtemp(join(tmpdir(), "turbo-ts-root-link-"));
    const directory = `${container}/repository`;
    const linkedRoot = `${container}/linked-repository`;
    const cacheDirectory = `${container}/cache`;
    try {
      await mkdir(directory, { recursive: true });
      await Effect.runPromise(
        writeLocalCache(
          { directory: cacheDirectory },
          "2222333344445555",
          [
            {
              path: "packages/app/out.txt",
              contents: new TextEncoder().encode("linked"),
              mode: 0o644,
              modifiedSeconds: 1,
            },
          ],
          1,
        ).pipe(Effect.provide(nodeFoundationLayer)),
      );
      await symlink(directory, linkedRoot);
      expect(
        await Effect.runPromise(
          restoreLocalCache(
            linkedRoot,
            { directory: cacheDirectory },
            "2222333344445555",
          ).pipe(Effect.provide(nodeFoundationLayer)),
        ),
      ).toBe(true);
      expect(await readFile(`${directory}/packages/app/out.txt`, "utf8")).toBe(
        "linked",
      );
    } finally {
      await rm(container, { force: true, recursive: true });
    }
  });

  it("rejects restoration through escaping symlinks", async () => {
    if (process.platform === "win32") {
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "turbo-ts-outside-"));
    const cacheDirectory = `${directory}/.turbo/cache`;
    try {
      await Effect.runPromise(
        writeLocalCache(
          { directory: cacheDirectory },
          "fedcba9876543210",
          [
            {
              path: "packages/app/out.txt",
              contents: new TextEncoder().encode("escape"),
              mode: 0o644,
              modifiedSeconds: 1,
            },
          ],
          1,
        ).pipe(Effect.provide(nodeFoundationLayer)),
      );
      await symlink(outside, `${directory}/packages`);
      expect(
        await Effect.runPromise(
          restoreLocalCache(
            directory,
            { directory: cacheDirectory },
            "fedcba9876543210",
          ).pipe(Effect.provide(nodeFoundationLayer)),
        ),
      ).toBe(false);
      await expect(lstat(`${outside}/app`)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("falls back to execution when remote cache restoration fails", async () => {
    const directory = await makeFixture();
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, {
          "content-type": "application/octet-stream",
        });
        response.end("corrupt remote artifact");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("missing loopback address");
    }
    try {
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "--cwd",
          directory,
          "--filter=synthetic-library",
          "--cache=remote:r",
        ],
        repositoryRoot,
        { TURBO_API: `http://127.0.0.1:${address.port}` },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("library build");
      expect(result.stderr).toContain("remote cache restore failed");
      expect(result.stderr).toContain("executing task locally");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("preserves task success when remote cache upload fails", async () => {
    const directory = await makeFixture();
    let uploads = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        uploads += 1;
        response.writeHead(403);
        response.end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("missing loopback address");
    }
    try {
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "--cwd",
          directory,
          "--filter=synthetic-library",
          "--cache=remote:w",
          "--output-logs=hash-only",
        ],
        repositoryRoot,
        { TURBO_API: `http://127.0.0.1:${address.port}` },
      );
      expect(result.exitCode).toBe(0);
      expect(uploads).toBe(1);
      expect(result.stderr).toContain("remote cache upload failed");
      expect(result.stderr).toContain("preserving successful task result");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("rejects remote restoration before creating directories through escaping symlinks", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-remote-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "turbo-ts-remote-outside-"));
    let artifact = new Uint8Array();
    const server = createServer((request, response) => {
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.method === "PUT") {
          artifact = new Uint8Array(Buffer.concat(chunks));
          response.writeHead(201);
        } else {
          response.writeHead(200, {
            "content-type": "application/octet-stream",
          });
        }
        response.end(request.method === "PUT" ? undefined : artifact);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("missing loopback address");
    }
    const options = {
      apiUrl: `http://127.0.0.1:${address.port}`,
      timeoutMilliseconds: 5_000,
      uploadTimeoutMilliseconds: 5_000,
      preflight: false,
      requireSignature: false,
    };
    try {
      await Effect.runPromise(
        writeRemoteCache(
          options,
          "abcdefabcdefabcd",
          [
            {
              path: "packages/app/out.txt",
              contents: new TextEncoder().encode("escape"),
              mode: 0o644,
              modifiedSeconds: 1,
            },
          ],
          1,
        ).pipe(Effect.provide(nodeFoundationLayer)),
      );
      await symlink(outside, `${directory}/packages`);
      await expect(
        Effect.runPromise(
          restoreRemoteCache(directory, options, "abcdefabcdefabcd").pipe(
            Effect.provide(nodeFoundationLayer),
          ),
        ),
      ).rejects.toThrow(/escaping symlink/);
      await expect(lstat(`${outside}/app`)).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("round trips signed remote artifacts through a loopback service", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-remote-"));
    const linkedRoot = `${directory}-link`;
    const requestPaths: Array<string> = [];
    let artifact = new Uint8Array();
    let tag = "";
    const server = createServer((request, response) => {
      requestPaths.push(
        new URL(request.url ?? "/", "http://127.0.0.1").pathname,
      );
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.method === "PUT") {
          artifact = new Uint8Array(Buffer.concat(chunks));
          tag = String(request.headers["x-artifact-tag"] ?? "");
          response.writeHead(201);
          response.end();
        } else {
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "x-artifact-tag": tag,
          });
          response.end(artifact);
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("missing loopback address");
    }
    const options = {
      apiUrl: `http://127.0.0.1:${address.port}/cache/api`,
      timeoutMilliseconds: 5_000,
      uploadTimeoutMilliseconds: 5_000,
      preflight: false,
      requireSignature: true,
      signatureKey: "0123456789abcdef0123456789abcdef",
      token: "dummy-token",
      teamId: "team_synthetic",
    };
    try {
      await Effect.runPromise(
        writeRemoteCache(
          options,
          "0011223344556677",
          [
            {
              path: "packages/app/remote.txt",
              contents: new TextEncoder().encode("remote"),
              mode: 0o644,
              modifiedSeconds: 1,
            },
          ],
          1,
        ).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(artifact.length).toBeGreaterThan(0);
      expect(tag).toMatch(/^[0-9a-f]{64}$/);
      const restoreRoot = process.platform === "win32" ? directory : linkedRoot;
      if (process.platform !== "win32") {
        await symlink(directory, linkedRoot);
      }
      expect(
        await Effect.runPromise(
          restoreRemoteCache(restoreRoot, options, "0011223344556677").pipe(
            Effect.provide(nodeFoundationLayer),
          ),
        ),
      ).toBe(true);
      expect(
        await readFile(`${directory}/packages/app/remote.txt`, "utf8"),
      ).toBe("remote");
      tag = "0".repeat(64);
      await expect(
        Effect.runPromise(
          restoreRemoteCache(restoreRoot, options, "0011223344556677").pipe(
            Effect.provide(nodeFoundationLayer),
          ),
        ),
      ).rejects.toThrow(/signature is invalid/);
      expect(requestPaths).toEqual([
        "/cache/api/v8/artifacts/0011223344556677",
        "/cache/api/v8/artifacts/0011223344556677",
        "/cache/api/v8/artifacts/0011223344556677",
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(linkedRoot, { force: true });
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("retries transient remote cache statuses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-remote-retry-"));
    const attempts = { OPTIONS: 0, GET: 0, PUT: 0 };
    let artifact = new Uint8Array();
    const server = createServer((request, response) => {
      const method = request.method;
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (method !== "OPTIONS" && method !== "GET" && method !== "PUT") {
          response.writeHead(405);
          response.end();
          return;
        }
        attempts[method] += 1;
        if (attempts[method] === 1) {
          response.writeHead(503);
          response.end();
          return;
        }
        if (method === "PUT") {
          artifact = new Uint8Array(Buffer.concat(chunks));
          response.writeHead(201);
          response.end();
          return;
        }
        if (method === "GET") {
          response.writeHead(200, {
            "content-type": "application/octet-stream",
          });
          response.end(artifact);
          return;
        }
        response.writeHead(200);
        response.end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("missing loopback address");
    }
    const options = {
      apiUrl: `http://127.0.0.1:${address.port}`,
      timeoutMilliseconds: 5_000,
      uploadTimeoutMilliseconds: 5_000,
      preflight: true,
      requireSignature: false,
    };
    try {
      await Effect.runPromise(
        writeRemoteCache(
          options,
          "9988776655443322",
          [
            {
              path: "remote.txt",
              contents: new TextEncoder().encode("retried remote cache\n"),
              mode: 0o644,
              modifiedSeconds: 1,
            },
          ],
          1,
        ).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(
        await Effect.runPromise(
          restoreRemoteCache(directory, options, "9988776655443322").pipe(
            Effect.provide(nodeFoundationLayer),
          ),
        ),
      ).toBe(true);
      expect(await readFile(`${directory}/remote.txt`, "utf8")).toBe(
        "retried remote cache\n",
      );
      expect(attempts).toEqual({ OPTIONS: 3, GET: 2, PUT: 2 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("uses the upload timeout independently from the download timeout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-upload-timeout-"));
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        setTimeout(() => {
          response.writeHead(200);
          response.end();
        }, 40);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("missing loopback address");
    }
    try {
      await Effect.runPromise(
        writeRemoteCache(
          {
            apiUrl: `http://127.0.0.1:${address.port}`,
            timeoutMilliseconds: 1,
            uploadTimeoutMilliseconds: 500,
            preflight: false,
            requireSignature: false,
          },
          "3333444455556666",
          [],
          1,
        ).pipe(Effect.provide(nodeFoundationLayer)),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("reads the upload-specific remote cache timeout environment variable", async () => {
    const directory = await makeFixture();
    let uploads = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        uploads += 1;
        setTimeout(() => {
          response.writeHead(201);
          response.end();
        }, 40);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("missing loopback address");
    }
    try {
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "--cwd",
          directory,
          "--filter=synthetic-library",
          "--cache=remote:w",
        ],
        repositoryRoot,
        {
          TURBO_API: `http://127.0.0.1:${address.port}`,
          TURBO_REMOTE_CACHE_TIMEOUT: "0.01",
          TURBO_REMOTE_CACHE_UPLOAD_TIMEOUT: "1",
        },
      );
      expect(result.exitCode).toBe(0);
      expect(uploads).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("lets TURBO_TEAMID override the configured remote-cache team ID", async () => {
    const directory = await makeFixture();
    const teamIds: Array<string | null> = [];
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        teamIds.push(
          new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get(
            "teamId",
          ),
        );
        response.writeHead(201);
        response.end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("missing loopback address");
    }
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as Record<string, unknown>;
      configuration.remoteCache = {
        apiUrl: `http://127.0.0.1:${address.port}`,
        teamId: "team_configured",
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "--cwd",
          directory,
          "--filter=synthetic-library",
          "--cache=remote:w",
        ],
        repositoryRoot,
        { TURBO_TEAMID: "team_environment" },
      );
      expect(result.exitCode).toBe(0);
      expect(teamIds).toEqual(["team_environment"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it(evidenceId.coreDifferential, async () => {
    const directory = await makeFixture();
    const artifacts = new Map<string, Uint8Array>();
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const hash = path.startsWith("/v8/artifacts/")
        ? path.slice("/v8/artifacts/".length)
        : undefined;
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.method === "PUT" && hash !== undefined) {
          artifacts.set(hash, new Uint8Array(Buffer.concat(chunks)));
          response.writeHead(200);
          response.end();
        } else if (request.method === "GET" && hash !== undefined) {
          const artifact = artifacts.get(hash);
          if (artifact === undefined) {
            response.writeHead(404);
            response.end();
          } else {
            response.writeHead(200, {
              "content-type": "application/octet-stream",
              "x-artifact-duration": "1",
            });
            response.end(artifact);
          }
        } else {
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{}");
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("missing loopback address");
    }
    const apiUrl = `http://127.0.0.1:${address.port}`;
    const environment = { TURBO_TELEMETRY_DISABLED: "1", NO_COLOR: "1" };
    const officialArguments = [
      "run",
      "build",
      "--cwd",
      directory,
      "--dangerously-disable-package-manager-check",
      "--remote-only",
      "--api",
      apiUrl,
      "--token",
      "dummy-token",
      "--team",
      "team_synthetic",
      "--output-logs=hash-only",
    ];
    const candidateRemoteOptions = {
      apiUrl,
      timeoutMilliseconds: 5_000,
      uploadTimeoutMilliseconds: 5_000,
      preflight: false,
      requireSignature: false,
      token: "dummy-token",
      teamId: "team_synthetic",
    };
    try {
      const upload = await run(
        officialExecutable,
        officialArguments,
        repositoryRoot,
        environment,
      );
      expect(upload.exitCode).toBe(0);
      expect(artifacts.has("97b263bfd7db31de")).toBe(true);
      expect(artifacts.has("569ade98bac3b054")).toBe(true);

      await rm(`${directory}/packages/library/.turbo`, {
        force: true,
        recursive: true,
      });
      expect(
        await Effect.runPromise(
          restoreRemoteCache(
            directory,
            candidateRemoteOptions,
            "97b263bfd7db31de",
          ).pipe(Effect.provide(nodeFoundationLayer)),
        ),
      ).toBe(true);
      expect(
        await readFile(
          `${directory}/packages/library/.turbo/turbo-build.log`,
          "utf8",
        ),
      ).toContain("library build");

      await writeRemoteCache(
        candidateRemoteOptions,
        "569ade98bac3b054",
        [
          {
            path: "packages/app/.turbo/turbo-build.log",
            contents: new TextEncoder().encode("candidate remote cache\n"),
            mode: 0o644,
            modifiedSeconds: Date.now() / 1_000,
          },
        ],
        1,
      ).pipe(Effect.provide(nodeFoundationLayer), Effect.runPromise);
      await rm(`${directory}/.turbo/cache`, { force: true, recursive: true });
      await rm(`${directory}/packages/app/.turbo`, {
        force: true,
        recursive: true,
      });
      await rm(`${directory}/packages/library/.turbo`, {
        force: true,
        recursive: true,
      });
      const download = await run(
        officialExecutable,
        officialArguments,
        repositoryRoot,
        environment,
      );
      expect(download.exitCode).toBe(0);
      expect(stripVTControlCharacters(download.stdout)).toContain(
        "2 cached, 2 total",
      );
      expect(
        await readFile(
          `${directory}/packages/app/.turbo/turbo-build.log`,
          "utf8",
        ),
      ).toBe("candidate remote cache\n");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { force: true, recursive: true });
    }
  });
});
