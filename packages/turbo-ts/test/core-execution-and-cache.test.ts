import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
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
  restoreLocalCache,
  writeLocalCache,
} from "../src/cache/local-cache.js";
import {
  restoreRemoteCache,
  writeRemoteCache,
} from "../src/cache/remote-cache.js";
import { evidenceId } from "../src/compatibility/ledger.js";
import { nodeFoundationLayer } from "../src/effect/node-layer.js";
import { ProcessService } from "../src/effect/services.js";

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
  });

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
  });

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
  });

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
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`,
      );
      await writeFile(`${directory}/packages/library/README.md`, "first\n");
      for (const args of [
        ["init"],
        ["config", "user.email", "synthetic@example.test"],
        ["config", "user.name", "Synthetic Fixture"],
        ["add", "."],
        ["commit", "-m", "fixture base"],
      ]) {
        expect((await run("git", args, directory)).exitCode).toBe(0);
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
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

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
  });
});

describe("cache interoperability and safety", () => {
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
      await expect(lstat(`${outside}/app/out.txt`)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("round trips signed remote artifacts through a loopback service", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-remote-"));
    let artifact = new Uint8Array();
    let tag = "";
    const server = createServer((request, response) => {
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
      apiUrl: `http://127.0.0.1:${address.port}`,
      timeoutMilliseconds: 5_000,
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
      expect(
        await Effect.runPromise(
          restoreRemoteCache(directory, options, "0011223344556677").pipe(
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
          restoreRemoteCache(directory, options, "0011223344556677").pipe(
            Effect.provide(nodeFoundationLayer),
          ),
        ),
      ).rejects.toThrow(/signature is invalid/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { force: true, recursive: true });
    }
  });

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
