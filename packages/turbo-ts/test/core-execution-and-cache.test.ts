import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "@rstest/core";
import { Cause, Effect, Exit, Layer, Stream } from "effect";
import {
  createTarArchive,
  maximumCacheArchiveInputBytes,
  tarBlockSize,
} from "../src/cache/archive.js";
import { parseTarArchiveFile } from "../src/cache/archive-file.js";
import { maximumCacheArtifactBytes } from "../src/cache/limits.js";
import {
  evictLocalCache,
  restoreLocalCache,
  writeLocalCache,
} from "../src/cache/local-cache.js";
import {
  restoreRemoteCache,
  writeRemoteCache,
} from "../src/cache/remote-cache.js";
import {
  type CacheRestoreScope,
  duplicateArchiveEntryDestination,
  restoreArchiveEntries,
} from "../src/cache/restore.js";
import { evidenceId } from "../src/compatibility/ledger.js";
import { loadRootConfiguration } from "../src/config/runtime.js";
import { BoundaryError, CacheError } from "../src/effect/errors.js";
import { nodeFoundationLayer } from "../src/effect/node-layer.js";
import {
  CompressionService,
  DigestService,
  EnvironmentService,
  FileSystemService,
  HttpService,
  ProcessService,
  SigningService,
  TerminalService,
} from "../src/effect/services.js";
import { buildTaskGraph } from "../src/graph/task-graph.js";
import {
  decodeNullDelimitedGitOutput,
  hashTask,
} from "../src/hash/task-hash.js";
import { xxhash64Hex } from "../src/hash/xxhash64.js";
import {
  cargoHomeConfigurationPresent,
  discoverRepository,
} from "../src/repository/model.js";
import {
  executeRun,
  isTaskScopeCacheable,
  makeCachePublicationPermit,
  packageManagerCommand,
  planCargoWorkspaceTasks,
} from "../src/run/engine.js";
import { parseRunArguments } from "../src/run/options.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixtureRoot = `${packageRoot}/test/fixtures/basic-workspace`;
const candidateEntrypoint = `${packageRoot}/dist/bin/turbo-ts.js`;
const officialExecutable = `${repositoryRoot}/node_modules/.bin/turbo`;

const allowCachePaths = (
  ...patterns: ReadonlyArray<string>
): CacheRestoreScope => ({
  pathsToClear: [],
  allowedPathGroups: [{ directory: ".", patterns }],
  regularFilePaths: [],
});

const makeFixture = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "turbo-ts-core-"));
  await cp(fixtureRoot, directory, { recursive: true });
  return directory;
};

const makeGitFixture = async (): Promise<string> => {
  await mkdir(`${repositoryRoot}/.turbo`, { recursive: true });
  const directory = await mkdtemp(
    join(repositoryRoot, ".turbo/turbo-ts-git-fixture-"),
  );
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

  it("rejects a nonexistent explicit working directory", async () => {
    const directory = await makeFixture();
    try {
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "--cwd",
          `${directory}/missing`,
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("working directory does not exist");
      expect(result.stdout).not.toContain("library build");
      expect(result.stdout).not.toContain("app build");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects a regular file as an explicit working directory", async () => {
    const directory = await makeFixture();
    const file = `${directory}/not-a-directory`;
    try {
      await writeFile(file, "not a directory\n");
      const result = await run(
        process.execPath,
        [candidateEntrypoint, "run", "build", "--cwd", file, "--no-cache"],
        repositoryRoot,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("working directory is not a directory");
      expect(result.stdout).not.toContain("library build");
      expect(result.stdout).not.toContain("app build");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("discovers the owning repository from a symlinked working directory", async () => {
    if (process.platform === "win32") return;
    const directory = await makeFixture();
    const linkedPackage = `${directory}-library-link`;
    try {
      await symlink(`${directory}/packages/library`, linkedPackage);
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "--cwd",
          linkedPackage,
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode, result.combinedOutput).toBe(0);
      expect(result.stdout.indexOf("library build")).toBeLessThan(
        result.stdout.indexOf("app build"),
      );
    } finally {
      await rm(linkedPackage, { force: true });
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("streams ordinary task output to logs with bounded diagnostics", async () => {
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      configuration.tasks["large-output"] = { cache: false };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts["large-output"] =
        "node -e \"process.stdout.write('x'.repeat(96 * 1024) + 'END-MARKER\\n'); process.exit(7)\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "large-output",
          "--cwd",
          directory,
          "--filter=synthetic-library",
          "--no-cache",
          "--output-logs=errors-only",
        ],
        repositoryRoot,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("END-MARKER");
      expect(result.stdout.length).toBeLessThan(80 * 1024);
      const log = await readFile(
        `${packageDirectory}/.turbo/turbo-large-output.log`,
        "utf8",
      );
      expect(log.length).toBeGreaterThan(96 * 1024);
      expect(log).toContain("END-MARKER");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("encodes task identifiers into portable single-component log paths", async () => {
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      for (const task of ["lint/types", "lint:types"]) {
        configuration.tasks[task] = { cache: false };
        manifest.scripts[task] = `node -e "console.log('${task}')"`;
      }
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      for (const [task, encoded] of [
        ["lint/types", "lint%002Ftypes"],
        ["lint:types", "lint%003Atypes"],
      ] as const) {
        const result = await run(
          process.execPath,
          [
            candidateEntrypoint,
            "run",
            task,
            "--cwd",
            directory,
            "--filter=synthetic-library",
            "--no-cache",
          ],
          repositoryRoot,
        );
        expect(result.exitCode, result.stderr).toBe(0);
        expect(
          await readFile(
            `${packageDirectory}/.turbo/turbo-${encoded}.log`,
            "utf8",
          ),
        ).toContain(task);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("keeps case-distinct task logs separate", async () => {
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      configuration.tasks.Build = { cache: false };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.build = "node -e \"console.log('lowercase task')\"";
      manifest.scripts.Build = "node -e \"console.log('uppercase task')\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "Build",
          "--cwd",
          directory,
          "--filter=synthetic-library",
          "--concurrency=2",
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode, result.stderr).toBe(0);
      const lowercaseLog = await readFile(
        `${packageDirectory}/.turbo/turbo-build.log`,
        "utf8",
      );
      expect(lowercaseLog).toContain("lowercase task");
      expect(lowercaseLog).not.toContain("uppercase task");
      const uppercaseLog = await readFile(
        `${packageDirectory}/.turbo/turbo-%0042uild.log`,
        "utf8",
      );
      expect(uppercaseLog).toContain("uppercase task");
      expect(uppercaseLog).not.toContain("lowercase task");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("bounds long encoded task-log components with deterministic hashes", async () => {
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    const tasks = [`${"A".repeat(60)}one`, `${"A".repeat(60)}two`];
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      for (const task of tasks) {
        configuration.tasks[task] = { cache: false };
        manifest.scripts[task] = `node -e "console.log('${task}')"`;
      }
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          ...tasks,
          "--cwd",
          directory,
          "--filter=synthetic-library",
          "--concurrency=2",
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode, result.stderr).toBe(0);
      const encodedPrefix = "%0041".repeat(45);
      const names = tasks.map(
        (task) => `turbo-${encodedPrefix}-${xxhash64Hex(task)}.log`,
      );
      expect(new Set(names).size).toBe(2);
      for (const [index, name] of names.entries()) {
        expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
        expect(
          await readFile(`${packageDirectory}/.turbo/${name}`, "utf8"),
        ).toContain(tasks[index]);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("separates logs and cached replay for co-located package scopes", async () => {
    if (process.platform === "win32") return;
    const directory = await makeFixture();
    const commandDirectory = `${directory}/commands`;
    const cargoPackageId = `path+file://${directory}#rust-root@0.1.0`;
    const cargoLog = `${directory}/.turbo/turbo-rust-root%0023build.log`;
    const uvLog = `${directory}/.turbo/turbo-python-root%0023build.log`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        tasks: Record<string, Record<string, unknown>>;
      };
      configuration.futureFlags = {
        ...configuration.futureFlags,
        experimentalCargoWorkspaces: true,
        experimentalPythonWorkspaces: true,
      };
      configuration.tasks.build = {
        ...configuration.tasks.build,
        cache: true,
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await mkdir(`${directory}/src`, { recursive: true });
      await writeFile(
        `${directory}/Cargo.toml`,
        '[package]\nname = "rust-root"\nversion = "0.1.0"\nedition = "2024"\n',
      );
      await writeFile(`${directory}/src/lib.rs`, "pub fn value() {}\n");
      await writeFile(
        `${directory}/Cargo.lock`,
        'version = 4\n\n[[package]]\nname = "rust-root"\nversion = "0.1.0"\n',
      );
      await writeFile(
        `${directory}/pyproject.toml`,
        '[project]\nname = "python-root"\nversion = "0.1.0"\ndependencies = []\n\n[tool.uv.workspace]\nmembers = []\n',
      );
      await writeFile(`${directory}/uv.lock`, "version = 1\nrevision = 1\n");
      await mkdir(commandDirectory, { recursive: true });
      const metadata = JSON.stringify({
        workspace_root: directory,
        workspace_members: [cargoPackageId],
        target_directory: `${directory}/target`,
        packages: [
          {
            id: cargoPackageId,
            name: "rust-root",
            manifest_path: `${directory}/Cargo.toml`,
            dependencies: [],
            targets: [{ kind: ["lib"], name: "rust_root" }],
          },
        ],
      });
      const cargoCommand = `${commandDirectory}/cargo`;
      const uvCommand = `${commandDirectory}/uv`;
      await writeFile(
        cargoCommand,
        `#!/usr/bin/env node\nif (process.argv[2] === "metadata") process.stdout.write(${JSON.stringify(metadata)}); else console.log("cargo scope output");\n`,
      );
      await writeFile(
        uvCommand,
        '#!/usr/bin/env node\nconsole.log("uv scope output");\n',
      );
      await chmod(cargoCommand, 0o755);
      await chmod(uvCommand, 0o755);
      const args = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--filter=rust-root",
        "--filter=python-root",
        "--concurrency=2",
      ];
      const env = {
        PATH: `${commandDirectory}${delimiter}${process.env.PATH ?? ""}`,
        NO_COLOR: "1",
        TURBO_TELEMETRY_DISABLED: "1",
      };
      const first = await run(process.execPath, args, repositoryRoot, env);
      expect(first.exitCode, first.stderr).toBe(0);
      expect(await readFile(cargoLog, "utf8")).toContain("cargo scope output");
      expect(await readFile(cargoLog, "utf8")).not.toContain("uv scope output");
      expect(await readFile(uvLog, "utf8")).toContain("uv scope output");
      expect(await readFile(uvLog, "utf8")).not.toContain("cargo scope output");

      await rm(cargoLog);
      await rm(uvLog);
      const second = await run(process.execPath, args, repositoryRoot, env);
      expect(second.exitCode, second.stderr).toBe(0);
      expect(second.stdout).toContain("rust-root:build: cache hit");
      expect(second.stdout).toContain("python-root:build: cache hit");
      expect(await readFile(cargoLog, "utf8")).toContain("cargo scope output");
      expect(await readFile(cargoLog, "utf8")).not.toContain("uv scope output");
      expect(await readFile(uvLog, "utf8")).toContain("uv scope output");
      expect(await readFile(uvLog, "utf8")).not.toContain("cargo scope output");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);

  it("skips oversized cache inputs before retaining file contents", async () => {
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      configuration.tasks["oversized-cache"] = { outputs: ["dist/**"] };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts["oversized-cache"] =
        `node -e "const fs=require('node:fs'); fs.mkdirSync('dist',{recursive:true}); const file=fs.openSync('dist/large.bin','w'); fs.ftruncateSync(file,${maximumCacheArchiveInputBytes + 1}); fs.closeSync(file); console.log('oversized cache output')"`;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "oversized-cache",
          "--cwd",
          directory,
          "--filter=synthetic-library",
          "--cache=local:w",
        ],
        repositoryRoot,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("oversized cache output");
      expect(result.stderr).toContain("cache write skipped");
      expect(result.stderr).toContain(
        `${maximumCacheArchiveInputBytes} byte safety limit`,
      );
      await expect(readdir(`${directory}/.turbo/cache`)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("serializes cache publication across concurrent task completions", async () => {
    let activePublications = 0;
    let maximumActivePublications = 0;
    await Effect.runPromise(
      Effect.gen(function* () {
        const withCachePublicationPermit = yield* makeCachePublicationPermit;
        const publication = withCachePublicationPermit(
          Effect.acquireUseRelease(
            Effect.sync(() => {
              activePublications += 1;
              maximumActivePublications = Math.max(
                maximumActivePublications,
                activePublications,
              );
            }),
            () => Effect.sleep("20 millis"),
            () =>
              Effect.sync(() => {
                activePublications -= 1;
              }),
          ),
        );
        yield* Effect.all([publication, publication], {
          concurrency: "unbounded",
        });
      }),
    );
    expect(maximumActivePublications).toBe(1);
  });

  it("preserves task success when cache output collection fails", async () => {
    if (process.platform === "win32") return;
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    const outputPath = `${packageDirectory}/dist/unreadable.txt`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      configuration.tasks["unreadable-cache"] = { outputs: ["dist/**"] };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts["unreadable-cache"] =
        "node -e \"const fs=require('node:fs'); fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/unreadable.txt','output'); fs.chmodSync('dist/unreadable.txt',0); console.log('unreadable cache output')\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "unreadable-cache",
          "--cwd",
          directory,
          "--filter=synthetic-library",
          "--cache=local:w",
        ],
        repositoryRoot,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("unreadable cache output");
      expect(result.stderr).toContain("cache output collection failed");
      expect(result.stderr).toContain("preserving successful task result");
      await expect(readdir(`${directory}/.turbo/cache`)).rejects.toThrow();
    } finally {
      await chmod(outputPath, 0o600).catch(() => undefined);
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

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

  it("validates tasks before an empty affected selection", async () => {
    await mkdir(`${repositoryRoot}/.turbo`, { recursive: true });
    const directory = await mkdtemp(
      join(repositoryRoot, ".turbo/turbo-ts-empty-affected-"),
    );
    await cp(fixtureRoot, directory, { recursive: true });
    try {
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
      const common = ["--cwd", directory, "--affected", "--no-cache"];
      const valid = await run(
        process.execPath,
        [candidateEntrypoint, "run", "build", ...common],
        repositoryRoot,
        { TURBO_SCM_BASE: "HEAD", TURBO_SCM_HEAD: "HEAD" },
      );
      expect(valid.exitCode, valid.stderr).toBe(0);
      expect(valid.stdout).not.toContain("library build");
      expect(valid.stdout).not.toContain("app build");
      const invalid = await run(
        process.execPath,
        [candidateEntrypoint, "run", "verify", ...common],
        repositoryRoot,
        { TURBO_SCM_BASE: "HEAD", TURBO_SCM_HEAD: "HEAD" },
      );
      expect(invalid.exitCode).not.toBe(0);
      expect(invalid.stderr).toContain("task not found: verify");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("rejects all-commandless strict task entrypoints", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        tasks: Record<string, unknown>;
      };
      configuration.futureFlags = { strictTaskEntrypointSelection: true };
      configuration.tasks.verify = {};
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "verify",
          "--cwd",
          directory,
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("task not found: verify");
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

  it("preserves cache hits when restored task logs cannot be replayed", async () => {
    const directory = await makeFixture();
    const executionPath = `${directory}/packages/library/.turbo/executions.txt`;
    try {
      const manifestPath = `${directory}/packages/library/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.build =
        "node -e \"const fs=require('node:fs'); fs.appendFileSync('.turbo/executions.txt','run\\n'); console.log('cached output')\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const arguments_ = [
        "run",
        "build",
        "--cwd",
        directory,
        "--filter=synthetic-library",
        "--no-color",
      ];
      const cold = await run(
        process.execPath,
        [candidateEntrypoint, ...arguments_],
        repositoryRoot,
      );
      expect(cold.exitCode, cold.stderr).toBe(0);
      expect(cold.stdout).toContain("cache miss");

      const stdout: Array<string> = [];
      const stderr: Array<string> = [];
      const exitCode = await Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystemService;
          const overrides = Layer.merge(
            Layer.succeed(FileSystemService, {
              ...fileSystem,
              readTextChunks: (path) =>
                path.endsWith("/.turbo/turbo-build.log")
                  ? Stream.fail(
                      new BoundaryError({
                        boundary: "filesystem",
                        message: "synthetic cached log read failure",
                        retryable: false,
                      }),
                    )
                  : fileSystem.readTextChunks(path),
            }),
            Layer.succeed(TerminalService, {
              writeStdout: (text) =>
                Effect.sync(() => {
                  stdout.push(text);
                }),
              writeStderr: (text) =>
                Effect.sync(() => {
                  stderr.push(text);
                }),
              stdoutColorEnabled: Effect.succeed(false),
              stderrColorEnabled: Effect.succeed(false),
            }),
          );
          return yield* executeRun(parseRunArguments(arguments_)).pipe(
            Effect.provide(overrides),
          );
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(exitCode).toBe(0);
      expect(stdout.join("")).toContain("cache hit");
      expect(stderr.join("")).toContain(
        "cached log replay failed for synthetic-library:build",
      );
      expect(stderr.join("")).toContain("synthetic cached log read failure");
      expect(await readFile(executionPath, "utf8")).toBe("run\n");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("falls back to local execution when cache outputs cannot be scanned", async () => {
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    const outputPath = `${packageDirectory}/dist/result.txt`;
    const executionPath = `${packageDirectory}/.turbo/executions.txt`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, Record<string, unknown>> };
      configuration.tasks.build = {
        ...configuration.tasks.build,
        inputs: ["source.txt"],
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await writeFile(`${packageDirectory}/source.txt`, "source\n");
      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.build =
        "node -e \"const fs=require('node:fs'); fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/result.txt','result\\n'); fs.appendFileSync('.turbo/executions.txt','run\\n'); console.log('library build')\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const arguments_ = [
        "run",
        "build",
        "--cwd",
        directory,
        "--filter=synthetic-library",
        "--no-color",
        "--output-logs=hash-only",
      ];
      const cold = await run(
        process.execPath,
        [candidateEntrypoint, ...arguments_],
        repositoryRoot,
      );
      expect(cold.exitCode, cold.stderr).toBe(0);
      expect(cold.stdout).toContain("cache miss");

      const stdout: Array<string> = [];
      const stderr: Array<string> = [];
      const exitCode = await Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystemService;
          const overrides = Layer.merge(
            Layer.succeed(FileSystemService, {
              ...fileSystem,
              metadata: (path) =>
                path === outputPath
                  ? Effect.fail(
                      new BoundaryError({
                        boundary: "filesystem",
                        message: "synthetic output metadata failure",
                        retryable: false,
                      }),
                    )
                  : fileSystem.metadata(path),
            }),
            Layer.succeed(TerminalService, {
              writeStdout: (text) =>
                Effect.sync(() => {
                  stdout.push(text);
                }),
              writeStderr: (text) =>
                Effect.sync(() => {
                  stderr.push(text);
                }),
              stdoutColorEnabled: Effect.succeed(false),
              stderrColorEnabled: Effect.succeed(false),
            }),
          );
          return yield* executeRun(
            parseRunArguments([...arguments_, "--cache=local:r"]),
          ).pipe(Effect.provide(overrides));
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(exitCode).toBe(0);
      expect(stdout.join("")).toContain("cache miss");
      expect(stderr.join("")).toContain("cache restore preparation failed");
      expect(stderr.join("")).toContain("synthetic output metadata failure");
      expect(await readFile(executionPath, "utf8")).toBe("run\nrun\n");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("streams large task logs when replaying cache hits", async () => {
    const directory = await makeFixture();
    try {
      const manifestPath = `${directory}/packages/library/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.build =
        "node -e \"process.stdout.write('x'.repeat(200000))\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const args = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--filter=synthetic-library",
      ];
      const environment = { NO_COLOR: "1" };
      const cold = await run(
        process.execPath,
        args,
        repositoryRoot,
        environment,
      );
      const warm = await run(
        process.execPath,
        args,
        repositoryRoot,
        environment,
      );
      expect(cold.exitCode).toBe(0);
      expect(cold.stdout).toContain("cache miss");
      expect(warm.exitCode).toBe(0);
      expect(warm.stdout).toContain("cache hit");
      expect(warm.stdout).toContain(
        `synthetic-library:build: ${"x".repeat(100)}`,
      );
      expect(
        warm.stdout.match(/synthetic-library:build: x{100}/g),
      ).toHaveLength(1);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("excludes a configured workspace cache directory from inputs and outputs", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: { build: { outputs: Array<string> } } };
      configuration.tasks.build.outputs.push(
        "$TURBO_ROOT$/packages/library/task-cache/**",
      );
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
        "--cache-dir=packages/library/task-cache",
        "--output-logs=hash-only",
      ];
      const cold = await run(process.execPath, args, repositoryRoot);
      const warm = await run(process.execPath, args, repositoryRoot);
      const repeated = await run(process.execPath, args, repositoryRoot);
      expect(cold.exitCode).toBe(0);
      expect(cold.stdout).toContain("cache miss");
      expect(warm.exitCode).toBe(0);
      expect(warm.stdout).toContain("cache hit");
      expect(repeated.exitCode).toBe(0);
      expect(repeated.stdout).toContain("cache hit");
      expect(
        (await readdir(`${directory}/packages/library/task-cache`)).some(
          (name) => name.endsWith(".tar.zst"),
        ),
      ).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("excludes the in-repository target of a cache-directory symlink", async () => {
    if (process.platform === "win32") return;
    const directory = await makeFixture();
    const cacheTarget = `${directory}/packages/library/task-cache`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: { build: { outputs: Array<string> } } };
      configuration.tasks.build.outputs.push(
        "$TURBO_ROOT$/packages/library/task-cache/**",
      );
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await mkdir(cacheTarget, { recursive: true });
      await symlink("packages/library/task-cache", `${directory}/cache-link`);
      const args = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--filter=synthetic-library",
        "--cache-dir=cache-link",
        "--output-logs=hash-only",
      ];
      const cold = await run(process.execPath, args, repositoryRoot);
      const warm = await run(process.execPath, args, repositoryRoot);
      const repeated = await run(process.execPath, args, repositoryRoot);
      expect(cold.exitCode).toBe(0);
      expect(cold.stdout).toContain("cache miss");
      expect(warm.exitCode).toBe(0);
      expect(warm.stdout).toContain("cache hit");
      expect(repeated.exitCode).toBe(0);
      expect(repeated.stdout).toContain("cache hit");
      expect(
        (await readdir(cacheTarget)).some((name) => name.endsWith(".tar.zst")),
      ).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("rejects cache directories that contain the repository", async () => {
    const directory = await makeFixture();
    try {
      for (const cacheDirectory of [directory, dirname(directory)]) {
        const result = await run(
          process.execPath,
          [
            candidateEntrypoint,
            "run",
            "build",
            "--cwd",
            directory,
            `--cache-dir=${cacheDirectory}`,
          ],
          repositoryRoot,
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain(
          "cache directory must not be the repository root or one of its ancestors",
        );
        expect(result.stdout).not.toContain("library build");
        expect(result.stdout).not.toContain("app build");
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects cache-directory symlinks that contain the repository", async () => {
    if (process.platform === "win32") return;
    const directory = await makeFixture();
    try {
      const rootLink = `${directory}/cache-root-link`;
      const parentLink = `${directory}/cache-parent-link`;
      await symlink(".", rootLink);
      await symlink("..", parentLink);
      for (const cacheDirectory of [rootLink, parentLink]) {
        const result = await run(
          process.execPath,
          [
            candidateEntrypoint,
            "run",
            "build",
            "--cwd",
            directory,
            `--cache-dir=${cacheDirectory}`,
          ],
          repositoryRoot,
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain(
          "cache directory must not be the repository root or one of its ancestors",
        );
        expect(result.stdout).not.toContain("library build");
        expect(result.stdout).not.toContain("app build");
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

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

  it("warns and continues when startup cache eviction fails", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as Record<string, unknown>;
      configuration.cacheDir = "blocked-cache";
      configuration.cacheMaxAge = "1h";
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await writeFile(`${directory}/blocked-cache`, "not a directory\n");
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "--cwd",
          directory,
          "--filter=synthetic-library",
          "--cache=local:r",
        ],
        repositoryRoot,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("library build");
      expect(result.stderr).toContain("local cache eviction failed");
      expect(result.stderr).toContain("continuing without cache maintenance");
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

  it("honors package task exclusions and fresh definitions", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const workspacePath = `${directory}/packages/app/turbo.json`;
      const workspace = JSON.parse(await readFile(workspacePath, "utf8")) as {
        tasks: Record<string, Record<string, unknown>>;
      };
      workspace.tasks.build = { extends: false };
      await writeFile(workspacePath, `${JSON.stringify(workspace, null, 2)}\n`);

      const discover = () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const rootConfiguration = yield* loadRootConfiguration(directory);
            return yield* discoverRepository(directory, rootConfiguration);
          }).pipe(Effect.provide(nodeFoundationLayer)),
        );
      const excluded = await discover();
      const excludedApp = excluded.packagesByName.get("synthetic-app")!;
      expect(excludedApp.excludedTasks).toContain("build");
      expect(excludedApp.tasks.build).toBeUndefined();
      expect(
        buildTaskGraph(excluded, [excludedApp], ["build"], false).entrypoints,
      ).toEqual([]);

      const runWithoutApp = await run(
        process.execPath,
        [candidateEntrypoint, "run", "build", "--cwd", directory, "--no-cache"],
        repositoryRoot,
      );
      expect(runWithoutApp.exitCode).toBe(0);
      expect(runWithoutApp.stdout).toContain("library build");
      expect(runWithoutApp.stdout).not.toContain("app build");

      workspace.tasks.build = {
        extends: false,
        outputs: ["fresh/**"],
      };
      await writeFile(workspacePath, `${JSON.stringify(workspace, null, 2)}\n`);
      const fresh = await discover();
      const freshApp = fresh.packagesByName.get("synthetic-app")!;
      expect(freshApp.excludedTasks).not.toContain("build");
      expect(freshApp.tasks.build).toEqual({ outputs: ["fresh/**"] });
      expect(
        buildTaskGraph(fresh, [freshApp], ["build"], false).nodes.get(
          "synthetic-app#build",
        )?.dependencies,
      ).toEqual([]);

      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, Record<string, unknown>> };
      configuration.tasks.build!.extends = false;
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const invalidRoot = await run(
        process.execPath,
        [candidateEntrypoint, "run", "build", "--cwd", directory],
        repositoryRoot,
      );
      expect(invalidRoot.exitCode).not.toBe(0);
      expect(invalidRoot.stderr).toContain("unknown key: extends");
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

      libraryManifest.version = "2.0.0";
      for (const specification of ["file:../library", "link:../library"]) {
        appManifest.dependencies["synthetic-library"] = specification;
        await writeFile(
          appManifestPath,
          `${JSON.stringify(appManifest, null, 2)}\n`,
        );
        await writeFile(
          libraryManifestPath,
          `${JSON.stringify(libraryManifest, null, 2)}\n`,
        );
        const localPathModel = await discover();
        expect(
          localPathModel.packagesByName.get("synthetic-app")
            ?.internalDependencies,
        ).toEqual(["synthetic-library"]);
      }

      delete appManifest.dependencies["synthetic-library"];
      for (const specification of ["file:../library", "link:../library"]) {
        appManifest.dependencies["library-alias"] = specification;
        await writeFile(
          appManifestPath,
          `${JSON.stringify(appManifest, null, 2)}\n`,
        );
        const localAliasModel = await discover();
        const localAliasApp =
          localAliasModel.packagesByName.get("synthetic-app")!;
        expect(localAliasApp.internalDependencies).toEqual([
          "synthetic-library",
        ]);
        expect(
          buildTaskGraph(
            localAliasModel,
            [localAliasApp],
            ["build"],
            false,
          ).nodes.has("synthetic-library#build"),
        ).toBe(true);
      }
      delete appManifest.dependencies["library-alias"];
      appManifest.dependencies["synthetic-library"] = "file:../library";

      if (process.platform === "win32") {
        appManifest.dependencies["synthetic-library"] = "file:../LIBRARY";
      } else {
        await symlink(
          `${directory}/packages/library`,
          `${directory}/packages/library-link`,
        );
        appManifest.dependencies["synthetic-library"] = "link:../library-link";
      }
      await writeFile(
        appManifestPath,
        `${JSON.stringify(appManifest, null, 2)}\n`,
      );
      expect(
        (await discover()).packagesByName.get("synthetic-app")
          ?.internalDependencies,
      ).toEqual(["synthetic-library"]);

      appManifest.dependencies["synthetic-library"] = "file:../app";
      await writeFile(
        appManifestPath,
        `${JSON.stringify(appManifest, null, 2)}\n`,
      );
      expect(
        (await discover()).packagesByName.get("synthetic-app")
          ?.internalDependencies,
      ).toEqual([]);

      delete appManifest.dependencies["synthetic-library"];
      appManifest.dependencies["library-alias"] =
        "workspace:synthetic-library@*";
      await writeFile(
        appManifestPath,
        `${JSON.stringify(appManifest, null, 2)}\n`,
      );
      const aliased = await discover();
      const aliasedApp = aliased.packagesByName.get("synthetic-app")!;
      expect(aliasedApp.internalDependencies).toEqual(["synthetic-library"]);
      expect(
        buildTaskGraph(aliased, [aliasedApp], ["build"], false).nodes.has(
          "synthetic-library#build",
        ),
      ).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("discovers contained symlinked workspace members without following cycles", async () => {
    if (process.platform === "win32") return;
    const directory = await makeGitFixture();
    const target = `${directory}/real/linked`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { futureFlags?: Record<string, boolean> };
      configuration.futureFlags = {
        affectedUsingTaskInputs: true,
        filterUsingTasks: true,
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await mkdir(target, { recursive: true });
      await writeFile(
        `${target}/package.json`,
        `${JSON.stringify({
          name: "synthetic-linked",
          private: true,
          scripts: {
            build:
              "node -e \"const fs=require('node:fs');fs.appendFileSync('runs.txt','run\\n');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/output.txt','linked')\"",
          },
        })}\n`,
      );
      await writeFile(`${target}/source.txt`, "initial\n");
      await symlink("../..", `${target}/loop`);
      await symlink("../real/linked", `${directory}/packages/linked`);
      await writeFile(
        `${directory}/pnpm-workspace.yaml`,
        "packages:\n  - packages/**\n",
      );
      const appManifestPath = `${directory}/packages/app/package.json`;
      const appManifest = JSON.parse(
        await readFile(appManifestPath, "utf8"),
      ) as {
        dependencies: Record<string, string>;
        scripts: Record<string, string>;
      };
      appManifest.dependencies = { "synthetic-linked": "workspace:*" };
      appManifest.scripts.build =
        "node -e \"require('node:fs').appendFileSync('runs.txt','run\\n')\"";
      await writeFile(
        appManifestPath,
        `${JSON.stringify(appManifest, null, 2)}\n`,
      );
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
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(model.packagesByName.get("synthetic-linked")).toMatchObject({
        directory: `${directory}/packages/linked`,
        relativeDirectory: "packages/linked",
        canonicalRelativeDirectory: "real/linked",
        cachePathRestorable: false,
      });
      expect(
        model.packages.filter(
          (packageModel) => packageModel.name === "synthetic-linked",
        ),
      ).toHaveLength(1);
      const execute = () =>
        run(
          process.execPath,
          [
            candidateEntrypoint,
            "run",
            "build",
            "--cwd",
            directory,
            "--filter=synthetic-app",
          ],
          repositoryRoot,
        );
      expect((await execute()).exitCode).toBe(0);
      await writeFile(`${target}/source.txt`, "changed\n");
      expect(
        (await run("git", ["add", "real/linked/source.txt"], directory))
          .exitCode,
      ).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "change linked source"], directory))
          .exitCode,
      ).toBe(0);
      const second = await execute();
      expect(second.exitCode).toBe(0);
      expect(second.stderr).not.toContain("cache restore failed");
      expect(await readFile(`${target}/runs.txt`, "utf8")).toBe("run\nrun\n");
      expect(await readFile(`${directory}/packages/app/runs.txt`, "utf8")).toBe(
        "run\nrun\n",
      );
      for (const selector of ["--affected", "--filter=...[HEAD~1]"]) {
        const selected = await run(
          process.execPath,
          [
            candidateEntrypoint,
            "run",
            "build",
            "--cwd",
            directory,
            selector,
            "--no-cache",
          ],
          repositoryRoot,
          { TURBO_SCM_BASE: "HEAD~1", TURBO_SCM_HEAD: "HEAD" },
        );
        expect(selected.exitCode, selected.stderr).toBe(0);
      }
      expect(await readFile(`${target}/runs.txt`, "utf8")).toBe(
        "run\nrun\nrun\nrun\n",
      );
      expect(await readFile(`${directory}/packages/app/runs.txt`, "utf8")).toBe(
        "run\nrun\nrun\nrun\n",
      );
      await expect(lstat(`${directory}/.turbo/cache`)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);

  it("does not link JavaScript dependencies to polyglot packages", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        tasks: Record<string, unknown>;
      };
      configuration.futureFlags = { experimentalCargoWorkspaces: true };
      configuration.tasks["//#verify"] = { dependsOn: ["^build"] };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const rootManifestPath = `${directory}/package.json`;
      const rootManifest = JSON.parse(
        await readFile(rootManifestPath, "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        scripts: Record<string, string>;
      };
      rootManifest.dependencies = { helper: "workspace:*" };
      rootManifest.scripts.verify = "node -e \"console.log('verify')\"";
      await writeFile(
        rootManifestPath,
        `${JSON.stringify(rootManifest, null, 2)}\n`,
      );
      const appManifestPath = `${directory}/packages/app/package.json`;
      const appManifest = JSON.parse(
        await readFile(appManifestPath, "utf8"),
      ) as { dependencies: Record<string, string> };
      appManifest.dependencies.helper = "workspace:*";
      await writeFile(
        appManifestPath,
        `${JSON.stringify(appManifest, null, 2)}\n`,
      );
      const cargoDirectory = `${directory}/packages/cargo-helper`;
      await mkdir(`${cargoDirectory}/src`, { recursive: true });
      await writeFile(
        `${cargoDirectory}/Cargo.toml`,
        '[package]\nname = "helper"\nversion = "0.1.0"\nedition = "2024"\n',
      );
      await writeFile(`${cargoDirectory}/src/lib.rs`, "pub fn value() {}\n");
      await cp(
        `${repositoryRoot}/rust-toolchain`,
        `${directory}/rust-toolchain`,
      );
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      const app = model.packagesByName.get("synthetic-app")!;
      expect(model.packagesByName.get("helper")?.manager).toBe("cargo");
      expect(app.internalDependencies).not.toContain("helper");
      expect(model.rootPackage.internalDependencies).not.toContain("helper");
      expect(
        buildTaskGraph(model, [app], ["build"], false).nodes.has(
          "helper#build",
        ),
      ).toBe(false);
      expect(
        buildTaskGraph(model, [model.rootPackage], ["verify"], false).nodes.has(
          "helper#build",
        ),
      ).toBe(false);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);

  it("hashes explicit outputs without Git while excluding .venv", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, { inputs?: Array<string> }> };
      configuration.tasks.build!.inputs = [
        ".venv/**",
        "dist/schema/**",
        "target/generated/**",
      ];
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const packageDirectory = `${directory}/packages/library`;
      await mkdir(`${packageDirectory}/.venv/lib`, { recursive: true });
      await mkdir(`${packageDirectory}/dist/schema`, { recursive: true });
      await mkdir(`${packageDirectory}/target/generated`, { recursive: true });
      await writeFile(`${packageDirectory}/.venv/lib/dependency.py`, "one\n");
      await writeFile(`${packageDirectory}/dist/schema/value.json`, "one\n");
      await writeFile(
        `${packageDirectory}/target/generated/value.txt`,
        "one\n",
      );
      const rootConfiguration = await Effect.runPromise(
        loadRootConfiguration(directory).pipe(
          Effect.provide(nodeFoundationLayer),
        ),
      );
      const model = await Effect.runPromise(
        discoverRepository(directory, rootConfiguration).pipe(
          Effect.provide(nodeFoundationLayer),
        ),
      );
      const library = model.packagesByName.get("synthetic-library")!;
      const node = buildTaskGraph(model, [library], ["build"], false).nodes.get(
        "synthetic-library#build",
      )!;
      const compute = () =>
        Effect.runPromise(
          hashTask(model, node, [], true, [], `${directory}/.turbo/cache`).pipe(
            Effect.provide(nodeFoundationLayer),
          ),
        );
      const first = await compute();
      expect(first.inputFiles).toEqual([
        "dist/schema/value.json",
        "target/generated/value.txt",
      ]);
      await writeFile(`${packageDirectory}/.venv/lib/dependency.py`, "two\n");
      expect((await compute()).hash).toBe(first.hash);
      await writeFile(`${packageDirectory}/dist/schema/value.json`, "two\n");
      const second = await compute();
      expect(second.hash).not.toBe(first.hash);
      await writeFile(
        `${packageDirectory}/target/generated/value.txt`,
        "two\n",
      );
      expect((await compute()).hash).not.toBe(second.hash);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("orders non-ASCII task hash inputs by code unit", async () => {
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, { inputs?: Array<string> }> };
      configuration.tasks.build!.inputs = ["ä-input.txt", "z-input.txt"];
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await writeFile(`${packageDirectory}/ä-input.txt`, "unicode\n");
      await writeFile(`${packageDirectory}/z-input.txt`, "ascii\n");
      const rootConfiguration = await Effect.runPromise(
        loadRootConfiguration(directory).pipe(
          Effect.provide(nodeFoundationLayer),
        ),
      );
      const model = await Effect.runPromise(
        discoverRepository(directory, rootConfiguration).pipe(
          Effect.provide(nodeFoundationLayer),
        ),
      );
      const library = model.packagesByName.get("synthetic-library")!;
      const node = buildTaskGraph(model, [library], ["build"], false).nodes.get(
        "synthetic-library#build",
      )!;
      const result = await Effect.runPromise(
        hashTask(model, node, [], true, [], `${directory}/.turbo/cache`).pipe(
          Effect.provide(nodeFoundationLayer),
        ),
      );
      expect(result.inputFiles).toEqual(["z-input.txt", "ä-input.txt"]);
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

  it("uses only pnpm-workspace.yaml for pnpm workspace declarations", async () => {
    const directory = await makeFixture();
    const workspacePath = `${directory}/pnpm-workspace.yaml`;
    try {
      const manifestPath = `${directory}/package.json`;
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as Record<string, unknown>;
      manifest.workspaces = ["packages/*"];
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const discover = () =>
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer));

      await writeFile(workspacePath, "catalog:\n  react: 19.1.0\n");
      const model = await Effect.runPromise(discover());
      expect(model.packages).toEqual([]);

      await writeFile(workspacePath, "packages: packages/*\n");
      const invalid = await Effect.runPromise(discover().pipe(Effect.either));
      expect(invalid._tag).toBe("Left");
      if (invalid._tag === "Left") {
        expect("path" in invalid.left).toBe(true);
        if ("path" in invalid.left) {
          expect(invalid.left.path).toBe(workspacePath);
        }
        expect(invalid.left.message).toContain(
          "packages must be an array of strings",
        );
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("discovers declared workspaces beneath output-named directories", async () => {
    const directory = await makeFixture();
    try {
      const manifestPath = `${directory}/package.json`;
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as Record<string, unknown>;
      manifest.packageManager = "npm@11.6.0";
      manifest.workspaces = ["packages/dist/app", "packages/target/tool"];
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      for (const [path, name] of [
        ["packages/dist/app", "dist-app"],
        ["packages/target/tool", "target-tool"],
      ] as const) {
        await mkdir(`${directory}/${path}`, { recursive: true });
        await writeFile(
          `${directory}/${path}/package.json`,
          `${JSON.stringify({ name, version: "1.0.0" }, null, 2)}\n`,
        );
      }
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(model.packages.map((packageModel) => packageModel.name)).toEqual([
        "dist-app",
        "target-tool",
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not traverse unrelated directories outside workspace globs", async () => {
    if (process.platform === "win32") return;
    const directory = await makeFixture();
    const vendorDirectory = `${directory}/vendor`;
    try {
      await mkdir(`${vendorDirectory}/large/unrelated/tree`, {
        recursive: true,
      });
      await chmod(vendorDirectory, 0o000);
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(model.packages.map((packageModel) => packageModel.name)).toEqual([
        "synthetic-app",
        "synthetic-library",
      ]);
    } finally {
      await chmod(vendorDirectory, 0o700).catch(() => undefined);
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("discovers repositories without parsing oversized lockfiles", async () => {
    const directory = await makeFixture();
    try {
      const lockfilePath = `${directory}/pnpm-lock.yaml`;
      await writeFile(lockfilePath, new Uint8Array(32 * 1024 * 1024 + 1));
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(model.lockfile).toBe(lockfilePath);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("links Cargo dependencies only when metadata resolves a workspace path", async () => {
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
      };
      configuration.tasks.build = { dependsOn: ["^build"] };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await mkdir(`${directory}/rust/app/src`, { recursive: true });
      await mkdir(`${directory}/rust/itoa/src`, { recursive: true });
      await writeFile(
        `${directory}/rust/Cargo.toml`,
        '[workspace]\nmembers = ["app", "itoa"]\nresolver = "3"\n',
      );
      const appManifestPath = `${directory}/rust/app/Cargo.toml`;
      await writeFile(
        appManifestPath,
        '[package]\nname = "rust-app"\nversion = "0.1.0"\nedition = "2024"\n\n[dependencies]\nitoa = "1"\n',
      );
      await writeFile(
        `${directory}/rust/itoa/Cargo.toml`,
        '[package]\nname = "itoa"\nversion = "99.0.0"\nedition = "2024"\n',
      );
      await writeFile(`${directory}/rust/app/src/main.rs`, "fn main() {}\n");
      await writeFile(
        `${directory}/rust/itoa/src/lib.rs`,
        "pub fn value() {}\n",
      );
      await cp(
        `${repositoryRoot}/rust-toolchain`,
        `${directory}/rust-toolchain`,
      );
      const discover = () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const rootConfiguration = yield* loadRootConfiguration(directory);
            return yield* discoverRepository(directory, rootConfiguration);
          }).pipe(Effect.provide(nodeFoundationLayer)),
        );
      const registryModel = await discover();
      const registryApp = registryModel.packagesByName.get("rust-app")!;
      expect(registryApp.dependencyNames).toEqual(["itoa"]);
      expect(registryApp.internalDependencies).toEqual([]);
      expect(
        buildTaskGraph(
          registryModel,
          [registryApp],
          ["build"],
          false,
        ).nodes.has("itoa#build"),
      ).toBe(false);

      await writeFile(
        appManifestPath,
        '[package]\nname = "rust-app"\nversion = "0.1.0"\nedition = "2024"\n\n[dependencies]\nitoa = { path = "../itoa" }\n',
      );
      const pathModel = await discover();
      const pathApp = pathModel.packagesByName.get("rust-app")!;
      expect(pathApp.cacheInputsComplete).toBe(true);
      expect(pathApp.internalDependencies).toEqual(["itoa"]);
      expect(
        buildTaskGraph(pathModel, [pathApp], ["build"], false).nodes.has(
          "itoa#build",
        ),
      ).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);

  it("disables caching for external Cargo path dependencies", async () => {
    const outer = await mkdtemp(join(tmpdir(), "turbo-ts-cargo-path-"));
    const directory = `${outer}/repository`;
    const packageDirectory = `${directory}/rust/app`;
    const externalDirectory = `${outer}/external`;
    try {
      await cp(fixtureRoot, directory, { recursive: true });
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        tasks: Record<string, Record<string, unknown>>;
      };
      configuration.futureFlags = { experimentalCargoWorkspaces: true };
      for (const task of ["build", "check", "test"]) {
        configuration.tasks[task] = { cache: true };
      }
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await mkdir(`${packageDirectory}/src`, { recursive: true });
      await mkdir(`${externalDirectory}/src`, { recursive: true });
      await writeFile(
        `${directory}/rust/Cargo.toml`,
        '[workspace]\nmembers = ["app"]\nresolver = "3"\n',
      );
      await writeFile(
        `${packageDirectory}/Cargo.toml`,
        '[package]\nname = "rust-app"\nversion = "0.1.0"\nedition = "2024"\n\n[dependencies]\nexternal = { path = "../../../external" }\n',
      );
      await writeFile(
        `${externalDirectory}/Cargo.toml`,
        '[package]\nname = "external"\nversion = "0.1.0"\nedition = "2024"\n',
      );
      await writeFile(`${packageDirectory}/src/main.rs`, "fn main() {}\n");
      await writeFile(`${externalDirectory}/src/lib.rs`, "pub fn value() {}\n");
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
      const cargoPackage = model.packagesByName.get("rust-app")!;
      expect(cargoPackage.workspaceDirectory).toBe(`${directory}/rust`);
      expect(cargoPackage.cacheInputsComplete).toBe(false);
      expect(cargoPackage.internalDependencies).toEqual([]);
      for (const task of ["build", "check", "test"]) {
        const node = buildTaskGraph(
          model,
          [cargoPackage],
          [task],
          false,
        ).nodes.get(`rust-app#${task}`)!;
        expect(isTaskScopeCacheable(node, [])).toBe(false);
      }
    } finally {
      await rm(outer, { force: true, recursive: true });
    }
  }, 20_000);

  it("discovers only Cargo metadata workspace members", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
      };
      configuration.futureFlags = { experimentalCargoWorkspaces: true };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      for (const name of ["member", "excluded", "unrelated"]) {
        await mkdir(`${directory}/rust/${name}/src`, { recursive: true });
        await writeFile(
          `${directory}/rust/${name}/Cargo.toml`,
          `[package]\nname = "rust-${name}"\nversion = "0.1.0"\nedition = "2024"\n`,
        );
        await writeFile(
          `${directory}/rust/${name}/src/lib.rs`,
          "pub fn value() {}\n",
        );
      }
      await writeFile(
        `${directory}/rust/Cargo.toml`,
        '[workspace]\nmembers = ["member"]\nexclude = ["excluded"]\nresolver = "3"\n',
      );
      await writeFile(
        `${directory}/rust/member/turbo.json`,
        `${JSON.stringify(
          { extends: ["//"], tasks: { build: { extends: false } } },
          null,
          2,
        )}\n`,
      );
      await cp(
        `${repositoryRoot}/rust-toolchain`,
        `${directory}/rust-toolchain`,
      );
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(
        model.packages
          .filter((packageModel) => packageModel.manager === "cargo")
          .map((packageModel) => packageModel.name),
      ).toEqual(["rust-member"]);
      const member = model.packagesByName.get("rust-member")!;
      expect(member.excludedTasks).toContain("build");
      expect(member.tasks.build).toBeUndefined();
      expect(
        buildTaskGraph(model, [member], ["build"], false).entrypoints,
      ).toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);

  it("reuses root task configuration for root Cargo packages", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        tasks: Record<string, Record<string, unknown>>;
      };
      configuration.futureFlags = { experimentalCargoWorkspaces: true };
      configuration.tasks.run = { cache: true };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await mkdir(`${directory}/src`, { recursive: true });
      await writeFile(
        `${directory}/Cargo.toml`,
        '[package]\nname = "synthetic-rust-root"\nversion = "0.1.0"\nedition = "2024"\n',
      );
      await writeFile(`${directory}/src/main.rs`, "fn main() {}\n");
      await cp(
        `${repositoryRoot}/rust-toolchain`,
        `${directory}/rust-toolchain`,
      );
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      const rootCargoPackage = model.packagesByName.get("synthetic-rust-root");
      expect(rootCargoPackage?.relativeDirectory).toBe(".");
      expect(rootCargoPackage?.tasks.build?.dependsOn).toEqual(["^build"]);
      expect(rootCargoPackage?.tasks.run).toMatchObject({ cache: true });
      expect(rootCargoPackage?.tasks.dev).toMatchObject({ cache: false });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);

  it("matches Cargo manifests through a symlinked repository root", async () => {
    if (process.platform === "win32") return;
    const directory = await makeFixture();
    const linkedRoot = `${directory}-link`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { futureFlags?: Record<string, boolean> };
      configuration.futureFlags = { experimentalCargoWorkspaces: true };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const cargoDirectory = `${directory}/packages/rust-tool`;
      await mkdir(`${cargoDirectory}/src`, { recursive: true });
      await writeFile(
        `${cargoDirectory}/Cargo.toml`,
        '[package]\nname = "rust-tool"\nversion = "0.1.0"\nedition = "2024"\n',
      );
      await writeFile(`${cargoDirectory}/src/main.rs`, "fn main() {}\n");
      await cp(
        `${repositoryRoot}/rust-toolchain`,
        `${directory}/rust-toolchain`,
      );
      await symlink(directory, linkedRoot);
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(linkedRoot);
          return yield* discoverRepository(linkedRoot, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(model.packagesByName.get("rust-tool")).toMatchObject({
        directory: `${linkedRoot}/packages/rust-tool`,
        workspaceDirectory: `${linkedRoot}/packages/rust-tool`,
      });
    } finally {
      await rm(linkedRoot, { force: true });
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);

  it("keeps Cargo packages in external workspaces package-scoped", async () => {
    const outer = await mkdtemp(join(tmpdir(), "turbo-ts-outer-cargo-"));
    const directory = `${outer}/repository`;
    try {
      await cp(fixtureRoot, directory, { recursive: true });
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { futureFlags?: Record<string, boolean> };
      configuration.futureFlags = { experimentalCargoWorkspaces: true };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await mkdir(`${directory}/packages/rust-tool/src`, { recursive: true });
      await mkdir(`${outer}/sibling/src`, { recursive: true });
      await writeFile(
        `${outer}/Cargo.toml`,
        '[workspace]\nmembers = ["repository/packages/rust-tool", "sibling"]\nresolver = "3"\n',
      );
      await writeFile(
        `${directory}/packages/rust-tool/Cargo.toml`,
        '[package]\nname = "rust-tool"\nversion = "0.1.0"\nedition = "2024"\n',
      );
      await writeFile(
        `${outer}/sibling/Cargo.toml`,
        '[package]\nname = "sibling"\nversion = "0.1.0"\nedition = "2024"\n',
      );
      await writeFile(
        `${directory}/packages/rust-tool/src/lib.rs`,
        "pub fn value() {}\n",
      );
      await writeFile(`${outer}/sibling/src/lib.rs`, "pub fn value() {}\n");
      await cp(`${repositoryRoot}/rust-toolchain`, `${outer}/rust-toolchain`);
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      const cargoPackage = model.packagesByName.get("rust-tool")!;
      expect(cargoPackage.workspaceDirectory).toBeUndefined();
      expect(cargoPackage.cacheInputsComplete).toBe(false);
      const graph = buildTaskGraph(model, [cargoPackage], ["test"], false);
      const plan = planCargoWorkspaceTasks(model, graph, ["test"], true);
      expect(plan.scopes.size).toBe(0);
      expect(isTaskScopeCacheable(graph.nodes.get("rust-tool#test")!, [])).toBe(
        false,
      );
      expect(
        packageManagerCommand(graph.nodes.get("rust-tool#test")!, []),
      ).toEqual({
        command: "cargo",
        arguments: ["test", "--package=rust-tool", "--locked"],
        cwd: `${directory}/packages/rust-tool`,
      });
    } finally {
      await rm(outer, { force: true, recursive: true });
    }
  }, 20_000);

  it("propagates combined Cargo workspace hashes to dependents", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        tasks: Record<string, unknown>;
      };
      configuration.futureFlags = { experimentalCargoWorkspaces: true };
      configuration.tasks.test = {};
      configuration.tasks["//#verify"] = { dependsOn: ["rust-a#test"] };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const rootManifestPath = `${directory}/package.json`;
      const rootManifest = JSON.parse(
        await readFile(rootManifestPath, "utf8"),
      ) as { scripts: Record<string, string> };
      rootManifest.scripts.verify = "node -e \"console.log('root verify')\"";
      await writeFile(
        rootManifestPath,
        `${JSON.stringify(rootManifest, null, 2)}\n`,
      );
      for (const name of ["a", "b"]) {
        await mkdir(`${directory}/rust/${name}/src`, { recursive: true });
        await writeFile(
          `${directory}/rust/${name}/Cargo.toml`,
          `[package]\nname = "rust-${name}"\nversion = "0.1.0"\nedition = "2024"\n`,
        );
        await writeFile(
          `${directory}/rust/${name}/src/lib.rs`,
          `pub fn value() -> &'static str { "${name}" }\n`,
        );
      }
      await writeFile(
        `${directory}/rust/Cargo.toml`,
        '[workspace]\nmembers = ["a", "b"]\nresolver = "3"\n',
      );
      await cp(
        `${repositoryRoot}/rust-toolchain`,
        `${directory}/rust-toolchain`,
      );
      expect(
        (await run("cargo", ["generate-lockfile"], `${directory}/rust`))
          .exitCode,
      ).toBe(0);
      const args = [
        candidateEntrypoint,
        "run",
        "test",
        "//#verify",
        "--cwd",
        directory,
        "--output-logs=hash-only",
      ];
      const first = await run(process.execPath, args, repositoryRoot);
      expect(first.exitCode, first.stderr).toBe(0);
      expect(first.stdout).toContain("//:verify: cache miss");
      await writeFile(
        `${directory}/rust/b/src/lib.rs`,
        'pub fn value() -> &\'static str { "changed" }\n',
      );
      const second = await run(process.execPath, args, repositoryRoot);
      expect(second.exitCode, second.stderr).toBe(0);
      expect(second.stdout).toContain("//:verify: cache miss");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 60_000);

  it("reads uv project names and dependencies from their TOML sections", async () => {
    const directory = await makeFixture();
    const virtualEnvironmentDirectory = `${directory}/.venv`;
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
      await mkdir(`${directory}/python/helper`, { recursive: true });
      await mkdir(`${directory}/python/library`, { recursive: true });
      await mkdir(`${directory}/python/registry`, { recursive: true });
      await mkdir(`${directory}/python/excluded`, { recursive: true });
      await mkdir(`${directory}/examples/unrelated`, { recursive: true });
      const localHelperPath =
        process.platform === "win32" ? "../HELPER" : "../helper-link";
      if (process.platform !== "win32") {
        await symlink("helper", `${directory}/python/helper-link`);
      }
      if (process.platform !== "win32") {
        await mkdir(virtualEnvironmentDirectory, { recursive: true });
        await chmod(virtualEnvironmentDirectory, 0o000);
      }
      await writeFile(
        `${directory}/python/app/pyproject.toml`,
        `[tool.uv]\n` +
          `dev-dependencies = ["types-requests>=2"]\n` +
          `\n` +
          `[[tool.uv.index]]\n` +
          `name = "internal"\n` +
          `url = "https://example.test/simple"\n` +
          `\n` +
          `[tool.uv.sources]\n` +
          `my-util = { workspace = true }\n` +
          `local-helper = { path = ${JSON.stringify(localHelperPath)} }\n` +
          `requests = { index = "internal" }\n` +
          `\n` +
          `[project]\n` +
          `name = "app"\n` +
          `dependencies = ["local-helper>=1", "my-util>=1", "requests>=2"]\n` +
          `\n` +
          `[project.optional-dependencies]\n` +
          `test = ["pytest>=8"]\n` +
          `\n` +
          `[dependency-groups]\n` +
          `dev = ["ruff>=1", { include-group = "lint" }]\n` +
          `lint = ["mypy>=1"]\n`,
      );
      await writeFile(
        `${directory}/python/helper/pyproject.toml`,
        `[project]\nname = "local_helper"\ndependencies = []\n`,
      );
      await writeFile(
        `${directory}/python/library/pyproject.toml`,
        `[project]\nname = "my_util"\ndependencies = []\n`,
      );
      await writeFile(
        `${directory}/python/registry/pyproject.toml`,
        `[project]\nname = "requests"\ndependencies = []\n`,
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
        "local-helper",
        "my-util",
        "mypy",
        "pytest",
        "requests",
        "ruff",
        "types-requests",
      ]);
      expect(app?.internalDependencies).toEqual(["local_helper", "my_util"]);
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
      ).toEqual(["app#build", "local_helper#build", "my_util#build"]);

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
      if (process.platform !== "win32") {
        await chmod(virtualEnvironmentDirectory, 0o700).catch(() => undefined);
      }
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("loads package task configuration for uv workspace members", async () => {
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
      configuration.tasks.test = {};
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await writeFile(
        `${directory}/pyproject.toml`,
        '[tool.uv.workspace]\nmembers = ["python/*"]\n',
      );
      await mkdir(`${directory}/python/app`, { recursive: true });
      await mkdir(`${directory}/python/helper`, { recursive: true });
      await writeFile(
        `${directory}/python/app/pyproject.toml`,
        `[project]\n` +
          `name = "python-app"\n` +
          `dependencies = ["python-helper"]\n` +
          `\n` +
          `[tool.uv.sources]\n` +
          `python-helper = { workspace = true }\n`,
      );
      await writeFile(
        `${directory}/python/helper/pyproject.toml`,
        '[project]\nname = "python-helper"\ndependencies = []\n',
      );
      await writeFile(
        `${directory}/python/app/turbo.json`,
        `${JSON.stringify(
          {
            extends: ["//"],
            tasks: {
              build: { extends: false },
              test: {
                dependsOn: ["python-helper#build"],
                env: ["UV_APP_ENV"],
                outputs: ["reports/**"],
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      const app = model.packagesByName.get("python-app")!;
      expect(app.excludedTasks).toContain("build");
      expect(app.tasks.build).toBeUndefined();
      expect(app.tasks.test).toMatchObject({
        dependsOn: ["python-helper#build"],
        env: ["UV_APP_ENV"],
        outputs: ["reports/**"],
      });
      expect(
        buildTaskGraph(model, [app], ["build"], false).entrypoints,
      ).toEqual([]);
      expect(
        [...buildTaskGraph(model, [app], ["test"], false).nodes.keys()].sort(),
      ).toEqual(["python-app#test", "python-helper#build"]);
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

  it("includes Cargo workspace controls in member task hashes", async () => {
    const directory = await mkdtemp(join(packageRoot, "test-cargo-controls-"));
    await cp(fixtureRoot, directory, { recursive: true });
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        tasks: Record<string, { inputs?: Array<string> }>;
      };
      configuration.futureFlags = {
        experimentalCargoWorkspaces: true,
        filterUsingTasks: true,
      };
      configuration.tasks.test = { inputs: ["src/**"] };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await mkdir(`${directory}/rust/.cargo`, { recursive: true });
      await mkdir(`${directory}/rust/tool/src`, { recursive: true });
      const workspaceManifest = `${directory}/rust/Cargo.toml`;
      const cargoConfiguration = `${directory}/rust/.cargo/config.toml`;
      const toolchain = `${directory}/rust-toolchain`;
      await writeFile(
        workspaceManifest,
        '[workspace]\nmembers = ["tool"]\nresolver = "3"\n',
      );
      await writeFile(cargoConfiguration, "[build]\nincremental = false\n");
      await writeFile(
        `${directory}/rust/tool/Cargo.toml`,
        '[package]\nname = "rust-tool"\nversion = "0.1.0"\nedition = "2024"\n',
      );
      await writeFile(
        `${directory}/rust/tool/src/lib.rs`,
        "pub fn value() {}\n",
      );
      await writeFile(
        `${directory}/rust/Cargo.lock`,
        'version = 4\n\n[[package]]\nname = "rust-tool"\nversion = "0.1.0"\n',
      );
      await cp(`${repositoryRoot}/rust-toolchain`, toolchain);
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
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      const cargoPackage = model.packagesByName.get("rust-tool")!;
      const node = buildTaskGraph(
        model,
        [cargoPackage],
        ["test"],
        false,
      ).nodes.get("rust-tool#test")!;
      const compute = () =>
        Effect.runPromise(
          hashTask(model, node, [], true, [], `${directory}/.turbo/cache`).pipe(
            Effect.provide(nodeFoundationLayer),
          ),
        );
      const initial = await compute();
      expect(initial.inputFiles).toEqual(
        expect.arrayContaining([
          "$TURBO_ROOT$/rust-toolchain",
          "$TURBO_ROOT$/rust/.cargo/config.toml",
          "$TURBO_ROOT$/rust/Cargo.toml",
          "Cargo.toml",
          "src/lib.rs",
        ]),
      );
      await writeFile(
        workspaceManifest,
        `${await readFile(workspaceManifest, "utf8")}# workspace revision\n`,
      );
      const workspaceChanged = await compute();
      expect(workspaceChanged.hash).not.toBe(initial.hash);
      expect((await run("git", ["add", "."], directory)).exitCode).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "workspace control"], directory))
          .exitCode,
      ).toBe(0);
      const selected = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "test",
          "--cwd",
          directory,
          "--filter=[HEAD~1]",
          "--only",
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(selected.exitCode, selected.combinedOutput).toBe(0);
      expect(selected.stdout).toContain("rust-tool:test");
      await writeFile(
        cargoConfiguration,
        `${await readFile(cargoConfiguration, "utf8")}# config revision\n`,
      );
      const configurationChanged = await compute();
      expect(configurationChanged.hash).not.toBe(workspaceChanged.hash);
      await writeFile(
        toolchain,
        `${await readFile(toolchain, "utf8")}# toolchain revision\n`,
      );
      expect((await compute()).hash).not.toBe(configurationChanged.hash);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it("streams regular task inputs into Git blob digests", async () => {
    const directory = await makeFixture();
    const inputPath = `${directory}/packages/library/large-input.bin`;
    try {
      const contents = new Uint8Array(512 * 1024 + 17).fill(0x61);
      await writeFile(inputPath, contents);
      const expected = createHash("sha1")
        .update(`blob ${contents.length}\0`)
        .update(contents)
        .digest("hex");
      const streamed = await Effect.runPromise(
        Effect.gen(function* () {
          const digest = yield* DigestService;
          return yield* digest.gitBlobSha1File(inputPath);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(streamed).toBe(expected);
      const streamedXxhash = await Effect.runPromise(
        Effect.gen(function* () {
          const digest = yield* DigestService;
          return yield* digest.xxhash64File(inputPath);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(streamedXxhash).toBe(xxhash64Hex(contents));

      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      const node = buildTaskGraph(
        model,
        [model.packagesByName.get("synthetic-library")!],
        ["build"],
        false,
      ).nodes.get("synthetic-library#build")!;
      const result = await Effect.runPromise(
        hashTask(model, node, [], true, [], `${directory}/.turbo/cache`).pipe(
          Effect.provide(nodeFoundationLayer),
        ),
      );
      expect(result.inputFiles).toContain("large-input.bin");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

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

  it("preserves literal backslashes in POSIX Git input paths", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(packageRoot, "test-backslash-input-"));
    await cp(fixtureRoot, directory, { recursive: true });
    const inputPath = `${directory}/packages/library/src/a\\b.ts`;
    try {
      await mkdir(dirname(inputPath), { recursive: true });
      await writeFile(inputPath, "first\n");
      for (const args of [["init"], ["add", "."]]) {
        const result = await run("git", args, directory);
        expect(result.exitCode, `${args.join(" ")}: ${result.stderr}`).toBe(0);
      }
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      const library = model.packagesByName.get("synthetic-library")!;
      const node = buildTaskGraph(model, [library], ["build"], false).nodes.get(
        "synthetic-library#build",
      )!;
      const compute = () =>
        Effect.runPromise(
          hashTask(model, node, [], true, [], `${directory}/.turbo/cache`).pipe(
            Effect.provide(nodeFoundationLayer),
          ),
        );
      const initial = await compute();
      expect(initial.inputFiles).toContain("src/a\\b.ts");
      await writeFile(inputPath, "second\n");
      expect((await compute()).hash).not.toBe(initial.hash);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

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

  it("treats Git discovery and gitlink paths beginning with colons literally", async () => {
    const directory = await mkdtemp(
      join(packageRoot, "test-literal-pathspec-"),
    );
    const packageDirectory = `${directory}/:library`;
    const vendorDirectory = `${packageDirectory}/vendor`;
    try {
      await cp(fixtureRoot, directory, { recursive: true });
      await cp(`${directory}/packages/library`, packageDirectory, {
        recursive: true,
      });
      const workspacePath = `${directory}/pnpm-workspace.yaml`;
      await writeFile(
        workspacePath,
        `${await readFile(workspacePath, "utf8")}  - ':library'\n`,
      );
      const packageManifestPath = `${packageDirectory}/package.json`;
      const packageManifest = JSON.parse(
        await readFile(packageManifestPath, "utf8"),
      ) as { name: string };
      packageManifest.name = "colon-library";
      await writeFile(
        packageManifestPath,
        `${JSON.stringify(packageManifest, null, 2)}\n`,
      );
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, { inputs?: Array<string> }> };
      configuration.tasks.build!.inputs = ["input.txt", "vendor"];
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const inputPath = `${packageDirectory}/input.txt`;
      await writeFile(inputPath, "first\n");
      for (const args of [
        ["init"],
        ["config", "user.email", "synthetic@example.test"],
        ["config", "user.name", "Synthetic Fixture"],
        ["add", "."],
        ["commit", "-m", "first"],
      ]) {
        const result = await run("git", args, directory);
        expect(result.exitCode, `${args.join(" ")}: ${result.stderr}`).toBe(0);
      }
      const firstCommit = (
        await run("git", ["rev-parse", "HEAD"], directory)
      ).stdout.trim();
      await writeFile(`${directory}/revision.txt`, "second\n");
      expect(
        (await run("git", ["add", "revision.txt"], directory)).exitCode,
      ).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "second"], directory)).exitCode,
      ).toBe(0);
      const secondCommit = (
        await run("git", ["rev-parse", "HEAD"], directory)
      ).stdout.trim();
      await mkdir(vendorDirectory);
      const gitlinkPath = ":library/vendor";
      expect(
        (
          await run(
            "git",
            [
              "update-index",
              "--add",
              "--cacheinfo",
              `160000,${firstCommit},${gitlinkPath}`,
            ],
            directory,
          )
        ).exitCode,
      ).toBe(0);
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      const library = model.packagesByName.get("colon-library")!;
      const node = buildTaskGraph(model, [library], ["build"], false).nodes.get(
        "colon-library#build",
      )!;
      const compute = () =>
        Effect.runPromise(
          hashTask(model, node, [], true, [], `${directory}/.turbo/cache`).pipe(
            Effect.provide(nodeFoundationLayer),
          ),
        );
      const initial = await compute();
      expect(initial.inputFiles).toEqual(["input.txt", "vendor"]);
      await writeFile(inputPath, "changed\n");
      const changedInput = await compute();
      expect(changedInput.hash).not.toBe(initial.hash);
      expect(
        (
          await run(
            "git",
            [
              "update-index",
              "--add",
              "--cacheinfo",
              `160000,${secondCommit},${gitlinkPath}`,
            ],
            directory,
          )
        ).exitCode,
      ).toBe(0);
      expect((await compute()).hash).not.toBe(changedInput.hash);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);

  it("uses tracked Git executable modes independently of filesystem modes", async () => {
    const directory = await mkdtemp(join(packageRoot, "test-index-mode-"));
    const packageDirectory = `${directory}/packages/library`;
    const inputPath = `${packageDirectory}/input.txt`;
    try {
      await cp(fixtureRoot, directory, { recursive: true });
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
      expect((await run("git", ["init"], directory)).exitCode).toBe(0);
      expect((await run("git", ["add", "."], directory)).exitCode).toBe(0);
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      const library = model.packagesByName.get("synthetic-library")!;
      const node = buildTaskGraph(model, [library], ["build"], false).nodes.get(
        "synthetic-library#build",
      )!;
      const compute = () =>
        Effect.runPromise(
          hashTask(model, node, [], true, [], `${directory}/.turbo/cache`).pipe(
            Effect.provideService(EnvironmentService, {
              argv: Effect.succeed([]),
              cwd: Effect.succeed(directory),
              platform: Effect.succeed("win32" as const),
              get: () => Effect.succeed(undefined),
              entries: Effect.succeed({}),
            }),
            Effect.provide(nodeFoundationLayer),
          ),
        );
      const regular = await compute();
      expect(
        (
          await run(
            "git",
            ["update-index", "--chmod=+x", "--", "packages/library/input.txt"],
            directory,
          )
        ).exitCode,
      ).toBe(0);
      expect((await lstat(inputPath)).mode & 0o111).toBe(0);
      expect((await compute()).hash).not.toBe(regular.hash);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

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

  it("hashes tracked Git submodules as gitlinks", async () => {
    const directory = await mkdtemp(join(packageRoot, "test-gitlink-"));
    const vendorDirectory = `${directory}/packages/library/vendor`;
    try {
      await cp(fixtureRoot, directory, { recursive: true });
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, { inputs?: Array<string> }> };
      configuration.tasks.build!.inputs = ["vendor"];
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await mkdir(vendorDirectory, { recursive: true });
      for (const args of [
        ["init"],
        ["config", "user.email", "synthetic@example.test"],
        ["config", "user.name", "Synthetic Fixture"],
        ["add", "."],
        ["commit", "-m", "first"],
      ]) {
        const result = await run("git", args, directory);
        expect(result.exitCode, `${args.join(" ")}: ${result.stderr}`).toBe(0);
      }
      const firstCommit = (
        await run("git", ["rev-parse", "HEAD"], directory)
      ).stdout.trim();
      await writeFile(`${directory}/revision.txt`, "second\n");
      expect(
        (await run("git", ["add", "revision.txt"], directory)).exitCode,
      ).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "second"], directory)).exitCode,
      ).toBe(0);
      const secondCommit = (
        await run("git", ["rev-parse", "HEAD"], directory)
      ).stdout.trim();
      const gitlinkPath = "packages/library/vendor";
      expect(
        (
          await run(
            "git",
            [
              "update-index",
              "--add",
              "--cacheinfo",
              `160000,${firstCommit},${gitlinkPath}`,
            ],
            directory,
          )
        ).exitCode,
      ).toBe(0);
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      const library = model.packagesByName.get("synthetic-library")!;
      const node = buildTaskGraph(model, [library], ["build"], false).nodes.get(
        "synthetic-library#build",
      )!;
      const compute = () =>
        Effect.runPromise(
          hashTask(model, node, [], true, [], `${directory}/.turbo/cache`).pipe(
            Effect.provide(nodeFoundationLayer),
          ),
        );
      const first = await compute();
      expect(first.inputFiles).toContain("vendor");
      expect(
        (
          await run(
            "git",
            [
              "update-index",
              "--add",
              "--cacheinfo",
              `160000,${secondCommit},${gitlinkPath}`,
            ],
            directory,
          )
        ).exitCode,
      ).toBe(0);
      expect((await compute()).hash).not.toBe(first.hash);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);

  it("hashes descendants when an indexed file becomes a directory", async () => {
    const directory = await mkdtemp(
      join(packageRoot, "test-replacement-directory-"),
    );
    const packageDirectory = `${directory}/packages/library`;
    const replacementPath = `${packageDirectory}/replacement`;
    try {
      await cp(fixtureRoot, directory, { recursive: true });
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, { inputs?: Array<string> }> };
      configuration.tasks.build!.inputs = ["replacement", "replacement/**"];
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await writeFile(replacementPath, "indexed file\n");
      for (const args of [
        ["init"],
        ["config", "user.email", "synthetic@example.test"],
        ["config", "user.name", "Synthetic Fixture"],
        ["add", "."],
        ["commit", "-m", "record indexed file"],
      ]) {
        const result = await run("git", args, directory);
        expect(result.exitCode, `${args.join(" ")}: ${result.stderr}`).toBe(0);
      }
      await rm(replacementPath);
      await mkdir(replacementPath);
      const childPath = `${replacementPath}/child.txt`;
      await writeFile(childPath, "first\n");
      const discovered = await run(
        "git",
        [
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "--",
          "packages/library",
        ],
        directory,
      );
      expect(discovered.exitCode, discovered.stderr).toBe(0);
      expect(discovered.stdout).toContain(
        "packages/library/replacement/child.txt",
      );
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      const library = model.packagesByName.get("synthetic-library")!;
      const node = buildTaskGraph(model, [library], ["build"], false).nodes.get(
        "synthetic-library#build",
      )!;
      expect(node.definition.inputs).toEqual(["replacement", "replacement/**"]);
      const compute = () =>
        Effect.runPromise(
          hashTask(model, node, [], true, [], `${directory}/.turbo/cache`).pipe(
            Effect.provide(nodeFoundationLayer),
          ),
        );
      const initial = await compute();
      expect(initial.inputFiles).not.toContain("replacement");
      expect(initial.inputFiles).toContain("replacement/child.txt");
      await writeFile(childPath, "second\n");
      expect((await compute()).hash).not.toBe(initial.hash);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);

  it("selects workspace gitlink changes as task inputs", async () => {
    const directory = await mkdtemp(
      join(packageRoot, "test-workspace-gitlink-"),
    );
    try {
      await cp(fixtureRoot, directory, { recursive: true });
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
      };
      configuration.futureFlags = {
        affectedUsingTaskInputs: true,
        filterUsingTasks: true,
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      for (const args of [
        ["init"],
        ["config", "user.email", "synthetic@example.test"],
        ["config", "user.name", "Synthetic Fixture"],
        ["add", "."],
        ["commit", "-m", "fixture base"],
      ]) {
        const result = await run("git", args, directory);
        expect(result.exitCode, `${args.join(" ")}: ${result.stderr}`).toBe(0);
      }
      const firstCommit = (
        await run("git", ["rev-parse", "HEAD"], directory)
      ).stdout.trim();
      await writeFile(`${directory}/revision.txt`, "second\n");
      expect(
        (await run("git", ["add", "revision.txt"], directory)).exitCode,
      ).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "second revision"], directory))
          .exitCode,
      ).toBe(0);
      const secondCommit = (
        await run("git", ["rev-parse", "HEAD"], directory)
      ).stdout.trim();
      expect(
        (
          await run(
            "git",
            ["rm", "--cached", "-r", "packages/library"],
            directory,
          )
        ).exitCode,
      ).toBe(0);
      expect(
        (
          await run(
            "git",
            [
              "update-index",
              "--add",
              "--cacheinfo",
              `160000,${firstCommit},packages/library`,
            ],
            directory,
          )
        ).exitCode,
      ).toBe(0);
      expect(
        (
          await run(
            "git",
            ["commit", "-m", "record workspace gitlink"],
            directory,
          )
        ).exitCode,
      ).toBe(0);
      expect(
        (
          await run(
            "git",
            [
              "update-index",
              "--add",
              "--cacheinfo",
              `160000,${secondCommit},packages/library`,
            ],
            directory,
          )
        ).exitCode,
      ).toBe(0);
      expect(
        (
          await run(
            "git",
            ["commit", "-m", "advance workspace gitlink"],
            directory,
          )
        ).exitCode,
      ).toBe(0);
      expect(
        (
          await run("git", ["diff", "--name-only", "HEAD~1...HEAD"], directory)
        ).stdout.trim(),
      ).toBe("packages/library");

      for (const selection of [
        ["--affected"],
        ["--filter=...[HEAD~1...HEAD]"],
      ]) {
        const result = await run(
          process.execPath,
          [
            candidateEntrypoint,
            "run",
            "build",
            "--cwd",
            directory,
            "--no-cache",
            ...selection,
          ],
          repositoryRoot,
          { TURBO_SCM_BASE: "HEAD~1", TURBO_SCM_HEAD: "HEAD" },
        );
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stdout).toContain("library build");
        expect(result.stdout).toContain("app build");
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);

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

      const selectorOutput = `${directory}/selector-output`;
      const optionSelector = await execute(
        `[--output=${selectorOutput}...HEAD]`,
      );
      expect(optionSelector.exitCode).not.toBe(0);
      expect(optionSelector.stderr).toContain("invalid Git range filter");
      await expect(lstat(selectorOutput)).rejects.toThrow();

      const scmOutput = `${directory}/scm-output`;
      const optionEnvironment = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "--cwd",
          directory,
          "--affected",
          "--only",
          "--no-cache",
        ],
        repositoryRoot,
        { TURBO_SCM_BASE: `--output=${scmOutput}`, TURBO_SCM_HEAD: "HEAD" },
      );
      expect(optionEnvironment.exitCode).toBe(0);
      expect(optionEnvironment.stdout).toContain("app build");
      expect(optionEnvironment.stdout).toContain("library build");
      await expect(lstat(scmOutput)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);

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
      await writeFile(`${directory}/packages/app/Cargo.lock`, "version = 4\n");
      const result = await run(
        process.execPath,
        [candidateEntrypoint, "run", "build", "--no-cache"],
        `${directory}/packages/app`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("app build");
      expect(result.stdout).toContain("library build");
      expect(result.stdout).not.toContain("legacy build");
      await rm(`${directory}/packages/app/Cargo.lock`);
      await writeFile(`${directory}/packages/app/uv.lock`, "version = 1\n");
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

  it("preserves non-ASCII changed paths in task-aware affected selection", async () => {
    await mkdir(`${repositoryRoot}/.turbo`, { recursive: true });
    const directory = await mkdtemp(
      join(repositoryRoot, ".turbo/turbo-ts-unicode-affected-"),
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
      configuration.tasks.build = { cache: false, inputs: ["café.txt"] };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const changedPath = `${packageDirectory}/café.txt`;
      await writeFile(changedPath, "first\n");
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
      await writeFile(changedPath, "second\n");
      expect((await run("git", ["add", "."], directory)).exitCode).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "unicode input"], directory))
          .exitCode,
      ).toBe(0);
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "--cwd",
          directory,
          "--filter=synthetic-library",
          "--affected",
          "--only",
          "--no-cache",
        ],
        repositoryRoot,
        { TURBO_SCM_BASE: "HEAD~1", TURBO_SCM_HEAD: "HEAD" },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("library build");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("rejects Git discovery paths that are not valid UTF-8", async () => {
    expect(
      decodeNullDelimitedGitOutput(
        new TextEncoder().encode("packages/café.txt\0"),
        "/repo",
      ),
    ).toEqual(["packages/café.txt"]);
    expect(() =>
      decodeNullDelimitedGitOutput(
        new Uint8Array([0x70, 0x61, 0x74, 0x68, 0xff, 0]),
        "/repo",
      ),
    ).toThrow(/not valid UTF-8/);
    if (process.platform === "win32") return;

    const directory = await makeGitFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        tasks: Record<string, unknown>;
      };
      configuration.futureFlags = {
        ...configuration.futureFlags,
        affectedUsingTaskInputs: true,
      };
      configuration.tasks.check = { cache: false, inputs: ["known.txt"] };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const manifestPath = `${directory}/packages/library/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.check = "node -e \"console.log('library check')\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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
      const invalidPath = Buffer.concat([
        Buffer.from(`${directory}/packages/library/invalid-`),
        Buffer.from([0xff]),
      ]);
      await writeFile(invalidPath, "invalid\n");
      for (const args of [
        ["add", "."],
        ["commit", "-m", "invalid filename"],
      ]) {
        const git = await run("git", args, directory);
        expect(git.exitCode, `${args.join(" ")}: ${git.stderr}`).toBe(0);
      }
      const affected = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "check",
          "--cwd",
          directory,
          "--filter=synthetic-library",
          "--affected",
          "--only",
          "--no-cache",
        ],
        repositoryRoot,
        { TURBO_SCM_BASE: "HEAD~1", TURBO_SCM_HEAD: "HEAD" },
      );
      expect(affected.exitCode).not.toBe(0);
      expect(affected.stderr).toContain("not valid UTF-8");
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      const library = model.packagesByName.get("synthetic-library")!;
      const node = buildTaskGraph(model, [library], ["build"], false).nodes.get(
        "synthetic-library#build",
      )!;
      await expect(
        Effect.runPromise(
          hashTask(model, node, [], true, [], `${directory}/.turbo/cache`).pipe(
            Effect.provide(nodeFoundationLayer),
          ),
        ),
      ).rejects.toThrow(/not valid UTF-8/);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

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

  it("skips cache publication for output symlinks outside their output group", async () => {
    if (process.platform === "win32") return;
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, { outputs?: Array<string> }> };
      configuration.tasks.build = { outputs: ["dist/**"] };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.build =
        "node -e \"const fs=require('node:fs'); fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('source.txt','source'); fs.symlinkSync('../source.txt','dist/escape.txt'); console.log('unsafe output built')\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const args = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--filter=synthetic-library",
        "--only",
        "--output-logs=hash-only",
      ];
      const first = await run(process.execPath, args, repositoryRoot);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain("cache miss");
      expect(first.stderr).toContain("cache output collection failed");
      expect(first.stderr).toContain(
        "archive symlink target is not a declared task output",
      );
      await rm(`${packageDirectory}/dist`, { force: true, recursive: true });
      const second = await run(process.execPath, args, repositoryRoot);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("cache miss");
      expect(second.stderr).toContain("cache output collection failed");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("starts ready non-persistent with companions as one cohort", async () => {
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      configuration.tasks.check = { cache: false, with: ["serve"] };
      configuration.tasks.serve = { cache: false };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.check =
        "node -e \"const fs=require('node:fs'); fs.writeFileSync('check.started','1'); const started=Date.now(); const timer=setInterval(()=>{if(fs.existsSync('serve.started')){clearInterval(timer); console.log('check alongside serve')}else if(Date.now()-started>3000){clearInterval(timer); process.exit(7)}},10)\"";
      manifest.scripts.serve =
        "node -e \"const fs=require('node:fs'); fs.writeFileSync('serve.started','1'); const started=Date.now(); const timer=setInterval(()=>{if(fs.existsSync('check.started')){clearInterval(timer); console.log('serve alongside check')}else if(Date.now()-started>3000){clearInterval(timer); process.exit(8)}},10)\"";
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
          "--concurrency=2",
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("check alongside serve");
      expect(result.stdout).toContain("serve alongside check");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("waits for a complete foreground companion cohort", async () => {
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      configuration.tasks.check = {
        cache: false,
        with: ["setup", "serve"],
      };
      configuration.tasks.setup = { cache: false };
      configuration.tasks.serve = {
        cache: false,
        dependsOn: ["setup"],
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.setup =
        "node -e \"setTimeout(() => require('node:fs').writeFileSync('setup.done','1'), 150)\"";
      manifest.scripts.check =
        "node -e \"const fs=require('node:fs'); if(!fs.existsSync('setup.done')) process.exit(7); fs.writeFileSync('check.started','1'); const started=Date.now(); const timer=setInterval(()=>{if(fs.existsSync('serve.started')){clearInterval(timer); console.log('check alongside serve')}else if(Date.now()-started>3000){clearInterval(timer); process.exit(8)}},10)\"";
      manifest.scripts.serve =
        "node -e \"const fs=require('node:fs'); if(!fs.existsSync('setup.done')) process.exit(9); fs.writeFileSync('serve.started','1'); const started=Date.now(); const timer=setInterval(()=>{if(fs.existsSync('check.started')){clearInterval(timer); console.log('serve alongside check')}else if(Date.now()-started>3000){clearInterval(timer); process.exit(10)}},10)\"";
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
          "--concurrency=2",
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(await readFile(`${packageDirectory}/setup.done`, "utf8")).toBe(
        "1",
      );
      expect(result.stdout).toContain("check alongside serve");
      expect(result.stdout).toContain("serve alongside check");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("rejects concurrency too small for a ready with cohort", async () => {
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      configuration.tasks.check = { cache: false, with: ["serve"] };
      configuration.tasks.serve = { cache: false };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.check =
        "node -e \"require('node:fs').writeFileSync('check.ran','1')\"";
      manifest.scripts.serve =
        "node -e \"require('node:fs').writeFileSync('serve.ran','1')\"";
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
      expect(result.stderr).toContain(
        "with group requires at least 2 foreground concurrency slots",
      );
      await expect(lstat(`${packageDirectory}/check.ran`)).rejects.toThrow();
      await expect(lstat(`${packageDirectory}/serve.ran`)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

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

  it("stops serial owners after a shared-companion owner fails", async () => {
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
        manifest.scripts.check =
          packageName === "app"
            ? "node -e \"require('node:fs').writeFileSync('app.ran','1'); process.exit(7)\""
            : "node -e \"require('node:fs').writeFileSync('library.ran','1')\"";
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
      expect(result.exitCode).not.toBe(0);
      expect(await readFile(`${directory}/packages/app/app.ran`, "utf8")).toBe(
        "1",
      );
      await expect(
        lstat(`${directory}/packages/library/library.ran`),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("shares one foreground concurrency budget across with groups", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      configuration.tasks.check = {
        cache: false,
        with: ["//#serve-check"],
      };
      configuration.tasks.verify = {
        cache: false,
        with: ["//#serve-verify"],
      };
      configuration.tasks["//#serve-check"] = {
        cache: false,
        persistent: true,
      };
      configuration.tasks["//#serve-verify"] = {
        cache: false,
        persistent: true,
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const command = (label: string) =>
        `node -e "const fs=require('node:fs'); const slots=['../../foreground-0.lock','../../foreground-1.lock']; let handle; let slot; for (const candidate of slots) { try { handle=fs.openSync(candidate,'wx'); slot=candidate; break; } catch {} } if (handle===undefined) process.exit(9); setTimeout(() => { fs.closeSync(handle); fs.unlinkSync(slot); console.log('${label}'); }, 250);"`;
      for (const packageName of ["app", "library"]) {
        const manifestPath = `${directory}/packages/${packageName}/package.json`;
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          scripts: Record<string, string>;
        };
        manifest.scripts.check = command(`${packageName} check`);
        manifest.scripts.verify = command(`${packageName} verify`);
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      const rootManifestPath = `${directory}/package.json`;
      const rootManifest = JSON.parse(
        await readFile(rootManifestPath, "utf8"),
      ) as { scripts: Record<string, string> };
      rootManifest.scripts["serve-check"] =
        'node -e "setInterval(() => {}, 1000)"';
      rootManifest.scripts["serve-verify"] =
        'node -e "setInterval(() => {}, 1000)"';
      await writeFile(
        rootManifestPath,
        `${JSON.stringify(rootManifest, null, 2)}\n`,
      );
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "check",
          "verify",
          "--cwd",
          directory,
          "--concurrency=2",
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("app check");
      expect(result.stdout).toContain("library check");
      expect(result.stdout).toContain("app verify");
      expect(result.stdout).toContain("library verify");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  it("refills concurrency when an individual task group finishes", async () => {
    const directory = await makeFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      for (const task of ["//#a-slow", "//#b-fast", "//#c-release"]) {
        configuration.tasks[task] = { cache: false };
      }
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const manifestPath = `${directory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts["a-slow"] =
        "node -e \"const fs=require('node:fs'); const started=Date.now(); const timer=setInterval(()=>{if(fs.existsSync('release.marker')){clearInterval(timer); console.log('slow released')}else if(Date.now()-started>3000){clearInterval(timer); process.exit(7)}},10)\"";
      manifest.scripts["b-fast"] = "node -e \"console.log('fast complete')\"";
      manifest.scripts["c-release"] =
        "node -e \"require('node:fs').writeFileSync('release.marker','1')\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "//#a-slow",
          "//#b-fast",
          "//#c-release",
          "--cwd",
          directory,
          "--concurrency=2",
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("fast complete");
      expect(result.stdout).toContain("slow released");
      expect(await readFile(`${directory}/release.marker`, "utf8")).toBe("1");
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

  it("waits for dependencies before starting persistent companions", async () => {
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      configuration.tasks.check = {
        cache: false,
        with: ["setup", "serve"],
      };
      configuration.tasks.setup = { cache: false };
      configuration.tasks.serve = {
        cache: false,
        dependsOn: ["setup"],
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
      manifest.scripts.setup =
        "node -e \"setTimeout(() => require('node:fs').writeFileSync('setup.done','1'), 100)\"";
      manifest.scripts.serve =
        "node -e \"const fs=require('node:fs'); if(!fs.existsSync('setup.done')) process.exit(8); fs.writeFileSync('serve.ready','1'); setInterval(()=>{},1000)\"";
      manifest.scripts.check =
        "node -e \"const fs=require('node:fs'); const started=Date.now(); const timer=setInterval(()=>{if(fs.existsSync('serve.ready')){fs.writeFileSync('check.done','1'); clearInterval(timer)}else if(Date.now()-started>3000){process.exit(7)}},10)\"";
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
      expect(await readFile(`${packageDirectory}/setup.done`, "utf8")).toBe(
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

  it("detects effective Cargo-home configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-cargo-home-"));
    const homeDirectory = `${directory}/home`;
    const relativeCargoHome = `${directory}/custom-cargo-home`;
    const precedenceCargoHome = `${directory}/precedence-cargo-home`;
    const detect = (
      environment: Readonly<Record<string, string | undefined>>,
      caseInsensitiveEnvironmentNames = false,
    ) =>
      Effect.runPromise(
        cargoHomeConfigurationPresent(
          directory,
          environment,
          caseInsensitiveEnvironmentNames,
        ).pipe(Effect.provide(nodeFoundationLayer)),
      );
    try {
      await mkdir(`${homeDirectory}/.cargo`, { recursive: true });
      await writeFile(
        `${homeDirectory}/.cargo/config.toml`,
        '[build]\nrustflags = ["--cfg", "home_flag"]\n',
      );
      expect(await detect({ HOME: homeDirectory })).toBe(true);
      expect(await detect({ home: homeDirectory }, true)).toBe(true);

      await mkdir(relativeCargoHome, { recursive: true });
      await writeFile(
        `${relativeCargoHome}/config.toml`,
        "[net]\noffline = true\n",
      );
      expect(await detect({ CARGO_HOME: "custom-cargo-home" })).toBe(true);

      await mkdir(precedenceCargoHome, { recursive: true });
      await writeFile(
        `${precedenceCargoHome}/config.toml`,
        '[build]\ntarget = "synthetic-target"\n',
      );
      await writeFile(`${precedenceCargoHome}/config`, "[build]\njobs = 1\n");
      expect(await detect({ CARGO_HOME: precedenceCargoHome })).toBe(true);
      expect(await detect({})).toBe(false);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps Cargo discovery locked and disables configured target caching", async () => {
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/rust-target`;
    const lockfilePath = `${packageDirectory}/Cargo.lock`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        tasks: Record<string, Record<string, unknown>>;
      };
      configuration.futureFlags = { experimentalCargoWorkspaces: true };
      configuration.tasks.build = {
        ...configuration.tasks.build,
        cache: true,
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await mkdir(`${packageDirectory}/src`, { recursive: true });
      await mkdir(`${packageDirectory}/vendor/helper/src`, { recursive: true });
      await writeFile(
        `${packageDirectory}/Cargo.toml`,
        '[package]\nname = "rust-target"\nversion = "0.1.0"\nedition = "2024"\n\n[dependencies]\nhelper = { path = "vendor/helper" }\n',
      );
      await writeFile(`${packageDirectory}/src/main.rs`, "fn main() {}\n");
      await writeFile(
        `${packageDirectory}/vendor/helper/Cargo.toml`,
        '[package]\nname = "helper"\nversion = "0.1.0"\nedition = "2024"\n',
      );
      await writeFile(
        `${packageDirectory}/vendor/helper/src/lib.rs`,
        "pub fn value() {}\n",
      );
      await cp(
        `${repositoryRoot}/rust-toolchain`,
        `${directory}/rust-toolchain`,
      );
      const discover = () =>
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        });
      const metadataRequests: Array<{
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      }> = [];
      const packageId = `path+file://${packageDirectory}#rust-target@0.1.0`;
      const metadataProcessLayer = Layer.succeed(ProcessService, {
        run: (request) => {
          metadataRequests.push(request);
          const stdout = JSON.stringify({
            workspace_root: packageDirectory,
            workspace_members: [packageId],
            target_directory: `${packageDirectory}/target`,
            packages: [
              {
                id: packageId,
                name: "rust-target",
                manifest_path: `${packageDirectory}/Cargo.toml`,
                dependencies: [
                  {
                    name: "helper",
                    path: `${packageDirectory}/vendor/helper`,
                  },
                ],
                targets: [{ kind: ["bin"], name: "rust-target" }],
              },
            ],
          });
          return Effect.succeed({
            exitCode: 0,
            stdout,
            stderr: "",
            combinedOutput: stdout,
          });
        },
        runBytes: () => Effect.die("unexpected binary process request"),
      });
      await Effect.runPromise(
        discover().pipe(
          Effect.provide(metadataProcessLayer),
          Effect.provide(nodeFoundationLayer),
        ),
      );
      expect(metadataRequests).toHaveLength(1);
      expect(metadataRequests[0]).toMatchObject({
        command: "cargo",
        args: [
          "metadata",
          "--format-version=1",
          "--no-deps",
          "--locked",
          "--manifest-path",
          `${packageDirectory}/Cargo.toml`,
        ],
      });
      await expect(lstat(lockfilePath)).rejects.toThrow();

      const generated = await run(
        "cargo",
        [
          "generate-lockfile",
          "--manifest-path",
          `${packageDirectory}/Cargo.toml`,
        ],
        packageDirectory,
      );
      expect(generated.exitCode, generated.stderr).toBe(0);
      const rustc = await run("rustc", ["-vV"], packageDirectory);
      expect(rustc.exitCode, rustc.stderr).toBe(0);
      const host = /^host: (.+)$/m.exec(rustc.stdout)?.[1];
      expect(host).toBeDefined();
      await mkdir(`${packageDirectory}/.cargo`, { recursive: true });
      await writeFile(
        `${packageDirectory}/.cargo/config.toml`,
        `[build]\ntarget = ${JSON.stringify(host)}\n`,
      );
      const configuredTarget = await Effect.runPromise(
        discover().pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(
        configuredTarget.packagesByName.get("rust-target")?.tasks.build,
      ).toMatchObject({ cache: false });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);

  it("disables caching for colliding Cargo binary outputs", async () => {
    const directory = await makeFixture();
    const workspaceDirectory = `${directory}/packages/rust-workspace`;
    const firstDirectory = `${workspaceDirectory}/first`;
    const secondDirectory = `${workspaceDirectory}/second`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        tasks: Record<string, Record<string, unknown>>;
      };
      configuration.futureFlags = {
        ...configuration.futureFlags,
        experimentalCargoWorkspaces: true,
      };
      configuration.tasks.build = {
        ...configuration.tasks.build,
        cache: true,
      };
      delete configuration.tasks.build.outputs;
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await mkdir(firstDirectory, { recursive: true });
      await mkdir(secondDirectory, { recursive: true });
      await writeFile(
        `${workspaceDirectory}/Cargo.toml`,
        '[workspace]\nmembers = ["first", "second"]\nresolver = "3"\n',
      );
      await writeFile(
        `${firstDirectory}/Cargo.toml`,
        '[package]\nname = "rust-first"\nversion = "0.1.0"\nedition = "2024"\n\n[[bin]]\nname = "shared-tool"\npath = "src/main.rs"\n',
      );
      await writeFile(
        `${secondDirectory}/Cargo.toml`,
        '[package]\nname = "rust-second"\nversion = "0.1.0"\nedition = "2024"\n\n[[bin]]\nname = "shared-tool"\npath = "src/main.rs"\n',
      );
      const firstId = `path+file://${firstDirectory}#rust-first@0.1.0`;
      const secondId = `path+file://${secondDirectory}#rust-second@0.1.0`;
      const stdout = JSON.stringify({
        workspace_root: workspaceDirectory,
        workspace_members: [firstId, secondId],
        target_directory: `${workspaceDirectory}/target`,
        packages: [
          {
            id: firstId,
            name: "rust-first",
            manifest_path: `${firstDirectory}/Cargo.toml`,
            dependencies: [],
            targets: [{ kind: ["bin"], name: "shared-tool" }],
          },
          {
            id: secondId,
            name: "rust-second",
            manifest_path: `${secondDirectory}/Cargo.toml`,
            dependencies: [],
            targets: [{ kind: ["bin"], name: "shared-tool" }],
          },
        ],
      });
      const metadataProcessLayer = Layer.succeed(ProcessService, {
        run: () =>
          Effect.succeed({
            exitCode: 0,
            stdout,
            stderr: "",
            combinedOutput: stdout,
          }),
        runBytes: () => Effect.die("unexpected binary process request"),
      });
      const model = await Effect.runPromise(
        Effect.gen(function* () {
          const rootConfiguration = yield* loadRootConfiguration(directory);
          return yield* discoverRepository(directory, rootConfiguration);
        }).pipe(
          Effect.provide(metadataProcessLayer),
          Effect.provide(nodeFoundationLayer),
        ),
      );
      const output =
        "$TURBO_ROOT$/packages/rust-workspace/target/debug/shared-tool";
      for (const packageName of ["rust-first", "rust-second"]) {
        expect(
          model.packagesByName.get(packageName)?.tasks.build,
        ).toMatchObject({
          cache: false,
          outputs: [output, `${output}.exe`, `${output}.pdb`],
        });
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("restores implicit Cargo binary outputs and leaves libraries uncached", async () => {
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/rust-tool`;
    const libraryDirectory = `${directory}/packages/rust-library`;
    const mixedDirectory = `${directory}/packages/rust-mixed`;
    const multiBinaryDirectory = `${directory}/packages/rust-multi`;
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
      await mkdir(`${mixedDirectory}/src`, { recursive: true });
      await writeFile(
        `${mixedDirectory}/Cargo.toml`,
        '[package]\nname = "synthetic-rust-mixed"\nversion = "0.1.0"\nedition = "2024"\n',
      );
      await writeFile(`${mixedDirectory}/src/main.rs`, "fn main() {}\n");
      await writeFile(`${mixedDirectory}/src/lib.rs`, "pub fn value() {}\n");
      await mkdir(`${multiBinaryDirectory}/src/bin`, { recursive: true });
      await writeFile(
        `${multiBinaryDirectory}/Cargo.toml`,
        '[package]\nname = "synthetic-rust-multi"\nversion = "0.1.0"\nedition = "2024"\n',
      );
      await writeFile(
        `${multiBinaryDirectory}/src/bin/first.rs`,
        "fn main() {}\n",
      );
      await writeFile(
        `${multiBinaryDirectory}/src/bin/second.rs`,
        "fn main() {}\n",
      );
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
      ).toEqual([
        "$TURBO_ROOT$/packages/rust-tool/target/debug/synthetic-rust-tool",
        "$TURBO_ROOT$/packages/rust-tool/target/debug/synthetic-rust-tool.exe",
        "$TURBO_ROOT$/packages/rust-tool/target/debug/synthetic-rust-tool.pdb",
      ]);
      expect(
        model.packagesByName.get("synthetic-rust-library")?.tasks.build,
      ).toMatchObject({ cache: false });
      expect(
        model.packagesByName.get("synthetic-rust-mixed")?.tasks.build,
      ).toMatchObject({ cache: false });
      expect(
        model.packagesByName.get("synthetic-rust-tool")?.tasks.format,
      ).toMatchObject({ cache: false });
      expect(
        model.packagesByName.get("synthetic-rust-tool")?.scripts,
      ).toMatchObject({ dev: "cargo run", run: "cargo run" });
      expect(
        model.packagesByName.get("synthetic-rust-tool")?.tasks.dev,
      ).toMatchObject({ cache: false });
      expect(
        model.packagesByName.get("synthetic-rust-tool")?.tasks.run,
      ).toMatchObject({ cache: false });
      expect(
        model.packagesByName.get("synthetic-rust-multi")?.scripts.run,
      ).toBeUndefined();
      expect(
        model.packagesByName.get("synthetic-rust-multi")?.scripts.dev,
      ).toBeUndefined();
      const cargoBuildNode = buildTaskGraph(
        model,
        [model.packagesByName.get("synthetic-rust-tool")!],
        ["build"],
        false,
      ).nodes.get("synthetic-rust-tool#build")!;
      expect(
        isTaskScopeCacheable(cargoBuildNode, [
          "--config",
          'build.target-dir="custom"',
        ]),
      ).toBe(false);
      expect(
        isTaskScopeCacheable(cargoBuildNode, [
          "--config=build.target-dir=custom",
        ]),
      ).toBe(false);
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
      const pdb = `${packageDirectory}/target/debug/synthetic-rust-tool.pdb`;
      expect((await lstat(executable)).isFile()).toBe(true);
      const archivedPdb = await readFile(pdb).catch(() => undefined);
      await rm(`${packageDirectory}/target`, { force: true, recursive: true });
      const warm = await run(process.execPath, args, repositoryRoot);
      expect(warm.exitCode).toBe(0);
      expect(warm.stdout).toContain("cache hit");
      expect((await lstat(executable)).isFile()).toBe(true);
      if (archivedPdb === undefined) {
        await expect(lstat(pdb)).rejects.toThrow();
      } else {
        expect(await readFile(pdb)).toEqual(archivedPdb);
      }
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

      const ambientTargetDirectory = `${packageDirectory}/ambient-target`;
      await rm(`${packageDirectory}/target`, {
        force: true,
        recursive: true,
      });
      const mismatchedTargetCold = await run(
        process.execPath,
        args,
        repositoryRoot,
        { CARGO_TARGET_DIR: ambientTargetDirectory },
      );
      expect(mismatchedTargetCold.exitCode).toBe(0);
      expect(mismatchedTargetCold.stdout).not.toContain("cache hit");
      expect((await lstat(executable)).isFile()).toBe(true);
      await rm(`${packageDirectory}/target`, {
        force: true,
        recursive: true,
      });
      const mismatchedTargetWarm = await run(
        process.execPath,
        args,
        repositoryRoot,
        { CARGO_TARGET_DIR: ambientTargetDirectory },
      );
      expect(mismatchedTargetWarm.exitCode).toBe(0);
      expect(mismatchedTargetWarm.stdout).not.toContain("cache hit");
      expect((await lstat(executable)).isFile()).toBe(true);
      await expect(
        lstat(
          `${ambientTargetDirectory}/debug/synthetic-rust-tool${
            process.platform === "win32" ? ".exe" : ""
          }`,
        ),
      ).rejects.toThrow();
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

  it("restores nested node_modules within declared outputs", async () => {
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    const bundledDependency = `${packageDirectory}/bundle/node_modules/synthetic-dependency/index.js`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: { build: { outputs: Array<string> } } };
      configuration.tasks.build.outputs = ["bundle/node_modules/**"];
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.build =
        "node -e \"const fs=require('node:fs'); fs.mkdirSync('bundle/node_modules/synthetic-dependency',{recursive:true}); fs.writeFileSync('bundle/node_modules/synthetic-dependency/index.js','bundled'); console.log('built bundle')\"";
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
      const cold = await run(process.execPath, args, repositoryRoot);
      expect(cold.exitCode).toBe(0);
      expect(cold.stdout).toContain("cache miss");
      await rm(`${packageDirectory}/bundle`, { force: true, recursive: true });
      await rm(`${packageDirectory}/.turbo`, { force: true, recursive: true });
      const warm = await run(process.execPath, args, repositoryRoot);
      expect(warm.exitCode).toBe(0);
      expect(warm.stdout).toContain("cache hit");
      expect(await readFile(bundledDependency, "utf8")).toBe("bundled");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("prunes unrelated node_modules during output collection", async () => {
    if (process.platform === "win32") return;
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    const unreadableDirectory = `${packageDirectory}/node_modules/unreadable`;
    try {
      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.build =
        "node -e \"const fs=require('node:fs'); fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/value.txt','built'); console.log('built dist')\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await mkdir(unreadableDirectory, { recursive: true });
      await chmod(unreadableDirectory, 0o000);
      const args = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--filter=synthetic-library",
        "--output-logs=hash-only",
      ];
      const cold = await run(process.execPath, args, repositoryRoot);
      expect(cold.exitCode, cold.stderr).toBe(0);
      expect(cold.stdout).toContain("cache miss");
      expect(cold.stderr).not.toContain("cache output collection failed");
      await rm(`${packageDirectory}/dist`, { force: true, recursive: true });
      await rm(`${packageDirectory}/.turbo`, { force: true, recursive: true });
      const warm = await run(process.execPath, args, repositoryRoot);
      expect(warm.exitCode, warm.stderr).toBe(0);
      expect(warm.stdout).toContain("cache hit");
      expect(await readFile(`${packageDirectory}/dist/value.txt`, "utf8")).toBe(
        "built",
      );
    } finally {
      await chmod(unreadableDirectory, 0o700).catch(() => undefined);
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("restores empty declared output directories from cache", async () => {
    const directory = await makeFixture();
    const packageDirectory = `${directory}/packages/library`;
    try {
      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.build =
        "node -e \"require('node:fs').mkdirSync('dist', { recursive: true }); console.log('created empty dist')\"";
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
      expect(
        (await run(process.execPath, args, repositoryRoot)).stdout,
      ).toContain("cache miss");
      await rm(`${packageDirectory}/dist`, { recursive: true });
      await rm(`${packageDirectory}/.turbo`, { force: true, recursive: true });
      expect(
        (await run(process.execPath, args, repositoryRoot)).stdout,
      ).toContain("cache hit");
      expect((await lstat(`${packageDirectory}/dist`)).isDirectory()).toBe(
        true,
      );
      expect(await readdir(`${packageDirectory}/dist`)).toEqual([]);
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

  it("treats root task configuration changes as task-aware inputs", async () => {
    const directory = await makeGitFixture();
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        tasks: Record<string, Record<string, unknown>>;
      };
      configuration.futureFlags = {
        affectedUsingTaskInputs: true,
        filterUsingTasks: true,
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
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
      configuration.tasks.build = {
        ...configuration.tasks.build,
        env: ["CONFIG_ONLY_CHANGE"],
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      expect(
        (await run("git", ["add", "turbo.json"], directory)).exitCode,
      ).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "task configuration"], directory))
          .exitCode,
      ).toBe(0);
      const common = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--no-cache",
      ];
      const affected = await run(
        process.execPath,
        [...common, "--affected"],
        repositoryRoot,
        { TURBO_SCM_BASE: "HEAD~1", TURBO_SCM_HEAD: "HEAD" },
      );
      expect(affected.exitCode).toBe(0);
      expect(affected.stdout).toContain("library build");
      expect(affected.stdout).toContain("app build");

      const filtered = await run(
        process.execPath,
        [...common, "--filter=[HEAD~1]"],
        repositoryRoot,
      );
      expect(filtered.exitCode).toBe(0);
      expect(filtered.stdout).toContain("library build");
      expect(filtered.stdout).toContain("app build");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("treats package model files as task-aware inputs", async () => {
    const directory = await makeGitFixture();
    const packageDirectory = `${directory}/packages/library`;
    try {
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        tasks: Record<string, Record<string, unknown>>;
      };
      configuration.futureFlags = {
        affectedUsingTaskInputs: true,
        filterUsingTasks: true,
      };
      configuration.tasks.build = {
        ...configuration.tasks.build,
        inputs: ["src/**"],
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await mkdir(`${packageDirectory}/src`, { recursive: true });
      await writeFile(`${packageDirectory}/src/input.ts`, "export {};\n");
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

      const manifestPath = `${packageDirectory}/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.build =
        "node -e \"console.log('package manifest build')\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      expect(
        (await run("git", ["add", "packages/library/package.json"], directory))
          .exitCode,
      ).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "package manifest"], directory))
          .exitCode,
      ).toBe(0);
      const affected = await run(
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
      expect(affected.exitCode).toBe(0);
      expect(affected.stdout).toContain("package manifest build");

      const workspaceConfigurationPath = `${packageDirectory}/turbo.json`;
      await writeFile(
        workspaceConfigurationPath,
        `${JSON.stringify(
          {
            extends: ["//"],
            tasks: { build: { env: ["PACKAGE_CONFIGURATION_CHANGED"] } },
          },
          null,
          2,
        )}\n`,
      );
      expect(
        (await run("git", ["add", "packages/library/turbo.json"], directory))
          .exitCode,
      ).toBe(0);
      expect(
        (
          await run(
            "git",
            ["commit", "-m", "package task configuration"],
            directory,
          )
        ).exitCode,
      ).toBe(0);
      const filtered = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "--cwd",
          directory,
          "--filter=[HEAD~1]",
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(filtered.exitCode).toBe(0);
      expect(filtered.stdout).toContain("package manifest build");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

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
      configuration.tasks["//#root-readme-check"] = {
        inputs: ["$TURBO_ROOT$/README.md"],
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
      rootManifest.scripts["root-readme-check"] =
        "node -e \"console.log('root readme affected check')\"";
      await writeFile(
        rootManifestPath,
        `${JSON.stringify(rootManifest, null, 2)}\n`,
      );
      await writeFile(`${directory}/packages/library/README.md`, "first\n");
      await writeFile(
        `${directory}/pnpm-lock.yaml`,
        "lockfileVersion: '9.0'\nrevision: 1\n",
      );
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

      await writeFile(`${directory}/README.md`, "root documentation\n");
      expect((await run("git", ["add", "."], directory)).exitCode).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "root readme"], directory)).exitCode,
      ).toBe(0);
      const unrelatedRootResult = await run(
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
      expect(unrelatedRootResult.exitCode).toBe(0);
      expect(unrelatedRootResult.stdout).not.toContain("library build");
      expect(unrelatedRootResult.stdout).not.toContain("app build");
      const matchingRootResult = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "//#root-readme-check",
          "--cwd",
          directory,
          "--affected",
          "--no-cache",
        ],
        repositoryRoot,
        { TURBO_SCM_BASE: "HEAD~1", TURBO_SCM_HEAD: "HEAD" },
      );
      expect(matchingRootResult.exitCode).toBe(0);
      expect(matchingRootResult.stdout).toContain("root readme affected check");

      await writeFile(
        `${directory}/pnpm-lock.yaml`,
        "lockfileVersion: '9.0'\nrevision: 2\n",
      );
      expect((await run("git", ["add", "."], directory)).exitCode).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "lockfile"], directory)).exitCode,
      ).toBe(0);
      const lockfileResult = await run(
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
      expect(lockfileResult.exitCode).toBe(0);
      expect(lockfileResult.stdout).toContain("library build");
      expect(lockfileResult.stdout).toContain("app build");

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
  }, 20_000);

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

  it("unions package and task-aware Git filters", async () => {
    await mkdir(`${repositoryRoot}/.turbo`, { recursive: true });
    const directory = await mkdtemp(
      join(repositoryRoot, ".turbo/turbo-ts-task-filter-union-"),
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
        manifest.scripts.check = `node -e "console.log('${packageName} union')"`;
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
      await writeFile(`${directory}/packages/library/source.txt`, "second\n");
      expect((await run("git", ["add", "."], directory)).exitCode).toBe(0);
      expect(
        (await run("git", ["commit", "-m", "library input"], directory))
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
          "--filter=synthetic-app",
          "--filter=[HEAD~1]",
          "--only",
          "--no-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("app union");
      expect(result.stdout).toContain("library union");
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

  it("requires workspace configuration to extend only the root", async () => {
    const directory = await makeFixture();
    try {
      const workspacePath = `${directory}/packages/app/turbo.json`;
      const workspace = JSON.parse(await readFile(workspacePath, "utf8")) as {
        extends: Array<string>;
      };
      const args = [candidateEntrypoint, "run", "build", "--cwd", directory];
      for (const parents of [
        ["//", "another-config"],
        ["//", "//"],
      ]) {
        workspace.extends = parents;
        await writeFile(
          workspacePath,
          `${JSON.stringify(workspace, null, 2)}\n`,
        );
        const result = await run(process.execPath, args, repositoryRoot);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('must extend "//"');
      }
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
  it("bounds cumulative tar metadata while parsing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-tar-metadata-"));
    const archivePath = `${directory}/archive.tar`;
    try {
      const archive = createTarArchive(
        ["first", "second", "third"].map((name) => ({
          path: `dist/${name}`,
          kind: "directory" as const,
          mode: 0o755,
          modifiedSeconds: 1,
        })),
      );
      await writeFile(archivePath, archive);
      await expect(
        Effect.runPromise(
          parseTarArchiveFile(archivePath, tarBlockSize * 2).pipe(
            Effect.provide(nodeFoundationLayer),
          ),
        ),
      ).rejects.toThrow(/archive metadata exceeds/);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rolls back restored outputs when archive cleanup fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-cleanup-"));
    const path = "output/result.txt";
    try {
      const outcome = await Effect.runPromise(
        restoreArchiveEntries(
          directory,
          [
            {
              path,
              contents: new TextEncoder().encode("cached"),
              mode: 0o644,
              modifiedSeconds: 1,
            },
          ],
          allowCachePaths("**"),
          Effect.fail(
            new CacheError({
              path: "temporary-archive",
              message: "directory is locked",
              retryable: false,
            }),
          ),
        ).pipe(Effect.either, Effect.provide(nodeFoundationLayer)),
      );
      expect(outcome._tag).toBe("Left");
      await expect(lstat(`${directory}/${path}`)).rejects.toThrow();
      await expect(lstat(`${directory}/output`)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("cleans atomic-write temporaries after rename failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-cache-temp-"));
    const cacheDirectory = `${directory}/cache`;
    const hash = "0102030405060708";
    try {
      await mkdir(`${cacheDirectory}/${hash}.tar.zst`, { recursive: true });
      await expect(
        Effect.runPromise(
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
        ),
      ).rejects.toThrow();
      expect(
        (await readdir(cacheDirectory)).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
      expect(
        (await readdir(cacheDirectory)).filter((name) =>
          name.endsWith(".turbo-ts.lock"),
        ),
      ).toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("surfaces atomic-write cleanup failures after rename failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-cache-cleanup-"));
    const cacheDirectory = `${directory}/cache`;
    const hash = "1112131415161718";
    try {
      await mkdir(`${cacheDirectory}/${hash}.tar.zst`, { recursive: true });
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystemService;
          const failingLayer = Layer.succeed(FileSystemService, {
            ...fileSystem,
            remove: (path) =>
              path.endsWith(".tmp")
                ? fileSystem.exists(path).pipe(
                    Effect.flatMap((exists) =>
                      exists
                        ? Effect.fail(
                            new BoundaryError({
                              boundary: "filesystem",
                              message: "temporary file is locked",
                              retryable: false,
                            }),
                          )
                        : fileSystem.remove(path),
                    ),
                  )
                : fileSystem.remove(path),
          });
          return yield* writeLocalCache(
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
          ).pipe(Effect.exit, Effect.provide(failingLayer));
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(Exit.isFailure(outcome)).toBe(true);
      if (Exit.isFailure(outcome)) {
        expect(Cause.pretty(outcome.cause)).toContain(
          "atomic write cleanup failed: temporary file is locked",
        );
      }
      expect(
        (await readdir(cacheDirectory)).some((name) => name.endsWith(".tmp")),
      ).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("surfaces cache writer-lock release failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-lock-release-"));
    const cacheDirectory = `${directory}/cache`;
    const hash = "1817161514131211";
    const lockPath = `${cacheDirectory}/${hash}.turbo-ts.lock`;
    try {
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystemService;
          const failingLayer = Layer.succeed(FileSystemService, {
            ...fileSystem,
            remove: (path) =>
              path === lockPath
                ? Effect.fail(
                    new BoundaryError({
                      boundary: "filesystem",
                      message: "writer lock is held by a scanner",
                      retryable: false,
                    }),
                  )
                : fileSystem.remove(path),
          });
          return yield* writeLocalCache(
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
          ).pipe(Effect.exit, Effect.provide(failingLayer));
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(Exit.isFailure(outcome)).toBe(true);
      if (Exit.isFailure(outcome)) {
        expect(Cause.pretty(outcome.cause)).toContain(
          "cache writer lock release failed: writer lock is held by a scanner",
        );
      }
      expect((await lstat(lockPath)).isFile()).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

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

  it("waits for active cache writers before evicting their entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-cache-locked-"));
    const cacheDirectory = `${directory}/cache`;
    const hash = "0123456789abcdef";
    const archivePath = `${cacheDirectory}/${hash}.tar.zst`;
    const lockPath = `${cacheDirectory}/${hash}.turbo-ts.lock`;
    try {
      await mkdir(cacheDirectory, { recursive: true });
      await writeFile(archivePath, "partially published archive");
      await writeFile(
        lockPath,
        JSON.stringify({
          owner: "00000000-0000-7000-8000-000000000000",
          createdAt: Date.now(),
        }),
      );
      const eviction = Effect.runPromise(
        evictLocalCache({ directory: cacheDirectory, maxSizeBytes: 1 }).pipe(
          Effect.provide(nodeFoundationLayer),
        ),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 75));
      try {
        expect((await lstat(archivePath)).isFile()).toBe(true);
      } finally {
        await rm(lockPath, { force: true });
      }
      await eviction;
      await expect(lstat(archivePath)).rejects.toThrow();
      await expect(lstat(lockPath)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("aggregates cache entry removal failures during eviction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-cache-evict-"));
    const cacheDirectory = `${directory}/cache`;
    const hash = "0123456789abcdef";
    const paths = [
      `${cacheDirectory}/${hash}.tar.zst`,
      `${cacheDirectory}/${hash}-manifest.json`,
      `${cacheDirectory}/${hash}-meta.json`,
    ];
    try {
      await mkdir(cacheDirectory, { recursive: true });
      for (const path of paths) await writeFile(path, "cached");
      const attempted: Array<string> = [];
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystemService;
          const failingLayer = Layer.succeed(FileSystemService, {
            ...fileSystem,
            remove: (path) => {
              if (path.endsWith(".turbo-ts.lock")) {
                return fileSystem.remove(path);
              }
              attempted.push(path);
              return Effect.fail(
                new BoundaryError({
                  boundary: "filesystem",
                  message: `synthetic removal failure for ${path}`,
                  retryable: false,
                }),
              );
            },
          });
          return yield* evictLocalCache({
            directory: cacheDirectory,
            maxSizeBytes: 1,
          }).pipe(Effect.either, Effect.provide(failingLayer));
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(outcome._tag).toBe("Left");
      if (outcome._tag === "Left") {
        expect(outcome.left.message).toContain("cleanup failed");
        for (const path of paths) expect(outcome.left.message).toContain(path);
      }
      expect(attempted.sort()).toEqual([...paths].sort());
      for (const path of paths) expect((await lstat(path)).isFile()).toBe(true);
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
          allowCachePaths("packages/library/.turbo/turbo-build.log"),
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

  it("streams local cache decompression through scoped temporary storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-local-stream-"));
    const cacheDirectory = `${directory}/cache`;
    const hash = "0123456789abcdef";
    const outputPath = "packages/app/output.txt";
    let compressedArtifactPath: string | undefined;
    let temporaryArchivePath: string | undefined;
    try {
      await Effect.runPromise(
        writeLocalCache(
          { directory: cacheDirectory },
          hash,
          [
            {
              path: outputPath,
              contents: new TextEncoder().encode("streamed local output\n"),
              mode: 0o644,
              modifiedSeconds: 1,
            },
          ],
          1,
        ).pipe(Effect.provide(nodeFoundationLayer)),
      );
      const restored = await Effect.runPromise(
        Effect.gen(function* () {
          const compression = yield* CompressionService;
          const streamingCompressionLayer = Layer.succeed(CompressionService, {
            ...compression,
            decompressZstd: () =>
              Effect.fail(
                new BoundaryError({
                  boundary: "compression",
                  message: "in-memory decompression must not be used",
                  retryable: false,
                }),
              ),
            decompressZstdToFile: () =>
              Effect.fail(
                new BoundaryError({
                  boundary: "compression",
                  message: "buffered local decompression must not be used",
                  retryable: false,
                }),
              ),
            decompressZstdFileToFile: (source, destination, maxOutputBytes) => {
              compressedArtifactPath = source;
              temporaryArchivePath = destination;
              return compression.decompressZstdFileToFile(
                source,
                destination,
                maxOutputBytes,
              );
            },
          });
          return yield* restoreLocalCache(
            directory,
            { directory: cacheDirectory },
            hash,
            allowCachePaths("**"),
          ).pipe(Effect.provide(streamingCompressionLayer));
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(restored).toBe(true);
      expect(await readFile(`${directory}/${outputPath}`, "utf8")).toBe(
        "streamed local output\n",
      );
      expect(compressedArtifactPath).toBe(`${cacheDirectory}/${hash}.tar.zst`);
      expect(temporaryArchivePath).toBeDefined();
      await expect(lstat(temporaryArchivePath!)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("warns and falls back when a local cache artifact is corrupt", async () => {
    const directory = await makeFixture();
    const cacheDirectory = `${directory}/.turbo/cache`;
    try {
      const args = [
        candidateEntrypoint,
        "run",
        "build",
        "--cwd",
        directory,
        "--filter=synthetic-library",
        "--output-logs=hash-only",
      ];
      const cold = await run(process.execPath, args, repositoryRoot);
      expect(cold.exitCode).toBe(0);
      expect(cold.stdout).toContain("cache miss");
      const archiveName = (await readdir(cacheDirectory)).find((name) =>
        name.endsWith(".tar.zst"),
      );
      expect(archiveName).toBeDefined();
      const archivePath = `${cacheDirectory}/${archiveName!}`;
      await writeFile(archivePath, "corrupt");
      const fallback = await run(
        process.execPath,
        [...args, "--cache=local:r"],
        repositoryRoot,
      );
      expect(fallback.exitCode).toBe(0);
      expect(fallback.stdout).toContain("cache miss");
      expect(fallback.stderr).toContain("local cache restore failed");
      expect(fallback.stderr).toContain("continuing without local cache");
      await expect(lstat(archivePath)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

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
            allowCachePaths("**"),
          ).pipe(Effect.provide(nodeFoundationLayer)),
        ),
      ).toBe(true);
      await writeFile(`${cacheDirectory}/0123456789abcdef.tar.zst`, "corrupt");
      await expect(
        Effect.runPromise(
          restoreLocalCache(
            directory,
            { directory: cacheDirectory },
            "0123456789abcdef",
            allowCachePaths("**"),
          ).pipe(Effect.provide(nodeFoundationLayer)),
        ),
      ).rejects.toThrow();
      await expect(
        lstat(`${cacheDirectory}/0123456789abcdef.tar.zst`),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects oversized local cache artifacts before reading them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-cache-limit-"));
    const cacheDirectory = `${directory}/.turbo/cache`;
    const hash = "0123456789abcdef";
    const archivePath = `${cacheDirectory}/${hash}.tar.zst`;
    try {
      await mkdir(cacheDirectory, { recursive: true });
      await writeFile(archivePath, "");
      await truncate(archivePath, maximumCacheArtifactBytes + 1);
      await expect(
        Effect.runPromise(
          restoreLocalCache(
            directory,
            { directory: cacheDirectory },
            hash,
            allowCachePaths("**"),
          ).pipe(Effect.provide(nodeFoundationLayer)),
        ),
      ).rejects.toThrow(/exceeds/);
      await expect(lstat(archivePath)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rolls back partial cache restorations before fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-rollback-"));
    const entries = [
      {
        path: "output/nested/first.txt",
        contents: new TextEncoder().encode("first"),
        mode: 0o644,
        modifiedSeconds: 1,
      },
      {
        path: "output/nested/second.txt",
        contents: new TextEncoder().encode("second"),
        mode: 0o644,
        modifiedSeconds: 1,
      },
    ];
    const restore = (rollbackFails: boolean) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystemService;
          const failingLayer = Layer.succeed(FileSystemService, {
            ...fileSystem,
            writeBytes: (path, contents) =>
              path.endsWith("second.txt")
                ? fileSystem.writeBytes(path, contents.subarray(0, 1)).pipe(
                    Effect.zipRight(
                      Effect.fail(
                        new BoundaryError({
                          boundary: "filesystem",
                          message: "synthetic restore failure",
                          retryable: false,
                        }),
                      ),
                    ),
                  )
                : fileSystem.writeBytes(path, contents),
            remove: (path) =>
              rollbackFails && path.endsWith("first.txt")
                ? Effect.fail(
                    new BoundaryError({
                      boundary: "filesystem",
                      message: "synthetic rollback failure",
                      retryable: false,
                    }),
                  )
                : fileSystem.remove(path),
          });
          return yield* restoreArchiveEntries(
            directory,
            entries,
            allowCachePaths("**"),
          ).pipe(Effect.either, Effect.provide(failingLayer));
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
    try {
      const safeFailure = await restore(false);
      expect(safeFailure._tag).toBe("Left");
      await expect(
        lstat(`${directory}/output/nested/first.txt`),
      ).rejects.toThrow();
      await expect(
        lstat(`${directory}/output/nested/second.txt`),
      ).rejects.toThrow();
      await expect(lstat(`${directory}/output`)).rejects.toThrow();
      const unsafeFailure = await restore(true);
      expect(unsafeFailure._tag).toBe("Left");
      if (unsafeFailure._tag === "Left") {
        expect(unsafeFailure.left._tag).toBe("CacheRollbackError");
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("preserves rollback failures when corrupt entry cleanup also fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-rollback-cache-"));
    const cacheDirectory = `${directory}/cache`;
    const hash = "1234567890abcdef";
    const entries = [
      {
        path: "output/first.txt",
        contents: new TextEncoder().encode("first"),
        mode: 0o644,
        modifiedSeconds: 1,
      },
      {
        path: "output/second.txt",
        contents: new TextEncoder().encode("second"),
        mode: 0o644,
        modifiedSeconds: 1,
      },
    ];
    try {
      await Effect.runPromise(
        writeLocalCache({ directory: cacheDirectory }, hash, entries, 1).pipe(
          Effect.provide(nodeFoundationLayer),
        ),
      );
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystemService;
          const failingLayer = Layer.succeed(FileSystemService, {
            ...fileSystem,
            copyBytesRange: (source, offset, length, destination) =>
              destination.endsWith("second.txt")
                ? fileSystem
                    .copyBytesRange(source, offset, length, destination)
                    .pipe(
                      Effect.zipRight(
                        Effect.fail(
                          new BoundaryError({
                            boundary: "filesystem",
                            message: "synthetic restore failure",
                            retryable: false,
                          }),
                        ),
                      ),
                    )
                : fileSystem.copyBytesRange(
                    source,
                    offset,
                    length,
                    destination,
                  ),
            remove: (path) =>
              path.endsWith("first.txt") ||
              path.startsWith(`${cacheDirectory}/`)
                ? Effect.fail(
                    new BoundaryError({
                      boundary: "filesystem",
                      message: path.endsWith("first.txt")
                        ? "synthetic rollback failure"
                        : "synthetic cache cleanup failure",
                      retryable: false,
                    }),
                  )
                : fileSystem.remove(path),
          });
          return yield* restoreLocalCache(
            directory,
            { directory: cacheDirectory },
            hash,
            allowCachePaths("**"),
          ).pipe(Effect.either, Effect.provide(failingLayer));
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(outcome._tag).toBe("Left");
      if (outcome._tag === "Left") {
        expect(outcome.left._tag).toBe("CacheRollbackError");
        expect(outcome.left.message).toContain("synthetic rollback failure");
        expect(outcome.left.message).toContain(
          "synthetic cache cleanup failure",
        );
      }
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
            allowCachePaths("**"),
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
            allowCachePaths("**"),
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
      await expect(
        Effect.runPromise(
          restoreLocalCache(
            directory,
            { directory: cacheDirectory },
            "fedcba9876543210",
            allowCachePaths("**"),
          ).pipe(Effect.provide(nodeFoundationLayer)),
        ),
      ).rejects.toThrow(/escaping symlink/);
      await expect(lstat(`${outside}/app`)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("treats output negations as restore deny rules", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-output-deny-"));
    const scope: CacheRestoreScope = {
      pathsToClear: [],
      allowedPathGroups: [
        { directory: ".", patterns: ["!dist/private/**", "dist/**"] },
      ],
      regularFilePaths: [],
    };
    const entry = {
      path: "dist/private/secret.txt",
      contents: new TextEncoder().encode("secret\n"),
      mode: 0o644,
      modifiedSeconds: 1,
    };
    try {
      const denied = await Effect.runPromise(
        restoreArchiveEntries(directory, [entry], scope).pipe(
          Effect.either,
          Effect.provide(nodeFoundationLayer),
        ),
      );
      expect(denied._tag).toBe("Left");
      if (denied._tag === "Left") {
        expect(denied.left.message).toContain("not a declared task output");
      }
      await expect(lstat(`${directory}/${entry.path}`)).rejects.toThrow();

      await Effect.runPromise(
        restoreArchiveEntries(
          directory,
          [{ ...entry, path: "dist/public.txt" }],
          scope,
        ).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(await readFile(`${directory}/dist/public.txt`, "utf8")).toBe(
        "secret\n",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects non-directory archive ancestors before clearing outputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-cache-tree-"));
    const preserved = `${directory}/preserved.txt`;
    const child = {
      path: "dist/a/result.txt",
      contents: new TextEncoder().encode("child\n"),
      mode: 0o644,
      modifiedSeconds: 1,
    };
    const ancestors = [
      {
        path: "dist/a",
        contents: new TextEncoder().encode("parent\n"),
        mode: 0o644,
        modifiedSeconds: 1,
      },
      {
        kind: "symlink" as const,
        path: "dist/a",
        linkTarget: "result.txt",
        contents: new Uint8Array(),
        mode: 0o777,
        modifiedSeconds: 1,
      },
    ];
    const scope: CacheRestoreScope = {
      pathsToClear: ["preserved.txt"],
      allowedPathGroups: [{ directory: ".", patterns: ["dist/**"] }],
      regularFilePaths: [],
    };
    try {
      await writeFile(`${directory}/package.json`, "{}\n");
      await writeFile(preserved, "preserved\n");
      for (const ancestor of ancestors) {
        for (const entries of [
          [child, ancestor],
          [ancestor, child],
        ]) {
          const outcome = await Effect.runPromise(
            restoreArchiveEntries(directory, entries, scope).pipe(
              Effect.either,
              Effect.provide(nodeFoundationLayer),
            ),
          );
          expect(outcome._tag).toBe("Left");
          if (outcome._tag === "Left") {
            expect(outcome.left.message).toContain(
              "contains another destination",
            );
          }
          expect(await readFile(preserved, "utf8")).toBe("preserved\n");
        }
      }

      await Effect.runPromise(
        restoreArchiveEntries(
          directory,
          [
            {
              kind: "directory",
              path: "dist/a",
              mode: 0o755,
              modifiedSeconds: 1,
            },
            child,
          ],
          { ...scope, pathsToClear: [] },
        ).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(await readFile(`${directory}/${child.path}`, "utf8")).toBe(
        "child\n",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects case-colliding archive destinations on case-insensitive filesystems", async () => {
    const entries = [
      {
        path: "dist/A.txt",
        contents: new TextEncoder().encode("upper\n"),
        mode: 0o644,
        modifiedSeconds: 1,
      },
      {
        path: "dist/a.txt",
        contents: new TextEncoder().encode("lower\n"),
        mode: 0o644,
        modifiedSeconds: 1,
      },
    ];
    expect(duplicateArchiveEntryDestination("C:/repo", entries, true)).toBe(
      "C:/repo/dist/a.txt",
    );
    expect(duplicateArchiveEntryDestination("/repo", entries, true)).toBe(
      "/repo/dist/a.txt",
    );
    expect(
      duplicateArchiveEntryDestination("/repo", entries, false),
    ).toBeUndefined();
    if (process.platform !== "win32") return;

    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-case-cache-"));
    const preserved = `${directory}/dist/preserved.txt`;
    try {
      await mkdir(`${directory}/dist`, { recursive: true });
      await writeFile(preserved, "preserved\n");
      const outcome = await Effect.runPromise(
        restoreArchiveEntries(directory, entries, {
          pathsToClear: ["dist"],
          allowedPathGroups: [{ directory: ".", patterns: ["dist/**"] }],
          regularFilePaths: [],
        }).pipe(Effect.either, Effect.provide(nodeFoundationLayer)),
      );
      expect(outcome._tag).toBe("Left");
      if (outcome._tag === "Left") {
        expect(outcome.left.message).toContain(
          "archive destination occurs more than once",
        );
      }
      expect(await readFile(preserved, "utf8")).toBe("preserved\n");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("detects case-insensitive POSIX restore roots before clearing outputs", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "turbo-ts-posix-case-cache-"),
    );
    const preserved = `${directory}/preserved.txt`;
    const entries = [
      {
        path: "dist/A.txt",
        contents: new TextEncoder().encode("upper\n"),
        mode: 0o644,
        modifiedSeconds: 1,
      },
      {
        path: "dist/a.txt",
        contents: new TextEncoder().encode("lower\n"),
        mode: 0o644,
        modifiedSeconds: 1,
      },
    ];
    try {
      await writeFile(`${directory}/package.json`, "{}\n");
      await writeFile(preserved, "preserved\n");
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystemService;
          const caseInsensitiveLayer = Layer.succeed(FileSystemService, {
            ...fileSystem,
            exists: (path) =>
              path === `${directory}/Package.json` ||
              path === `${directory}/Preserved.txt`
                ? Effect.succeed(true)
                : fileSystem.exists(path),
          });
          return yield* restoreArchiveEntries(directory, entries, {
            pathsToClear: ["preserved.txt"],
            allowedPathGroups: [{ directory: ".", patterns: ["dist/**"] }],
            regularFilePaths: [],
          }).pipe(Effect.either, Effect.provide(caseInsensitiveLayer));
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(outcome._tag).toBe("Left");
      if (outcome._tag === "Left") {
        expect(outcome.left.message).toContain(
          "archive destination occurs more than once",
        );
      }
      expect(await readFile(preserved, "utf8")).toBe("preserved\n");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects restored symlinks whose targets leave their output group", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-output-target-"));
    const existingOutput = `${directory}/packages/app/dist/existing.txt`;
    try {
      await mkdir(`${directory}/packages/app/dist`, { recursive: true });
      await writeFile(`${directory}/.env`, "TOP_SECRET=value\n");
      await writeFile(existingOutput, "preserved\n");
      const restored = await Effect.runPromise(
        restoreArchiveEntries(
          directory,
          [
            {
              kind: "symlink",
              path: "packages/app/dist/secret",
              linkTarget: "../../../.env",
              contents: new Uint8Array(),
              mode: 0o777,
              modifiedSeconds: 1,
            },
          ],
          {
            pathsToClear: ["packages/app/dist"],
            allowedPathGroups: [
              { directory: "packages/app", patterns: ["dist/**"] },
            ],
            regularFilePaths: [],
          },
        ).pipe(Effect.either, Effect.provide(nodeFoundationLayer)),
      );
      expect(restored._tag).toBe("Left");
      if (restored._tag === "Left") {
        expect(restored.left.message).toContain(
          "link target is not a declared task output",
        );
      }
      expect(await readFile(existingOutput, "utf8")).toBe("preserved\n");
      await expect(
        lstat(`${directory}/packages/app/dist/secret`),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects restored symlinks through existing target symlink components", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(
      join(tmpdir(), "turbo-ts-output-target-component-"),
    );
    const outside = await mkdtemp(
      join(tmpdir(), "turbo-ts-output-target-outside-"),
    );
    const preserved = `${directory}/dist/preserved.txt`;
    try {
      await mkdir(`${directory}/dist`, { recursive: true });
      await writeFile(`${outside}/secret.txt`, "outside\n");
      await writeFile(preserved, "preserved\n");
      await symlink(outside, `${directory}/dist/nested`);
      const restored = await Effect.runPromise(
        restoreArchiveEntries(
          directory,
          [
            {
              kind: "symlink",
              path: "dist/link.txt",
              linkTarget: "nested/secret.txt",
              contents: new Uint8Array(),
              mode: 0o777,
              modifiedSeconds: 1,
            },
          ],
          {
            pathsToClear: ["dist/preserved.txt"],
            allowedPathGroups: [
              { directory: ".", patterns: ["dist/**/*.txt"] },
            ],
            regularFilePaths: [],
          },
        ).pipe(Effect.either, Effect.provide(nodeFoundationLayer)),
      );
      expect(restored._tag).toBe("Left");
      if (restored._tag === "Left") {
        expect(restored.left.message).toContain("symlink component");
      }
      expect(await readFile(preserved, "utf8")).toBe("preserved\n");
      await expect(lstat(`${directory}/dist/link.txt`)).rejects.toThrow();
      expect(await readFile(`${outside}/secret.txt`, "utf8")).toBe("outside\n");
    } finally {
      await rm(directory, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("rejects writes through archive-created output symlinks", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-output-link-"));
    const sourcePath = `${directory}/packages/app/src/index.ts`;
    try {
      await mkdir(`${directory}/packages/app/src`, { recursive: true });
      await writeFile(sourcePath, "preserved\n");
      const restored = await Effect.runPromise(
        restoreArchiveEntries(
          directory,
          [
            {
              kind: "symlink",
              path: "packages/app/dist/link",
              linkTarget: "../src",
              contents: new Uint8Array(),
              mode: 0o777,
              modifiedSeconds: 1,
            },
            {
              path: "packages/app/dist/link/index.ts",
              contents: new TextEncoder().encode("overwritten\n"),
              mode: 0o644,
              modifiedSeconds: 1,
            },
          ],
          {
            pathsToClear: ["packages/app/dist"],
            allowedPathGroups: [
              { directory: "packages/app", patterns: ["dist/**"] },
            ],
            regularFilePaths: [],
          },
        ).pipe(Effect.either, Effect.provide(nodeFoundationLayer)),
      );
      expect(restored._tag).toBe("Left");
      if (restored._tag === "Left") {
        expect(restored.left.message).toContain("symlink");
      }
      expect(await readFile(sourcePath, "utf8")).toBe("preserved\n");
      await expect(lstat(`${directory}/packages/app/dist`)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects cached task-log symlinks before restoration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-log-symlink-"));
    const logPath = "packages/app/.turbo/turbo-build.log";
    try {
      await writeFile(`${directory}/.env`, "TOP_SECRET=value\n");
      const restored = await Effect.runPromise(
        restoreArchiveEntries(
          directory,
          [
            {
              kind: "symlink",
              path: logPath,
              linkTarget: "../../../.env",
              contents: new Uint8Array(),
              mode: 0o777,
              modifiedSeconds: 1,
            },
          ],
          {
            pathsToClear: [],
            allowedPathGroups: [{ directory: ".", patterns: [logPath] }],
            regularFilePaths: [logPath],
          },
        ).pipe(Effect.either, Effect.provide(nodeFoundationLayer)),
      );
      expect(restored._tag).toBe("Left");
      if (restored._tag === "Left") {
        expect(restored.left.message).toContain("not a regular file");
      }
      await expect(lstat(`${directory}/${logPath}`)).rejects.toThrow();
      expect(await readFile(`${directory}/.env`, "utf8")).toBe(
        "TOP_SECRET=value\n",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("replaces hard-linked task logs without modifying external files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-log-hardlink-"));
    const externalPath = `${directory}-external.txt`;
    const logPath = "packages/app/.turbo/turbo-build.log";
    const destination = `${directory}/${logPath}`;
    try {
      await writeFile(externalPath, "external contents\n");
      await mkdir(dirname(destination), { recursive: true });
      await link(externalPath, destination);
      await Effect.runPromise(
        restoreArchiveEntries(
          directory,
          [
            {
              path: logPath,
              contents: new TextEncoder().encode("cached output\n"),
              mode: 0o644,
              modifiedSeconds: 1,
            },
          ],
          {
            pathsToClear: [],
            allowedPathGroups: [],
            regularFilePaths: [logPath],
          },
        ).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(await readFile(externalPath, "utf8")).toBe("external contents\n");
      expect(await readFile(destination, "utf8")).toBe("cached output\n");
    } finally {
      await rm(directory, { force: true, recursive: true });
      await rm(externalPath, { force: true });
    }
  });

  it("matches required task-log paths literally during restoration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-literal-log-"));
    const logPath = "packages/[app]/.turbo/turbo-build.log";
    const entry = {
      path: logPath,
      contents: new TextEncoder().encode("cached output\n"),
      mode: 0o644,
      modifiedSeconds: 1,
    };
    const scope: CacheRestoreScope = {
      pathsToClear: [],
      allowedPathGroups: [],
      regularFilePaths: [logPath],
    };
    try {
      await Effect.runPromise(
        restoreArchiveEntries(directory, [entry], scope).pipe(
          Effect.provide(nodeFoundationLayer),
        ),
      );
      expect(await readFile(`${directory}/${logPath}`, "utf8")).toBe(
        "cached output\n",
      );
      const wildcardSibling = await Effect.runPromise(
        restoreArchiveEntries(
          directory,
          [{ ...entry, path: "packages/a/.turbo/turbo-build.log" }],
          scope,
        ).pipe(Effect.either, Effect.provide(nodeFoundationLayer)),
      );
      expect(wildcardSibling._tag).toBe("Left");
      if (wildcardSibling._tag === "Left") {
        expect(wildcardSibling.left.message).toContain(
          "not a declared task output",
        );
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("requires exactly one regular task log before clearing outputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-log-required-"));
    const logPath = "packages/app/.turbo/turbo-build.log";
    const logEntry = {
      path: logPath,
      contents: new TextEncoder().encode("cached output\n"),
      mode: 0o644,
      modifiedSeconds: 1,
    };
    try {
      for (const [entries, message] of [
        [[], "missing"],
        [[logEntry, logEntry], "more than once"],
      ] as const) {
        await writeFile(`${directory}/preserved.txt`, "preserved\n");
        const restored = await Effect.runPromise(
          restoreArchiveEntries(directory, entries, {
            pathsToClear: ["preserved.txt"],
            allowedPathGroups: [
              { directory: ".", patterns: [logPath, "preserved.txt"] },
            ],
            regularFilePaths: [logPath],
          }).pipe(Effect.either, Effect.provide(nodeFoundationLayer)),
        );
        expect(restored._tag).toBe("Left");
        if (restored._tag === "Left") {
          expect(restored.left.message).toContain(message);
        }
        expect(await readFile(`${directory}/preserved.txt`, "utf8")).toBe(
          "preserved\n",
        );
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("falls back to execution when local cache probing fails", async () => {
    const directory = await makeFixture();
    try {
      await writeFile(`${directory}/blocked-cache`, "not a directory\n");
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "--cwd",
          directory,
          "--filter=synthetic-library",
          "--cache=local:r",
          "--cache-dir=blocked-cache",
        ],
        repositoryRoot,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("library build");
      expect(result.stderr).toContain("local cache restore failed");
      expect(result.stderr).toContain("continuing without local cache");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

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

  it("rejects undeclared paths from unsigned remote cache artifacts", async () => {
    const directory = await makeFixture();
    let artifact = new Uint8Array();
    const server = createServer((request, response) => {
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.method === "PUT") {
          artifact = new Uint8Array(Buffer.concat(chunks));
          response.writeHead(201);
          response.end();
          return;
        }
        response.writeHead(200, {
          "content-type": "application/octet-stream",
        });
        response.end(artifact);
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
    const manifestPath = `${directory}/packages/library/package.json`;
    try {
      const originalManifest = await readFile(manifestPath, "utf8");
      await Effect.runPromise(
        writeRemoteCache(
          options,
          "poisoned000000000",
          [
            {
              path: "packages/library/dist/poisoned.txt",
              contents: new TextEncoder().encode("poisoned output\n"),
              mode: 0o644,
              modifiedSeconds: 1,
            },
            {
              path: "packages/library/package.json",
              contents: new TextEncoder().encode('{"name":"poisoned"}\n'),
              mode: 0o644,
              modifiedSeconds: 1,
            },
          ],
          1,
        ).pipe(Effect.provide(nodeFoundationLayer)),
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
          "--cache=remote:r",
        ],
        repositoryRoot,
        { TURBO_API: options.apiUrl },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("library build");
      expect(result.stderr).toContain("remote cache restore failed");
      expect(await readFile(manifestPath, "utf8")).toBe(originalManifest);
      await expect(
        lstat(`${directory}/packages/library/dist/poisoned.txt`),
      ).rejects.toThrow();
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

  it("continues remote upload when a local cache write fails", async () => {
    const directory = await makeFixture();
    let uploads = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        if (request.method === "PUT") uploads += 1;
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
      const manifestPath = `${directory}/packages/library/package.json`;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.build =
        "node -e \"const fs=require('node:fs'); fs.writeFileSync('../../local-cache-blocker','blocked'); console.log('library build')\"";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const result = await run(
        process.execPath,
        [
          candidateEntrypoint,
          "run",
          "build",
          "--cwd",
          directory,
          "--filter=synthetic-library",
          "--cache=local:w,remote:w",
          "--cache-dir=local-cache-blocker",
          "--output-logs=hash-only",
        ],
        repositoryRoot,
        { TURBO_API: `http://127.0.0.1:${address.port}` },
      );
      expect(result.exitCode).toBe(0);
      expect(uploads).toBe(1);
      expect(result.stderr).toContain("local cache write failed");
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
          restoreRemoteCache(
            directory,
            options,
            "abcdefabcdefabcd",
            allowCachePaths("**"),
          ).pipe(Effect.provide(nodeFoundationLayer)),
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
    const streamedPath = `packages/app/${"nested-segment/".repeat(12)}remote-large.txt`;
    const streamedContents = new Uint8Array(2 * 1024 * 1024).fill(0x61);
    let downloadedArtifactPath: string | undefined;
    let decompressedArchivePath: string | undefined;
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
            {
              path: streamedPath,
              contents: streamedContents,
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
          Effect.gen(function* () {
            const http = yield* HttpService;
            const compression = yield* CompressionService;
            const signing = yield* SigningService;
            const fileBoundaryError = (boundary: string) =>
              new BoundaryError({
                boundary,
                message: "in-memory remote restoration must not be used",
                retryable: false,
              });
            const streamingLayer = Layer.mergeAll(
              Layer.succeed(HttpService, {
                ...http,
                request: (request) =>
                  request.method === "GET"
                    ? Effect.fail(fileBoundaryError("http"))
                    : http.request(request),
                downloadToFile: (request, destination) => {
                  downloadedArtifactPath = destination;
                  return http.downloadToFile(request, destination);
                },
              }),
              Layer.succeed(CompressionService, {
                ...compression,
                decompressZstdToFile: () =>
                  Effect.fail(fileBoundaryError("compression")),
                decompressZstdFileToFile: (
                  source,
                  destination,
                  maxOutputBytes,
                ) => {
                  decompressedArchivePath = destination;
                  return compression.decompressZstdFileToFile(
                    source,
                    destination,
                    maxOutputBytes,
                  );
                },
              }),
              Layer.succeed(SigningService, {
                ...signing,
                hmacSha256: () => Effect.fail(fileBoundaryError("signing")),
              }),
            );
            return yield* restoreRemoteCache(
              restoreRoot,
              options,
              "0011223344556677",
              allowCachePaths("packages/app/**"),
            ).pipe(Effect.provide(streamingLayer));
          }).pipe(Effect.provide(nodeFoundationLayer)),
        ),
      ).toBe(true);
      expect(downloadedArtifactPath).toBeDefined();
      expect(decompressedArchivePath).toBeDefined();
      await expect(lstat(downloadedArtifactPath!)).rejects.toThrow();
      await expect(lstat(decompressedArchivePath!)).rejects.toThrow();
      expect(
        await readFile(`${directory}/packages/app/remote.txt`, "utf8"),
      ).toBe("remote");
      expect((await lstat(`${directory}/${streamedPath}`)).size).toBe(
        streamedContents.length,
      );
      tag = "0".repeat(64);
      await expect(
        Effect.runPromise(
          restoreRemoteCache(
            restoreRoot,
            options,
            "0011223344556677",
            allowCachePaths("packages/app/**"),
          ).pipe(Effect.provide(nodeFoundationLayer)),
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

  it("bounds remote preflight and upload response bodies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-remote-limit-"));
    const attempts = { OPTIONS: 0, PUT: 0 };
    const responseBody = Buffer.alloc(128 * 1024, "x");
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        if (request.method === "OPTIONS" || request.method === "PUT") {
          attempts[request.method] += 1;
          response.writeHead(request.method === "OPTIONS" ? 200 : 201);
          response.end(responseBody);
          return;
        }
        response.writeHead(404);
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
      const restore = await Effect.runPromise(
        restoreRemoteCache(
          directory,
          options,
          "1111222233334444",
          allowCachePaths("remote.txt"),
        ).pipe(Effect.either, Effect.provide(nodeFoundationLayer)),
      );
      expect(restore._tag).toBe("Left");
      const upload = await Effect.runPromise(
        writeRemoteCache(
          { ...options, preflight: false },
          "5555666677778888",
          [
            {
              path: "remote.txt",
              contents: new TextEncoder().encode("bounded"),
              mode: 0o644,
              modifiedSeconds: 1,
            },
          ],
          1,
        ).pipe(Effect.either, Effect.provide(nodeFoundationLayer)),
      );
      expect(upload._tag).toBe("Left");
      expect(attempts).toEqual({ OPTIONS: 1, PUT: 1 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

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
          restoreRemoteCache(
            directory,
            options,
            "9988776655443322",
            allowCachePaths("remote.txt"),
          ).pipe(Effect.provide(nodeFoundationLayer)),
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

  it("requires keys for active signed remotes and scopes longer keys", async () => {
    const directory = await makeFixture();
    const configurationPath = `${directory}/turbo.json`;
    const arguments_ = [
      candidateEntrypoint,
      "run",
      "build",
      "--cwd",
      directory,
      "--filter=synthetic-library",
      "--no-cache",
    ];
    try {
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as {
        futureFlags?: Record<string, boolean>;
        remoteCache?: Record<string, unknown>;
      };
      configuration.futureFlags = {
        ...configuration.futureFlags,
        longerSignatureKey: true,
      };
      for (const remoteCache of [
        {
          apiUrl: "http://127.0.0.1:9",
          enabled: false,
          signature: true,
        },
        { signature: true },
      ]) {
        configuration.remoteCache = remoteCache;
        await writeFile(
          configurationPath,
          `${JSON.stringify(configuration, null, 2)}\n`,
        );
        const inactive = await run(
          process.execPath,
          arguments_,
          repositoryRoot,
          { TURBO_REMOTE_CACHE_SIGNATURE_KEY: undefined },
        );
        expect(inactive.exitCode, inactive.combinedOutput).toBe(0);
      }

      configuration.remoteCache = {
        apiUrl: "http://127.0.0.1:9",
        signature: true,
      };
      configuration.futureFlags = {
        ...configuration.futureFlags,
        longerSignatureKey: false,
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      for (const signatureKey of [undefined, ""]) {
        const missing = await run(
          process.execPath,
          arguments_,
          repositoryRoot,
          { TURBO_REMOTE_CACHE_SIGNATURE_KEY: signatureKey },
        );
        expect(missing.exitCode).not.toBe(0);
        expect(missing.stderr).toContain(
          "TURBO_REMOTE_CACHE_SIGNATURE_KEY is required",
        );
      }
      const legacyShort = await run(
        process.execPath,
        arguments_,
        repositoryRoot,
        { TURBO_REMOTE_CACHE_SIGNATURE_KEY: "short" },
      );
      expect(legacyShort.exitCode, legacyShort.combinedOutput).toBe(0);

      configuration.futureFlags = {
        ...configuration.futureFlags,
        longerSignatureKey: true,
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      const futureShort = await run(
        process.execPath,
        arguments_,
        repositoryRoot,
        { TURBO_REMOTE_CACHE_SIGNATURE_KEY: "short" },
      );
      expect(futureShort.exitCode).not.toBe(0);
      expect(futureShort.stderr).toContain(
        "TURBO_REMOTE_CACHE_SIGNATURE_KEY must contain at least 32 characters",
      );
      const futureLong = await run(
        process.execPath,
        arguments_,
        repositoryRoot,
        {
          TURBO_REMOTE_CACHE_SIGNATURE_KEY: "0123456789abcdef0123456789abcdef",
        },
      );
      expect(futureLong.exitCode, futureLong.combinedOutput).toBe(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it("validates remote cache URLs and timeout environment values before execution", async () => {
    const directory = await makeFixture();
    const baseArguments = [
      candidateEntrypoint,
      "run",
      "build",
      "--cwd",
      directory,
      "--filter=synthetic-library",
      "--cache=remote:r",
    ];
    const expectConfigurationFailure = async (
      args: ReadonlyArray<string>,
      environment: Readonly<Record<string, string | undefined>>,
      message: string,
    ) => {
      const result = await run(
        process.execPath,
        args,
        repositoryRoot,
        environment,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(message);
      expect(result.stdout).not.toContain("library build");
    };
    try {
      await expectConfigurationFailure(
        [...baseArguments, "--api=not a URL"],
        {},
        "invalid remote cache URL",
      );
      await expectConfigurationFailure(
        baseArguments,
        { TURBO_API: "not a URL" },
        "invalid remote cache URL",
      );
      for (const value of [
        "ftp://cache.example.test",
        "file:///tmp/cache",
        "mailto:cache@example.test",
      ]) {
        await expectConfigurationFailure(
          [...baseArguments, `--api=${value}`],
          {},
          "invalid remote cache URL",
        );
      }
      for (const value of ["nonnumeric", "-1", "Infinity"]) {
        await expectConfigurationFailure(
          baseArguments,
          {
            TURBO_API: "http://127.0.0.1:9",
            TURBO_REMOTE_CACHE_TIMEOUT: value,
          },
          "invalid remote cache timeout",
        );
      }
      await expectConfigurationFailure(
        [...baseArguments.slice(0, -1), "--cache=remote:w"],
        {
          TURBO_API: "http://127.0.0.1:9",
          TURBO_REMOTE_CACHE_UPLOAD_TIMEOUT: "nonnumeric",
        },
        "invalid remote cache upload timeout",
      );
      const configurationPath = `${directory}/turbo.json`;
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as Record<string, unknown>;
      configuration.remoteCache = { apiUrl: "not a URL" };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await expectConfigurationFailure(
        baseArguments,
        {},
        "invalid remote cache URL",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

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
            allowCachePaths("packages/library/.turbo/turbo-build.log"),
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
