import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  connect as connectHttp2,
  constants as http2Constants,
} from "node:http2";
import { createConnection as createNetConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "@rstest/core";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { graphql } from "graphql";
import { commandIndex } from "../src/cli/program.js";
import { evidenceId } from "../src/compatibility/ledger.js";
import { normalizeOutput } from "../src/compatibility/normalizers.js";
import { BoundaryError, ProcessExecutionError } from "../src/effect/errors.js";
import {
  makeDaemonServe,
  nodeFoundationLayer,
} from "../src/effect/node-layer.js";
import {
  DaemonMethod,
  DaemonService,
  EnvironmentService,
  FileSystemService,
  FileWatcherService,
  ProcessService,
  TerminalService,
} from "../src/effect/services.js";
import { pruneLockfile } from "../src/repository/lockfiles.js";
import {
  renderRunTui,
  renderTimestampedStreamText,
  resolveRunUiMode,
} from "../src/run/engine.js";
import { parseRunArguments } from "../src/run/options.js";
import {
  executeDaemon,
  parseDaemonArguments,
  watcherPathsMatch,
} from "../src/workflow/daemon.js";
import { executeList } from "../src/workflow/list.js";
import { isWindowsSubsystemForLinux } from "../src/workflow/misc.js";
import { executePrune, parsePruneArguments } from "../src/workflow/prune.js";
import { executeQuery, repositoryQuerySchema } from "../src/workflow/query.js";
import {
  isInternalRepositoryPath,
  repositoryPackageManagerLabel,
} from "../src/workflow/repository.js";
import { parseWatchArguments } from "../src/workflow/watch.js";

const execFilePromise = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = join(packageRoot, "test/fixtures/basic-workspace");
const candidate = join(packageRoot, "dist/bin/turbo-ts.js");
const official = join(repositoryRoot, "node_modules/.bin/turbo");
// Keep Gate 3 output comparisons independent of ambient Gate 4 CI and color
// behavior. Remove this override when environment.platform gains coverage.
const ambientOutputEnvironmentNames = new Set([
  "CI",
  "FORCE_COLOR",
  "GITHUB_ACTIONS",
  "NO_COLOR",
  "TURBO_TELEMETRY_DISABLED",
]);
const differentialEnvironment: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !ambientOutputEnvironmentNames.has(name.toUpperCase()),
    ),
  ),
  NO_COLOR: "1",
  TURBO_TELEMETRY_DISABLED: "1",
};
const executeDifferentialCommand = (
  executable: string,
  arguments_: ReadonlyArray<string>,
) =>
  execFilePromise(executable, [...arguments_], {
    env: differentialEnvironment,
  });
const workflowLockfile = `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  .: {}
  packages/app:
    dependencies:
      synthetic-library:
        specifier: workspace:*
        version: link:../library
  packages/library: {}
`;

const dependencyWorkflowLockfile = `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  .:
    dependencies:
      root-external:
        specifier: 4.0.0
        version: 4.0.0
  packages/app:
    dependencies:
      synthetic-library:
        specifier: workspace:*
        version: link:../library
      foo:
        specifier: 1.0.0
        version: 1.0.0
  packages/library:
    dependencies:
      bar:
        specifier: 2.0.0
        version: 2.0.0
packages:
  foo@1.0.0:
    resolution: {integrity: sha512-Zm9v}
  bar@2.0.0:
    resolution: {integrity: sha512-YmFy}
  baz@3.0.0:
    resolution: {integrity: sha512-YmF6}
  root-external@4.0.0:
    resolution: {integrity: sha512-cm9vdA==}
snapshots:
  foo@1.0.0:
    dependencies:
      baz: 3.0.0
  bar@2.0.0: {}
  baz@3.0.0: {}
  root-external@4.0.0: {}
`;

const prepareFixture = async (directory: string): Promise<void> => {
  await cp(fixture, directory, { recursive: true });
  await writeFile(join(directory, "pnpm-lock.yaml"), workflowLockfile);
};

const waitUntil = async (
  predicate: () => boolean,
  timeoutMilliseconds = 15_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for output");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const sendMalformedDaemonFrame = async (socket: string): Promise<void> => {
  await new Promise<void>((resolve) => {
    const session = connectHttp2("http://localhost", {
      createConnection: () => createNetConnection(socket),
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      session.destroy();
      resolve();
    };
    const timeout = setTimeout(finish, 2_000);
    const stream = session.request({
      [http2Constants.HTTP2_HEADER_METHOD]: "POST",
      [http2Constants.HTTP2_HEADER_PATH]: "/turbodprotocol.Turbod/Hello",
      [http2Constants.HTTP2_HEADER_CONTENT_TYPE]: "application/grpc",
    });
    session.once("error", finish);
    stream.once("error", finish);
    stream.once("close", () => {
      clearTimeout(timeout);
      finish();
    });
    // The frame declares five payload bytes but contains only one.
    stream.end(Buffer.from([0, 0, 0, 0, 5, 1]));
  });
};

const protobufString = (field: number, value: string): Buffer => {
  const encoded = Buffer.from(value);
  if (encoded.length >= 128)
    throw new Error("synthetic protobuf value is too long");
  return Buffer.concat([Buffer.from([field * 8 + 2, encoded.length]), encoded]);
};

const sendDaemonRequestResult = async (
  socket: string,
  method: string,
  payload: Uint8Array = Buffer.alloc(0),
): Promise<{ readonly payload: Buffer; readonly error?: string }> =>
  new Promise((resolve, reject) => {
    const session = connectHttp2("http://localhost", {
      createConnection: () => createNetConnection(socket),
    });
    const chunks: Array<Buffer> = [];
    let responseError: string | undefined;
    const stream = session.request({
      [http2Constants.HTTP2_HEADER_METHOD]: "POST",
      [http2Constants.HTTP2_HEADER_PATH]: `/turbodprotocol.Turbod/${method}`,
      [http2Constants.HTTP2_HEADER_CONTENT_TYPE]: "application/grpc",
    });
    stream.on("response", (headers) => {
      if (
        headers["grpc-status"] !== undefined &&
        headers["grpc-status"] !== "0"
      ) {
        responseError = decodeURIComponent(
          String(headers["grpc-message"] ?? "daemon request failed"),
        );
      }
    });
    const timeout = setTimeout(() => {
      session.destroy();
      reject(new Error(`timed out waiting for daemon ${method}`));
    }, 5_000);
    session.once("error", reject);
    stream.once("error", reject);
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.once("end", () => {
      clearTimeout(timeout);
      session.close();
      const framed = Buffer.concat(chunks);
      resolve({
        payload: framed.length >= 5 ? framed.subarray(5) : framed,
        ...(responseError === undefined ? {} : { error: responseError }),
      });
    });
    const header = Buffer.alloc(5);
    header.writeUInt32BE(payload.length, 1);
    stream.end(Buffer.concat([header, payload]));
  });

const sendDaemonRequest = async (
  socket: string,
  method: string,
  payload: Uint8Array = Buffer.alloc(0),
): Promise<Buffer> =>
  (await sendDaemonRequestResult(socket, method, payload)).payload;

const readTextTree = async (
  root: string,
  directory = root,
): Promise<Readonly<Record<string, string>>> => {
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, await readTextTree(root, path));
    } else if (entry.isFile()) {
      files[path.slice(root.length + 1)] = await readFile(path, "utf8");
    }
  }
  return files;
};

describe("repository workflow gate", () => {
  it(evidenceId.repositoryWorkflows, async () => {
    const run = parseRunArguments([
      "run",
      "build",
      "--dry=json",
      "--graph=tasks.json",
      "--summarize",
      "--ui=stream",
      "--log-order=grouped",
      "--log-prefix=task",
      "--global-deps=tooling/*.json",
      "--single-package",
      "--json",
    ]);
    expect(run).toMatchObject({
      tasks: ["build"],
      dryRun: "json",
      graph: "tasks.json",
      summarize: true,
      ui: "stream",
      logOrder: "grouped",
      logPrefix: "task",
      globalDependencies: ["tooling/*.json"],
      singlePackage: true,
      json: true,
    });
    expect(
      parseRunArguments(["run", "build", "--dry-run=text", "json"]),
    ).toMatchObject({ tasks: ["build", "json"], dryRun: "text" });
    expect(
      parseRunArguments(["run", "build", "--summarize=false", "true"]),
    ).toMatchObject({ tasks: ["build", "true"], summarize: false });
    expect(
      parseRunArguments(["run", "build", "--summarize", "false"]),
    ).toMatchObject({ tasks: ["build"], summarize: false });
    expect(commandIndex(["--filter", "watch", "build"])).toBe(2);
    expect(commandIndex(["--cache", "watch", "build"])).toBe(2);
    expect(commandIndex(["--dry-run", "text", "watch"])).toBe(2);
    expect(commandIndex(["--dry-run=text", "json"])).toBe(1);
    expect(commandIndex(["--graph", "watch", "build"])).toBe(2);
    const nestedRepository = join(tmpdir(), ".turbo", "repository");
    expect(
      isInternalRepositoryPath(nestedRepository, join(nestedRepository, "src")),
    ).toBe(false);
    expect(
      isInternalRepositoryPath(
        nestedRepository,
        join(nestedRepository, ".turbo", "cache"),
      ),
    ).toBe(true);
    for (const [manager, label] of [
      ["npm", "npm"],
      ["pnpm", "pnpm9"],
      ["yarn", "yarn"],
      ["bun", "bun"],
      ["aube", "aube"],
      ["nub", "nub"],
      ["cargo", "cargo"],
      ["uv", "uv"],
    ] as const) {
      expect(repositoryPackageManagerLabel({ manager })).toBe(label);
    }
    expect(
      parseWatchArguments(["build", "--", "--experimental-write-cache"]),
    ).toMatchObject({
      writeCache: false,
      run: { passThroughArguments: ["--experimental-write-cache"] },
    });
    expect(
      parseWatchArguments(["build", "--cache=local:rw,remote:w"]),
    ).toMatchObject({
      writeCache: false,
      run: { cacheSpecification: "local:r", noCache: false },
    });
    expect(parseWatchArguments(["build", "--cache=remote:w"])).toMatchObject({
      writeCache: false,
      run: { cacheSpecification: undefined, noCache: true },
    });
    expect(
      parseWatchArguments([
        "build",
        "--experimental-write-cache",
        "--cache=local:rw",
      ]),
    ).toMatchObject({
      writeCache: true,
      run: { cacheSpecification: "local:rw", noCache: false },
    });
    expect(
      isWindowsSubsystemForLinux("linux", "5.15.90.1-microsoft-standard-WSL2"),
    ).toBe(true);
    expect(isWindowsSubsystemForLinux("linux", "4.4.0-19041-Microsoft")).toBe(
      true,
    );
    expect(
      watcherPathsMatch(
        "C:\\repo\\.turbo\\daemon\\turbo.log",
        "C:/repo/.turbo/daemon/turbo.log",
        true,
      ),
    ).toBe(true);
    expect(isWindowsSubsystemForLinux("linux", "6.8.0-generic")).toBe(false);
    expect(isWindowsSubsystemForLinux("win32", "10.0.26100-Microsoft")).toBe(
      false,
    );
    expect(resolveRunUiMode("tui", false, true, false)).toBe("stream");
    expect(resolveRunUiMode("tui", true, true, false)).toBe("tui");
    expect(renderTimestampedStreamText(0, "one\ntwo\n")).toBe(
      "[1970-01-01T00:00:00.000Z] one\n[1970-01-01T00:00:00.000Z] two\n",
    );
    expect(
      renderRunTui(
        new Map([
          ["app#build", "running"],
          ["lib#build", "queued"],
        ]),
      ),
    ).toContain("running   app#build");
    expect(
      parseDaemonArguments(["--idle-time=30s", "status", "--json"]),
    ).toMatchObject({
      command: "status",
      idleMilliseconds: 30_000,
      json: true,
    });
    expect(
      parsePruneArguments(["app", "--docker", "--production"]),
    ).toMatchObject({ scopes: ["app"], docker: true, production: true });

    const completionScripts = {
      bash: "complete -W 'run watch daemon query ls prune info completion' turbo-ts\n",
      elvish:
        "set edit:completion:arg-completer[turbo-ts] = { |@words| put run watch daemon query ls prune info completion }\n",
      fish: "complete -c turbo-ts -f -a 'run watch daemon query ls prune info completion'\n",
      powershell:
        "Register-ArgumentCompleter -Native -CommandName turbo-ts -ScriptBlock { 'run','watch','daemon','query','ls','prune','info','completion' }\n",
      zsh: "#compdef turbo-ts\n_arguments '1:command:(run watch daemon query ls prune info completion)'\n",
    } as const;
    for (const [shell, script] of Object.entries(completionScripts)) {
      const completion = await executeDifferentialCommand(process.execPath, [
        candidate,
        "completion",
        shell,
      ]);
      expect(completion.stdout).toBe(script);
      expect(completion.stderr).toContain("• turbo-ts 0.1.0");
    }

    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-workflow-"));
    try {
      await prepareFixture(directory);
      await expect(
        execFilePromise(process.execPath, [candidate, "info", "--cwd"]),
      ).rejects.toThrow(/--cwd requires a value/);
      const listed = await executeDifferentialCommand(process.execPath, [
        candidate,
        "--cwd",
        directory,
        "ls",
        "--output=json",
      ]);
      const officialList = await executeDifferentialCommand(official, [
        "--cwd",
        directory,
        "ls",
        "--output=json",
      ]);
      expect(listed.stdout).toBe(officialList.stdout);
      expect(normalizeOutput(listed.stderr, ["branding"])).toBe(
        officialList.stderr,
      );
      expect(JSON.parse(listed.stdout)).toMatchObject({
        packageManager: "pnpm9",
        packages: { count: 2 },
      });
      const queried = await executeDifferentialCommand(process.execPath, [
        candidate,
        "query",
        "{ packages { length } version }",
        "--cwd",
        directory,
      ]);
      const officialQuery = await executeDifferentialCommand(official, [
        "query",
        "{ packages { length } version }",
        "--cwd",
        directory,
      ]);
      expect(queried.stdout).toBe(officialQuery.stdout);
      expect(normalizeOutput(queried.stderr, ["branding"])).toBe(
        officialQuery.stderr,
      );
      expect(JSON.parse(queried.stdout)).toEqual({
        data: { packages: { length: 3 }, version: "2.10.12" },
      });
      const fileQuery =
        '{ file(path: "package.json") { path absolutePath contents ast } }';
      const queriedFile = await executeDifferentialCommand(process.execPath, [
        candidate,
        "query",
        fileQuery,
        "--cwd",
        directory,
      ]);
      const officialFile = await executeDifferentialCommand(official, [
        "query",
        fileQuery,
        "--cwd",
        directory,
      ]);
      expect(queriedFile.stdout).toBe(officialFile.stdout);
      expect(normalizeOutput(queriedFile.stderr, ["branding"])).toBe(
        officialFile.stderr,
      );
      const dry = await execFilePromise(process.execPath, [
        candidate,
        "run",
        "build",
        "--dry=json",
        "--cwd",
        directory,
      ]);
      const dryRun = JSON.parse(dry.stdout) as {
        readonly turboVersion: string;
        readonly tasks: ReadonlyArray<{ readonly taskId: string }>;
      };
      expect(dryRun.turboVersion).toBe("2.10.12");
      expect(dryRun.tasks.map((task) => task.taskId)).toEqual([
        "synthetic-app#build",
        "synthetic-library#build",
      ]);
      const singlePackage = await execFilePromise(process.execPath, [
        candidate,
        "run",
        "build",
        "--single-package",
        "--no-cache",
        "--cwd",
        directory,
      ]);
      expect(singlePackage.stdout).toContain("root build");
      expect(singlePackage.stdout).not.toContain("app build");
      expect(singlePackage.stdout).not.toContain("library build");

      await execFilePromise(process.execPath, [
        candidate,
        "run",
        "build",
        "--graph=task-graph.dot",
        "--cwd",
        directory,
      ]);
      await execFilePromise(official, [
        "run",
        "build",
        "--graph=reference-graph.dot",
        "--cwd",
        directory,
      ]);
      expect(await readFile(join(directory, "task-graph.dot"), "utf8")).toBe(
        await readFile(join(directory, "reference-graph.dot"), "utf8"),
      );
      await execFilePromise(process.execPath, [
        candidate,
        "run",
        "build",
        "--graph=task-graph.mmd",
        "--cwd",
        directory,
      ]);
      const mermaid = await readFile(join(directory, "task-graph.mmd"), "utf8");
      const identifiers = [...mermaid.matchAll(/\bN\d+(?=\()/g)].map(
        (match) => match[0],
      );
      expect(new Set(identifiers).size).toBe(3);

      await writeFile(join(directory, "global-input.txt"), "one\n");
      const hashWithGlobalInput = async () => {
        const result = await execFilePromise(process.execPath, [
          candidate,
          "run",
          "build",
          "--dry=json",
          "--global-deps=global-input.txt",
          "--cwd",
          directory,
        ]);
        return JSON.parse(result.stdout) as {
          readonly globalCacheInputs: {
            readonly files: Readonly<Record<string, string>>;
          };
          readonly tasks: ReadonlyArray<{ readonly hash: string }>;
        };
      };
      const firstGlobalSummary = await hashWithGlobalInput();
      expect(
        firstGlobalSummary.globalCacheInputs.files["global-input.txt"],
      ).toMatch(/^[0-9a-f]{40}$/);
      await writeFile(join(directory, "global-input.txt"), "two\n");
      const secondGlobalSummary = await hashWithGlobalInput();
      expect(secondGlobalSummary.tasks.map((task) => task.hash)).not.toEqual(
        firstGlobalSummary.tasks.map((task) => task.hash),
      );
      expect(secondGlobalSummary.globalCacheInputs.files).not.toEqual(
        firstGlobalSummary.globalCacheInputs.files,
      );

      const structured = await execFilePromise(process.execPath, [
        candidate,
        "run",
        "build",
        "--no-cache",
        "--summarize",
        "--json",
        "--global-deps=global-input.txt",
        "--heap=run.heapsnapshot",
        "--trace=trace.json",
        "--profile=profile.json",
        "--anon-profile=anonymous.json",
        "--log-file=run.ndjson",
        "--cwd",
        directory,
      ]);
      const structuredRecords = structured.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(structuredRecords.length).toBeGreaterThan(1);
      expect(
        structuredRecords.every(
          (record) =>
            record.type === "run_summary" ||
            (typeof record.timestamp === "number" &&
              typeof record.source === "string" &&
              typeof record.level === "string" &&
              typeof record.text === "string"),
        ),
      ).toBe(true);
      const runSummary = structuredRecords.at(-1) as {
        readonly id: string;
        readonly type: string;
        readonly globalCacheInputs: {
          readonly files: Readonly<Record<string, string>>;
        };
        readonly tasks: ReadonlyArray<{
          readonly taskId: string;
          readonly execution: {
            readonly startTime: number;
            readonly endTime: number;
          };
        }>;
      };
      expect(runSummary.type).toBe("run_summary");
      expect(runSummary.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(runSummary.globalCacheInputs.files).toEqual(
        secondGlobalSummary.globalCacheInputs.files,
      );
      const logRecords = (await readFile(join(directory, "run.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(logRecords.map((record) => record.type)).toContain("task_event");
      expect(logRecords.at(-1)?.type).toBe("run_summary");
      expect(logRecords.at(-1)?.id).toBe(runSummary.id);
      const libraryTiming = runSummary.tasks.find(
        (task) => task.taskId === "synthetic-library#build",
      )!.execution;
      const appTiming = runSummary.tasks.find(
        (task) => task.taskId === "synthetic-app#build",
      )!.execution;
      expect(libraryTiming.endTime).toBeLessThanOrEqual(appTiming.startTime);
      const unprefixed = await execFilePromise(process.execPath, [
        candidate,
        "run",
        "build",
        "--no-cache",
        "--log-prefix=none",
        "--cwd",
        directory,
      ]);
      expect(unprefixed.stdout).toContain("app build\n");
      expect(unprefixed.stdout).not.toContain("synthetic-app: app build");
      await execFilePromise(process.execPath, [
        candidate,
        "run",
        "build",
        "--cwd",
        directory,
      ]);
      const cached = await execFilePromise(process.execPath, [
        candidate,
        "run",
        "build",
        "--json",
        "--cwd",
        directory,
      ]);
      const cachedSummary = JSON.parse(
        cached.stdout.trim().split("\n").at(-1)!,
      ) as {
        readonly execution: { readonly cached: number };
        readonly tasks: ReadonlyArray<{
          readonly cache: {
            readonly local: boolean;
            readonly remote: boolean;
            readonly status: string;
            readonly timeSaved: number;
          };
        }>;
      };
      expect(cachedSummary.execution.cached).toBe(2);
      expect(
        cachedSummary.tasks.every(
          (task) =>
            task.cache.local &&
            !task.cache.remote &&
            task.cache.status === "HIT" &&
            task.cache.timeSaved >= 0,
        ),
      ).toBe(true);
      const cachedUnprefixed = await execFilePromise(process.execPath, [
        candidate,
        "run",
        "build",
        "--log-prefix=none",
        "--cwd",
        directory,
      ]);
      expect(cachedUnprefixed.stdout).not.toContain("synthetic-app:build:");
      for (const artifact of [
        "run.heapsnapshot",
        "trace.json",
        "profile.json",
        "anonymous.json",
        "run.ndjson",
      ]) {
        expect(
          (await readFile(join(directory, artifact))).byteLength,
        ).toBeGreaterThan(0);
      }
      const profileNames = async (artifact: string) =>
        (
          JSON.parse(await readFile(join(directory, artifact), "utf8")) as {
            readonly traceEvents: ReadonlyArray<{ readonly name: string }>;
          }
        ).traceEvents.map((event) => event.name);
      const namedProfileNames = await profileNames("profile.json");
      expect(new Set(namedProfileNames)).toEqual(
        new Set(["synthetic-app#build", "synthetic-library#build"]),
      );
      expect(await profileNames("trace.json")).toEqual(namedProfileNames);
      expect(new Set(await profileNames("anonymous.json"))).toEqual(
        new Set(["build"]),
      );
      const runFiles = await readdir(join(directory, ".turbo/runs"));
      expect(runFiles).toEqual([`${runSummary.id}.json`]);
      expect(
        JSON.parse(
          await readFile(join(directory, ".turbo/runs", runFiles[0]!), "utf8"),
        ).id,
      ).toBe(runSummary.id);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 60_000);

  it("omits unscheduled tasks from profiles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-profile-stop-"));
    try {
      await prepareFixture(directory);
      const manifestPath = join(directory, "packages/library/package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.build =
        "node -e \"console.log('library failed'); process.exit(7)\"";
      await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, undefined, 2)}\n`,
      );
      await expect(
        execFilePromise(process.execPath, [
          candidate,
          "run",
          "build",
          "--no-cache",
          "--profile=profile.json",
          "--cwd",
          directory,
        ]),
      ).rejects.toThrow();
      const profile = JSON.parse(
        await readFile(join(directory, "profile.json"), "utf8"),
      ) as {
        readonly traceEvents: ReadonlyArray<{ readonly name: string }>;
      };
      expect(profile.traceEvents.map((event) => event.name)).toEqual([
        "synthetic-library#build",
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("hashes repository-contained heap snapshots before execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-heap-input-"));
    try {
      await prepareFixture(directory);
      const result = await execFilePromise(process.execPath, [
        candidate,
        "run",
        "build",
        "--single-package",
        "--no-cache",
        "--json",
        "--heap=run.heapsnapshot",
        "--cwd",
        directory,
      ]);
      const summary = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {
        readonly tasks: ReadonlyArray<{
          readonly inputs: Readonly<Record<string, string>>;
        }>;
      };
      expect(summary.tasks).toHaveLength(1);
      expect(summary.tasks[0]!.inputs["run.heapsnapshot"]).toMatch(
        /^[0-9a-f]{40}$/,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it("marks a repository with one child workspace as a monorepo", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-monorepo-"));
    try {
      await prepareFixture(directory);
      await rm(join(directory, "packages/library"), {
        force: true,
        recursive: true,
      });
      const manifestPath = join(directory, "packages/app/package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        dependencies?: Record<string, string>;
      };
      delete manifest.dependencies;
      await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, undefined, 2)}\n`,
      );
      const dryRun = await execFilePromise(process.execPath, [
        candidate,
        "run",
        "build",
        "--dry=json",
        "--cwd",
        directory,
      ]);
      expect(
        (JSON.parse(dryRun.stdout) as { readonly monorepo: boolean }).monorepo,
      ).toBe(true);
      const completedRun = await execFilePromise(process.execPath, [
        candidate,
        "run",
        "build",
        "--no-cache",
        "--json",
        "--cwd",
        directory,
      ]);
      const completedSummary = JSON.parse(
        completedRun.stdout.trim().split("\n").at(-1)!,
      ) as {
        readonly monorepo: boolean;
      };
      expect(completedSummary.monorepo).toBe(true);
      const singlePackage = await execFilePromise(process.execPath, [
        candidate,
        "run",
        "build",
        "--single-package",
        "--dry=json",
        "--cwd",
        directory,
      ]);
      expect(
        (JSON.parse(singlePackage.stdout) as { readonly monorepo: boolean })
          .monorepo,
      ).toBe(false);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it("reports resolved dependency hashes and actual encoded task-log paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-summary-paths-"));
    try {
      await prepareFixture(directory);
      const rootManifestPath = join(directory, "package.json");
      const rootManifest = JSON.parse(
        await readFile(rootManifestPath, "utf8"),
      ) as { dependencies?: Record<string, string> };
      rootManifest.dependencies = { "root-external": "4.0.0" };
      await writeFile(
        rootManifestPath,
        `${JSON.stringify(rootManifest, undefined, 2)}\n`,
      );
      for (const [packageName, dependencies] of [
        ["app", { "synthetic-library": "workspace:*", foo: "1.0.0" }],
        ["library", { bar: "2.0.0" }],
      ] as const) {
        const manifestPath = join(
          directory,
          `packages/${packageName}/package.json`,
        );
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          dependencies?: Record<string, string>;
          scripts: Record<string, string>;
        };
        manifest.dependencies = dependencies;
        manifest.scripts["lint:types"] = "node -e \"console.log('type lint')\"";
        await writeFile(
          manifestPath,
          `${JSON.stringify(manifest, undefined, 2)}\n`,
        );
      }
      const configurationPath = join(directory, "turbo.json");
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      configuration.tasks["lint:types"] = { dependsOn: ["^lint:types"] };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, undefined, 2)}\n`,
      );
      await writeFile(
        join(directory, "pnpm-lock.yaml"),
        dependencyWorkflowLockfile,
      );

      const dryResult = await execFilePromise(process.execPath, [
        candidate,
        "run",
        "lint:types",
        "--dry=json",
        "--cwd",
        directory,
      ]);
      const drySummary = JSON.parse(dryResult.stdout) as {
        readonly globalCacheInputs: {
          readonly hashOfExternalDependencies: string;
        };
        readonly tasks: ReadonlyArray<{
          readonly taskId: string;
          readonly hashOfExternalDependencies: string;
          readonly logFile: string;
        }>;
      };
      const officialDryResult = await executeDifferentialCommand(official, [
        "run",
        "lint:types",
        "--dry=json",
        "--cwd",
        directory,
      ]);
      const officialSummary = JSON.parse(officialDryResult.stdout) as {
        readonly tasks: ReadonlyArray<{
          readonly hashOfExternalDependencies: string;
        }>;
      };
      const officialHashes = officialSummary.tasks.map(
        (task) => task.hashOfExternalDependencies,
      );
      expect(new Set(officialHashes).size).toBe(2);
      expect(drySummary.globalCacheInputs.hashOfExternalDependencies).not.toBe(
        "459c029558afe716",
      );

      const hashes = drySummary.tasks.map(
        (task) => task.hashOfExternalDependencies,
      );
      expect(new Set(hashes).size).toBe(2);
      expect(hashes).not.toContain("459c029558afe716");
      for (const task of drySummary.tasks) {
        expect(task.logFile).toBe(
          `${task.taskId.startsWith("synthetic-app") ? "packages/app" : "packages/library"}/.turbo/turbo-lint%003Atypes.log`,
        );
      }

      const completedResult = await execFilePromise(process.execPath, [
        candidate,
        "run",
        "lint:types",
        "--no-cache",
        "--summarize",
        "--json",
        "--cwd",
        directory,
      ]);
      const completedSummary = JSON.parse(
        completedResult.stdout.trim().split("\n").at(-1)!,
      ) as typeof drySummary;
      expect(
        completedSummary.globalCacheInputs.hashOfExternalDependencies,
      ).toBe(drySummary.globalCacheInputs.hashOfExternalDependencies);
      expect(
        completedSummary.tasks.map((task) => ({
          taskId: task.taskId,
          hash: task.hashOfExternalDependencies,
          logFile: task.logFile,
        })),
      ).toEqual(
        drySummary.tasks.map((task) => ({
          taskId: task.taskId,
          hash: task.hashOfExternalDependencies,
          logFile: task.logFile,
        })),
      );
      for (const task of completedSummary.tasks) {
        expect(
          (await readFile(join(directory, task.logFile))).byteLength,
        ).toBeGreaterThan(0);
      }
      rootManifest.dependencies = { "root-external": "4.0.1" };
      await writeFile(
        rootManifestPath,
        `${JSON.stringify(rootManifest, undefined, 2)}\n`,
      );
      await writeFile(
        join(directory, "pnpm-lock.yaml"),
        dependencyWorkflowLockfile.replaceAll("4.0.0", "4.0.1"),
      );
      const changedRootSummary = JSON.parse(
        (
          await execFilePromise(process.execPath, [
            candidate,
            "run",
            "lint:types",
            "--dry=json",
            "--cwd",
            directory,
          ])
        ).stdout,
      ) as typeof drySummary;
      expect(
        changedRootSummary.globalCacheInputs.hashOfExternalDependencies,
      ).not.toBe(drySummary.globalCacheInputs.hashOfExternalDependencies);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it("groups concurrent task output and keeps timestamped streaming distinct", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-run-output-"));
    try {
      await prepareFixture(directory);
      for (const [name, delay] of [
        ["app", 80],
        ["library", 40],
      ] as const) {
        const manifestPath = join(directory, `packages/${name}/package.json`);
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          scripts: Record<string, string>;
        };
        manifest.scripts.grouped = `node -e "console.log('${name}-start');setTimeout(()=>console.log('${name}-end'),${delay})"`;
        await writeFile(
          manifestPath,
          `${JSON.stringify(manifest, undefined, 2)}\n`,
        );
      }
      const configurationPath = join(directory, "turbo.json");
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { tasks: Record<string, unknown> };
      configuration.tasks.grouped = { cache: false };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, undefined, 2)}\n`,
      );
      const grouped = await execFilePromise(process.execPath, [
        candidate,
        "run",
        "grouped",
        "--parallel",
        "--concurrency=2",
        "--log-order=grouped",
        "--log-prefix=none",
        "--cwd",
        directory,
      ]);
      const appStart = grouped.stdout.indexOf("app-start");
      const appEnd = grouped.stdout.indexOf("app-end");
      const libraryStart = grouped.stdout.indexOf("library-start");
      const libraryEnd = grouped.stdout.indexOf("library-end");
      expect(
        Math.min(appStart, appEnd, libraryStart, libraryEnd),
      ).toBeGreaterThan(-1);
      expect(appEnd < libraryStart || libraryEnd < appStart).toBe(true);
      const timestamped = await execFilePromise(process.execPath, [
        candidate,
        "run",
        "grouped",
        "--parallel",
        "--concurrency=2",
        "--ui=stream-with-experimental-timestamps",
        "--log-prefix=none",
        "--cwd",
        directory,
      ]);
      expect(timestamped.stdout).toMatch(
        /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/m,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);

  it("evaluates package and tag boundary rules in repository queries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-boundaries-"));
    const queryBoundaries = async () => {
      const result = await executeDifferentialCommand(process.execPath, [
        candidate,
        "query",
        "{ boundaries { errors warnings } }",
        "--cwd",
        directory,
      ]);
      return JSON.parse(result.stdout) as {
        readonly data: {
          readonly boundaries: {
            readonly errors: ReadonlyArray<Record<string, unknown>>;
            readonly warnings: ReadonlyArray<Record<string, unknown>>;
          };
        };
      };
    };
    try {
      await prepareFixture(directory);
      await writeFile(
        join(directory, "turbo.json"),
        JSON.stringify({
          boundaries: {
            tags: {
              app: { dependencies: { deny: ["library"] } },
            },
          },
          tasks: {},
        }),
      );
      await writeFile(
        join(directory, "packages/app/turbo.json"),
        JSON.stringify({ extends: ["//"], tags: ["app"], tasks: {} }),
      );
      await writeFile(
        join(directory, "packages/library/turbo.json"),
        JSON.stringify({
          extends: ["//"],
          tags: ["library"],
          boundaries: { dependents: { allow: ["service"] } },
          tasks: {},
        }),
      );
      expect((await queryBoundaries()).data.boundaries).toEqual({
        errors: [
          {
            message:
              "Package `synthetic-app` found without any tag listed in allowlist for `synthetic-library`",
            reason: null,
            path: "packages/app/turbo.json",
            import: "synthetic-app",
          },
          {
            message:
              "Package `synthetic-library` found with tag listed in denylist for `synthetic-app`: `library`",
            reason: "library",
            path: "packages/library/turbo.json",
            import: "synthetic-library",
          },
        ],
        warnings: [],
      });

      await writeFile(
        join(directory, "turbo.json"),
        JSON.stringify({ tasks: {} }),
      );
      await writeFile(
        join(directory, "packages/app/turbo.json"),
        JSON.stringify({
          extends: ["//"],
          tags: ["app", "service"],
          boundaries: { dependencies: { deny: ["library"] } },
          tasks: {},
        }),
      );
      expect((await queryBoundaries()).data.boundaries.errors).toEqual([
        {
          message:
            "Package `synthetic-library` found with tag listed in denylist for `synthetic-app`: `library`",
          reason: "library",
          path: "packages/library/turbo.json",
          import: "synthetic-library",
        },
      ]);

      const appManifestPath = join(directory, "packages/app/package.json");
      const appManifest = JSON.parse(
        await readFile(appManifestPath, "utf8"),
      ) as { dependencies?: Record<string, string> };
      delete appManifest.dependencies;
      await writeFile(appManifestPath, JSON.stringify(appManifest));
      await writeFile(
        join(directory, "packages/app/turbo.json"),
        JSON.stringify({
          extends: ["//"],
          tags: ["app"],
          boundaries: {
            implicitDependencies: ["synthetic-library"],
            dependencies: { deny: ["library"] },
          },
          tasks: {},
        }),
      );
      await writeFile(
        join(directory, "packages/library/turbo.json"),
        JSON.stringify({
          extends: ["//"],
          tags: ["library"],
          boundaries: { dependents: { deny: ["app"] } },
          tasks: {},
        }),
      );
      expect((await queryBoundaries()).data.boundaries.errors).toEqual([
        {
          message:
            "Package `synthetic-app` found with tag listed in denylist for `synthetic-library`: `app`",
          reason: "app",
          path: "packages/app/turbo.json",
          import: "synthetic-app",
        },
        {
          message:
            "Package `synthetic-library` found with tag listed in denylist for `synthetic-app`: `library`",
          reason: "library",
          path: "packages/library/turbo.json",
          import: "synthetic-library",
        },
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);

  it(evidenceId.repositoryProtocol, async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-daemon-"));
    const runCandidate = (...arguments_: ReadonlyArray<string>) =>
      execFilePromise(process.execPath, [
        candidate,
        ...arguments_,
        "--cwd",
        directory,
      ]);
    const runOfficial = (...arguments_: ReadonlyArray<string>) =>
      execFilePromise(official, [...arguments_, "--cwd", directory]);
    try {
      await prepareFixture(directory);
      await runCandidate("daemon", "start", "--idle-time=30s");
      await expect(
        runCandidate("daemon", "serve", "--idle-time=30s"),
      ).rejects.toThrow(/daemon is already running/);
      const officialStatus = await runOfficial("daemon", "status", "--json");
      const officialState = JSON.parse(officialStatus.stdout) as {
        readonly log_file: string;
        readonly pid_file: string;
        readonly sock_file: string;
      };
      expect(officialState).toMatchObject({
        log_file: expect.stringMatching(/-turbo\.log\.\d{4}-\d{2}-\d{2}$/),
        pid_file: expect.stringContaining("turbod.pid"),
        sock_file: expect.stringContaining("turbod.sock"),
      });
      expect((await runCandidate("info")).stdout).toContain(
        "Daemon status: Running",
      );
      const discovered = await sendDaemonRequest(
        officialState.sock_file,
        "DiscoverPackages",
      );
      expect(discovered.toString("utf8")).toContain("synthetic-app");
      expect(discovered.toString("utf8")).toContain("synthetic-library");
      const addedDirectory = join(directory, "packages/added");
      const renamedDirectory = join(directory, "packages/renamed");
      await mkdir(addedDirectory, { recursive: true });
      await writeFile(
        join(addedDirectory, "package.json"),
        JSON.stringify({ name: "synthetic-added", private: true }),
      );
      const added = await sendDaemonRequest(
        officialState.sock_file,
        "DiscoverPackages",
      );
      expect(added.toString("utf8")).toContain("synthetic-added");
      expect(added.toString("utf8")).toContain("packages/added");
      await rename(addedDirectory, renamedDirectory);
      await writeFile(
        join(renamedDirectory, "package.json"),
        JSON.stringify({ name: "synthetic-renamed", private: true }),
      );
      const renamed = await sendDaemonRequest(
        officialState.sock_file,
        "DiscoverPackages",
      );
      expect(renamed.toString("utf8")).not.toContain("synthetic-added");
      expect(renamed.toString("utf8")).toContain("synthetic-renamed");
      expect(renamed.toString("utf8")).toContain("packages/renamed");
      await rm(renamedDirectory, { force: true, recursive: true });
      const removed = await sendDaemonRequest(
        officialState.sock_file,
        "DiscoverPackages",
      );
      expect(removed.toString("utf8")).not.toContain("synthetic-renamed");
      await sendDaemonRequest(
        officialState.sock_file,
        "NotifyOutputsWritten",
        Buffer.concat([
          protobufString(1, "synthetic-hash"),
          protobufString(2, "packages/app/build/**"),
        ]),
      );
      await mkdir(join(directory, "packages/app/build"), { recursive: true });
      await writeFile(
        join(directory, "packages/app/build/output.txt"),
        "output\n",
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      const changed = await sendDaemonRequest(
        officialState.sock_file,
        "GetChangedOutputs",
        protobufString(1, "synthetic-hash"),
      );
      expect(changed.toString("utf8")).toContain("packages/app/build/**");
      await sendMalformedDaemonFrame(officialState.sock_file);
      expect(
        (await runOfficial("daemon", "status", "--json")).stdout,
      ).toContain(officialState.sock_file);
      await runOfficial("daemon", "stop");
      await runOfficial("daemon", "start");
      const candidateStatus = await runCandidate("daemon", "status", "--json");
      expect(JSON.parse(candidateStatus.stdout)).toMatchObject({
        pid_file: expect.stringContaining("turbod.pid"),
        sock_file: expect.stringContaining("turbod.sock"),
      });
      await runCandidate("daemon", "stop");
    } finally {
      await runCandidate("daemon", "stop").catch(() => undefined);
      await runOfficial("daemon", "stop").catch(() => undefined);
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it("closes a bound daemon server when endpoint setup fails", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-daemon-setup-"));
    const socket = join(directory, "turbod.sock");
    try {
      await expect(
        Effect.runPromise(
          Stream.runDrain(
            makeDaemonServe({
              setPermissions: async () => {
                throw new Error("synthetic endpoint setup failure");
              },
            })(socket),
          ),
        ),
      ).rejects.toThrow(/synthetic endpoint setup failure/);
      expect(existsSync(socket)).toBe(false);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects daemon requests that exceed the transport queue", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-daemon-queue-"));
    const socket = join(directory, "turbod.sock");
    let releaseRequests: () => void = () => undefined;
    const requestsReleased = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    const serveFiber = Effect.runFork(
      Stream.runForEach(makeDaemonServe()(socket), (connection) =>
        Effect.promise(() => requestsReleased).pipe(
          Effect.zipRight(
            Stream.runForEach(connection.requests, (request) =>
              connection.respond({ id: request.id, result: {} }),
            ),
          ),
        ),
      ),
    );
    try {
      await waitUntil(() => existsSync(socket));
      const requests = Array.from({ length: 66 }, () =>
        sendDaemonRequestResult(socket, "Hello", protobufString(1, "2.0.0")),
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      releaseRequests();
      const responses = await Promise.all(requests);
      const errors = responses.flatMap((response) =>
        response.error === undefined ? [] : [response.error],
      );
      expect(errors.length).toBeGreaterThan(0);
      expect(new Set(errors)).toEqual(
        new Set(["daemon request queue is full"]),
      );
    } finally {
      releaseRequests();
      await Effect.runPromise(Fiber.interrupt(serveFiber));
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("terminates daemon serve when its repository watcher fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-daemon-watcher-"));
    try {
      await prepareFixture(directory);
      const watcherFailure = new BoundaryError({
        boundary: "filesystem",
        message: "synthetic repository watcher failure",
        retryable: false,
      });
      await expect(
        Effect.runPromise(
          executeDaemon({
            command: "serve",
            cwd: directory,
            idleMilliseconds: 30_000,
            json: false,
          }).pipe(
            Effect.provide(
              Layer.succeed(FileWatcherService, {
                watch: () =>
                  Stream.fromEffect(
                    Effect.sleep("100 millis").pipe(
                      Effect.zipRight(Effect.fail(watcherFailure)),
                    ),
                  ),
              }),
            ),
            Effect.provide(nodeFoundationLayer),
          ),
        ),
      ).rejects.toThrow(/synthetic repository watcher failure/);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("retains changed daemon outputs until a response succeeds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-daemon-retry-"));
    try {
      await prepareFixture(directory);
      const responses = new Map<string, unknown>();
      const responseFailure = new BoundaryError({
        boundary: "daemon",
        message: "synthetic response failure",
        retryable: true,
      });
      await Effect.runPromise(
        Effect.gen(function* () {
          const daemon = yield* DaemonService;
          const connection = (
            request: {
              readonly id: string;
              readonly method: (typeof DaemonMethod)[keyof typeof DaemonMethod];
              readonly params?: unknown;
            },
            delay = 0,
          ) => ({
            requests: Stream.fromEffect(
              Effect.sleep(delay).pipe(Effect.as(request)),
            ),
            respond: (response: { readonly id: string }) =>
              request.id === "get-failed"
                ? Effect.fail(responseFailure)
                : Effect.sync(() => {
                    responses.set(request.id, response);
                  }),
          });
          return yield* executeDaemon({
            command: "serve",
            cwd: directory,
            idleMilliseconds: 30_000,
            json: false,
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(DaemonService, {
                  ...daemon,
                  serve: () =>
                    Stream.fromIterable([
                      connection({
                        id: "notify",
                        method: DaemonMethod.notifyOutputsWritten,
                        params: {
                          hash: "synthetic-hash",
                          outputGlobs: ["packages/app/build/**"],
                        },
                      }),
                      connection(
                        {
                          id: "get-failed",
                          method: DaemonMethod.getChangedOutputs,
                          params: { hashes: ["synthetic-hash"] },
                        },
                        30,
                      ),
                      connection({
                        id: "get-retry",
                        method: DaemonMethod.getChangedOutputs,
                        params: { hashes: ["synthetic-hash"] },
                      }),
                      connection({
                        id: "get-empty",
                        method: DaemonMethod.getChangedOutputs,
                        params: { hashes: ["synthetic-hash"] },
                      }),
                    ]),
                }),
                Layer.succeed(FileWatcherService, {
                  watch: (root) =>
                    Stream.fromEffect(
                      Effect.sleep("10 millis").pipe(
                        Effect.as({
                          path: join(root, "packages/app/build/output.txt"),
                          kind: "modify" as const,
                        }),
                      ),
                    ),
                }),
              ),
            ),
          );
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      expect(responses.get("get-retry")).toMatchObject({
        result: {
          changedOutputs: [
            {
              hash: "synthetic-hash",
              changedOutputGlobs: ["packages/app/build/**"],
            },
          ],
        },
      });
      expect(responses.get("get-empty")).toMatchObject({
        result: {
          changedOutputs: [{ hash: "synthetic-hash", changedOutputGlobs: [] }],
        },
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("coordinates daemon stop with an in-progress serve startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-daemon-stop-"));
    try {
      await prepareFixture(directory);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const daemon = yield* DaemonService;
            const fileSystem = yield* FileSystemService;
            const processService = yield* ProcessService;
            const allowServe = yield* Deferred.make<void>();
            const pidCreated = yield* Deferred.make<void>();
            let daemonAlive = true;
            let stopCompleted = false;
            const overrides = Layer.mergeAll(
              Layer.succeed(DaemonService, {
                ...daemon,
                serve: (endpoint) =>
                  Stream.fromEffect(Deferred.await(allowServe)).pipe(
                    Stream.flatMap(() => daemon.serve(endpoint)),
                  ),
                request: (endpoint, request, timeoutMilliseconds) =>
                  daemon.request(endpoint, request, timeoutMilliseconds).pipe(
                    Effect.tap(() =>
                      request.method === DaemonMethod.shutdown
                        ? Effect.sync(() => {
                            daemonAlive = false;
                          })
                        : Effect.void,
                    ),
                  ),
              }),
              Layer.succeed(FileSystemService, {
                ...fileSystem,
                createExclusiveFile: (path, contents) =>
                  fileSystem
                    .createExclusiveFile(path, contents)
                    .pipe(
                      Effect.tap((created) =>
                        created && path.endsWith("turbod.pid")
                          ? Deferred.succeed(pidCreated, undefined).pipe(
                              Effect.ignore,
                            )
                          : Effect.void,
                      ),
                    ),
              }),
              Layer.succeed(ProcessService, {
                ...processService,
                isProcessAlive: (pid) =>
                  pid === process.pid
                    ? Effect.succeed(daemonAlive)
                    : (processService.isProcessAlive?.(pid) ??
                      Effect.succeed(false)),
              }),
            );
            const runDaemon = (command: "serve" | "stop") =>
              executeDaemon({
                command,
                cwd: directory,
                idleMilliseconds: 30_000,
                json: false,
              }).pipe(Effect.provide(overrides));
            const serveFiber = yield* Effect.forkScoped(runDaemon("serve"));
            yield* Deferred.await(pidCreated);
            const stopFiber = yield* Effect.forkScoped(
              runDaemon("stop").pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    stopCompleted = true;
                  }),
                ),
              ),
            );
            yield* Effect.sleep("100 millis");
            expect(stopCompleted).toBe(false);
            yield* Deferred.succeed(allowServe, undefined);
            expect(yield* Fiber.join(stopFiber)).toBe(0);
            expect(yield* Fiber.join(serveFiber)).toBe(0);
          }),
        ).pipe(Effect.provide(nodeFoundationLayer)),
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("preserves live daemon state when lifecycle RPCs fail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-daemon-failure-"));
    try {
      await prepareFixture(directory);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const daemon = yield* DaemonService;
            const fileSystem = yield* FileSystemService;
            const processService = yield* ProcessService;
            const pidCreated = yield* Deferred.make<void>();
            let shutdownFailure: "response" | "transport" | undefined;
            let statusFailure: "response" | "transport" | undefined;
            let pidPath: string | undefined;
            let socketPath: string | undefined;
            let terminationAttempts = 0;
            let daemonAlive = true;
            let shutdownLeavesDaemonAlive = false;
            let terminationBehavior: "fails" | "ineffective" | "succeeds" =
              "succeeds";
            const shutdownTransportFailure = new BoundaryError({
              boundary: "daemon",
              message: "synthetic shutdown transport failure",
              retryable: true,
            });
            const statusTransportFailure = new BoundaryError({
              boundary: "daemon",
              message: "synthetic status transport failure",
              retryable: true,
            });
            const overrides = Layer.mergeAll(
              Layer.succeed(DaemonService, {
                ...daemon,
                serve: (endpoint) => {
                  socketPath = endpoint;
                  return daemon.serve(endpoint);
                },
                request: (endpoint, request, timeoutMilliseconds) => {
                  if (
                    request.method === DaemonMethod.status &&
                    statusFailure !== undefined
                  ) {
                    return statusFailure === "transport"
                      ? Effect.fail(statusTransportFailure)
                      : Effect.succeed({
                          id: request.id,
                          error: "synthetic status response failure",
                        });
                  }
                  if (request.method !== DaemonMethod.shutdown) {
                    return daemon.request(
                      endpoint,
                      request,
                      timeoutMilliseconds,
                    );
                  }
                  if (shutdownFailure === undefined) {
                    if (shutdownLeavesDaemonAlive) {
                      return Effect.succeed({ id: request.id, result: {} });
                    }
                    return daemon
                      .request(endpoint, request, timeoutMilliseconds)
                      .pipe(
                        Effect.tap(() =>
                          Effect.sync(() => {
                            daemonAlive = false;
                          }),
                        ),
                      );
                  }
                  return shutdownFailure === "transport"
                    ? Effect.fail(shutdownTransportFailure)
                    : Effect.succeed({
                        id: request.id,
                        error: "synthetic shutdown response failure",
                      });
                },
              }),
              Layer.succeed(FileSystemService, {
                ...fileSystem,
                createExclusiveFile: (path, contents) =>
                  fileSystem.createExclusiveFile(path, contents).pipe(
                    Effect.tap((created) => {
                      if (!created || !path.endsWith("turbod.pid")) {
                        return Effect.void;
                      }
                      pidPath = path;
                      return Deferred.succeed(pidCreated, undefined).pipe(
                        Effect.ignore,
                      );
                    }),
                  ),
              }),
              Layer.succeed(ProcessService, {
                ...processService,
                isProcessAlive: (pid) =>
                  pid === process.pid
                    ? Effect.succeed(daemonAlive)
                    : (processService.isProcessAlive?.(pid) ??
                      Effect.succeed(false)),
                terminateProcess: () =>
                  Effect.suspend(() => {
                    terminationAttempts += 1;
                    if (terminationBehavior === "fails") {
                      return Effect.fail(
                        new ProcessExecutionError({
                          command: "synthetic-daemon",
                          message: "synthetic termination failure",
                        }),
                      );
                    }
                    if (terminationBehavior === "succeeds") {
                      daemonAlive = false;
                    }
                    return Effect.void;
                  }),
              }),
            );
            const runDaemon = (command: "logs" | "serve" | "status" | "stop") =>
              executeDaemon({
                command,
                cwd: directory,
                idleMilliseconds: 30_000,
                json: command === "status",
              }).pipe(Effect.provide(overrides));
            const serveFiber = yield* Effect.forkScoped(runDaemon("serve"));
            yield* Deferred.await(pidCreated);
            for (const [failure, message] of [
              ["transport", "synthetic shutdown transport failure"],
              [
                "response",
                "daemon shutdown failed: synthetic shutdown response failure",
              ],
            ] as const) {
              shutdownFailure = failure;
              const result = yield* runDaemon("stop").pipe(Effect.either);
              expect(result).toMatchObject({
                _tag: "Left",
                left: { boundary: "daemon", message },
              });
              expect(yield* runDaemon("status")).toBe(0);
              expect(terminationAttempts).toBe(0);
            }
            shutdownFailure = undefined;
            for (const command of ["status", "logs"] as const) {
              for (const [failure, message] of [
                ["transport", "synthetic status transport failure"],
                [
                  "response",
                  "daemon status failed: synthetic status response failure",
                ],
              ] as const) {
                statusFailure = failure;
                const result = yield* runDaemon(command).pipe(Effect.either);
                expect(result).toMatchObject({
                  _tag: "Left",
                  left: { boundary: "daemon", message },
                });
                expect(pidPath).toBeDefined();
                expect(socketPath).toBeDefined();
                expect(yield* fileSystem.exists(pidPath!)).toBe(true);
                expect(yield* fileSystem.exists(socketPath!)).toBe(true);
                expect(
                  yield* fileSystem.exists(
                    join(dirname(pidPath!), "turbod.log-path"),
                  ),
                ).toBe(true);
                statusFailure = undefined;
                expect(yield* runDaemon("status")).toBe(0);
              }
            }
            shutdownLeavesDaemonAlive = true;
            terminationBehavior = "fails";
            const failedTermination = yield* runDaemon("stop").pipe(
              Effect.either,
            );
            expect(failedTermination).toMatchObject({
              _tag: "Left",
              left: {
                boundary: "daemon",
                message:
                  "daemon process termination failed: synthetic termination failure",
              },
            });
            expect(yield* fileSystem.exists(pidPath!)).toBe(true);
            expect(yield* fileSystem.exists(socketPath!)).toBe(true);
            expect(
              yield* fileSystem.exists(
                join(dirname(pidPath!), "turbod.log-path"),
              ),
            ).toBe(true);
            terminationBehavior = "ineffective";
            const ineffectiveTermination = yield* runDaemon("stop").pipe(
              Effect.either,
            );
            expect(ineffectiveTermination).toMatchObject({
              _tag: "Left",
              left: {
                boundary: "daemon",
                message: "daemon process did not terminate",
              },
            });
            expect(yield* fileSystem.exists(pidPath!)).toBe(true);
            expect(yield* fileSystem.exists(socketPath!)).toBe(true);
            expect(terminationAttempts).toBe(2);
            shutdownLeavesDaemonAlive = false;
            terminationBehavior = "succeeds";
            expect(yield* runDaemon("stop")).toBe(0);
            expect(yield* Fiber.join(serveFiber)).toBe(0);
          }),
        ).pipe(Effect.provide(nodeFoundationLayer)),
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("resets the daemon idle deadline after client activity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-daemon-idle-"));
    const runCandidate = (...arguments_: ReadonlyArray<string>) =>
      execFilePromise(process.execPath, [
        candidate,
        ...arguments_,
        "--cwd",
        directory,
      ]);
    try {
      await prepareFixture(directory);
      await runCandidate("daemon", "start", "--idle-time=3000ms");
      const state = JSON.parse(
        (await runCandidate("daemon", "status", "--json")).stdout,
      ) as { readonly sock_file: string };
      for (let request = 0; request < 6; request += 1) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        await sendDaemonRequest(
          state.sock_file,
          "Hello",
          protobufString(1, "2.0.0"),
        );
      }
      expect(
        (await sendDaemonRequest(state.sock_file, "Status")).byteLength,
      ).toBeGreaterThan(0);
    } finally {
      await runCandidate("daemon", "stop").catch(() => undefined);
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("follows daemon logs until the client is interrupted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-daemon-logs-"));
    const runCandidate = (...arguments_: ReadonlyArray<string>) =>
      execFilePromise(process.execPath, [
        candidate,
        ...arguments_,
        "--cwd",
        directory,
      ]);
    let logs: ReturnType<typeof spawn> | undefined;
    try {
      await prepareFixture(directory);
      await runCandidate("daemon", "start", "--idle-time=30s");
      logs = spawn(
        process.execPath,
        [candidate, "daemon", "logs", "--cwd", directory],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      const stdoutStream = logs.stdout;
      if (stdoutStream === null) throw new Error("log stdout is unavailable");
      stdoutStream.setEncoding("utf8");
      stdoutStream.on("data", (chunk: string) => {
        stdout += chunk;
      });
      await waitUntil(() => stdout.includes("daemon started"));
      await runCandidate("daemon", "status", "--json");
      await waitUntil(() => stdout.includes("rpc=Status"));
    } finally {
      if (logs !== undefined) {
        const closed = new Promise<void>((resolve) =>
          logs?.once("close", resolve),
        );
        logs.kill();
        await Promise.race([
          closed,
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
        if (logs.exitCode === null && logs.signalCode === null) {
          logs.kill("SIGKILL");
          await closed;
        }
      }
      await runCandidate("daemon", "stop").catch(() => undefined);
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it("serializes daemon starts and recovers stale shared state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-daemon-race-"));
    const runCandidate = (...arguments_: ReadonlyArray<string>) =>
      execFilePromise(process.execPath, [
        candidate,
        ...arguments_,
        "--cwd",
        directory,
      ]);
    const runOfficial = (...arguments_: ReadonlyArray<string>) =>
      execFilePromise(official, [...arguments_, "--cwd", directory]);
    let sentinel: ReturnType<typeof spawn> | undefined;
    try {
      await prepareFixture(directory);
      const starts = await Promise.allSettled([
        runCandidate("daemon", "start", "--idle-time=30s"),
        runCandidate("daemon", "start", "--idle-time=30s"),
      ]);
      expect(starts.some((result) => result.status === "fulfilled")).toBe(true);
      const running = JSON.parse(
        (await runOfficial("daemon", "status", "--json")).stdout,
      ) as { readonly pid_file: string; readonly sock_file: string };
      await runCandidate("daemon", "stop");

      sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
      if (sentinel.pid === undefined) throw new Error("sentinel did not start");
      await writeFile(running.pid_file, `${sentinel.pid}\n`);
      await writeFile(running.sock_file, "stale socket\n");
      await runCandidate("daemon", "stop");
      expect(
        await readFile(running.pid_file, "utf8").catch(() => undefined),
      ).toBeUndefined();
      expect(
        await readFile(running.sock_file, "utf8").catch(() => undefined),
      ).toBeUndefined();
      expect(sentinel.exitCode).toBeNull();
      await expect(runCandidate("daemon", "status", "--json")).rejects.toThrow(
        /daemon is not running/,
      );
      expect(sentinel.exitCode).toBeNull();
      sentinel.kill();
      await new Promise<void>((resolve) => sentinel?.once("close", resolve));
      sentinel = undefined;

      await mkdir(dirname(running.pid_file), { recursive: true });
      await writeFile(running.pid_file, "99999999\n");
      await writeFile(running.sock_file, "stale socket\n");
      await writeFile(
        join(dirname(running.pid_file), "turbod.lock"),
        "stale lock\n",
      );
      await runCandidate("daemon", "start", "--idle-time=30s");
      expect(
        (await runOfficial("daemon", "status", "--json")).stdout,
      ).toContain(running.sock_file);
      await runCandidate("daemon", "restart", "--idle-time=30s");
      expect(
        (await runOfficial("daemon", "status", "--json")).stdout,
      ).toContain(running.sock_file);
      await runCandidate("daemon", "clean");
      await expect(runCandidate("daemon", "status", "--json")).rejects.toThrow(
        /daemon is not running/,
      );
    } finally {
      sentinel?.kill("SIGKILL");
      await runCandidate("daemon", "stop").catch(() => undefined);
      await runOfficial("daemon", "stop").catch(() => undefined);
      await rm(directory, { force: true, recursive: true });
    }
  }, 60_000);

  it("coalesces file storms, restarts watch runs, and closes on interruption", async () => {
    const parent = await mkdtemp(join(tmpdir(), "turbo-ts-watch-parent-"));
    const reservedParent = join(parent, ".turbo");
    await mkdir(reservedParent);
    const directory = await mkdtemp(join(reservedParent, "repository-"));
    await prepareFixture(directory);
    const appManifestPath = join(directory, "packages/app/package.json");
    const appManifest = JSON.parse(await readFile(appManifestPath, "utf8")) as {
      scripts: Record<string, string>;
    };
    appManifest.scripts.build =
      "node -e \"const fs=require('node:fs');const output=JSON.parse(fs.readFileSync('turbo.json','utf8')).tasks.build.outputs[0].split('/')[0];fs.mkdirSync(output,{recursive:true});fs.writeFileSync(output+'/generated.txt','generated');fs.writeFileSync(output+'/package.json','{}');fs.writeFileSync(output+'/.gitignore','generated');console.log('app build')\"";
    await writeFile(
      appManifestPath,
      `${JSON.stringify(appManifest, undefined, 2)}\n`,
    );
    const child = spawn(
      process.execPath,
      [candidate, "watch", "build", "--cwd", directory, "--no-cache"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const closed = new Promise<void>((resolve) => child.once("close", resolve));
    try {
      await waitUntil(() => stdout.includes("app build"));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(stdout).not.toContain("change detected");
      for (let index = 0; index < 8; index += 1) {
        await writeFile(
          join(directory, "packages/library/source.txt"),
          `storm-${index}\n`,
        );
      }
      await waitUntil(
        () =>
          stdout.includes("change detected") &&
          (stdout.match(/app build/g) ?? []).length >= 2,
      );
      expect((stdout.match(/change detected/g) ?? []).length).toBeLessThan(8);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const buildsBeforeConfigurationChange = (stdout.match(/app build/g) ?? [])
        .length;
      const workspaceConfigurationPath = join(
        directory,
        "packages/app/turbo.json",
      );
      const workspaceConfiguration = JSON.parse(
        await readFile(workspaceConfigurationPath, "utf8"),
      ) as { tasks: { build: { outputs: Array<string> } } };
      workspaceConfiguration.tasks.build.outputs = ["dist/**"];
      await writeFile(
        workspaceConfigurationPath,
        `${JSON.stringify(workspaceConfiguration, undefined, 2)}\n`,
      );
      await waitUntil(
        () =>
          (stdout.match(/app build/g) ?? []).length >=
          buildsBeforeConfigurationChange + 1,
      );
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(
        await readFile(
          join(directory, "packages/app/dist/generated.txt"),
          "utf8",
        ),
      ).toBe("generated");
      expect(stdout, stdout).not.toContain(
        `change detected: ${join(directory, "packages/app/dist")}`,
      );
      const addedWorkspace = join(directory, "packages/added");
      await mkdir(addedWorkspace);
      await writeFile(
        join(addedWorkspace, "package.json"),
        `${JSON.stringify({
          name: "synthetic-added",
          private: true,
          scripts: {
            build:
              "node -e \"const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/generated.txt','generated');console.log('added workspace build')\"",
          },
        })}\n`,
      );
      await waitUntil(() => stdout.includes("added workspace build"));
      await new Promise((resolve) => setTimeout(resolve, 750));
      const addedBuilds = (stdout.match(/added workspace build/g) ?? []).length;
      expect(addedBuilds).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect((stdout.match(/added workspace build/g) ?? []).length).toBe(
        addedBuilds,
      );
      expect(stdout, stdout).not.toContain(
        `change detected: ${join(addedWorkspace, "dist")}`,
      );
      expect(stderr).toContain("• turbo-ts 0.1.0");
    } finally {
      child.kill();
      await Promise.race([
        closed,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await closed;
      }
      await rm(parent, { force: true, recursive: true });
    }
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 40_000);

  it("uses task inputs and file entry types for watch changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-watch-inputs-"));
    await prepareFixture(directory);
    const configurationPath = join(directory, "turbo.json");
    const configuration = JSON.parse(
      await readFile(configurationPath, "utf8"),
    ) as Record<string, unknown>;
    configuration.futureFlags = {
      watchUsingTaskInputs: true,
      strictTaskEntrypointSelection: true,
    };
    configuration.tasks = {
      alpha: {
        cache: false,
        inputs: ["alpha.txt", "generated", "dist/config.json"],
        outputs: ["dist/**", "!dist/config.json"],
      },
      beta: { cache: false, inputs: ["beta.txt"] },
    };
    await writeFile(
      configurationPath,
      `${JSON.stringify(configuration, undefined, 2)}\n`,
    );
    const applicationDirectory = join(directory, "packages/app");
    const applicationManifestPath = join(applicationDirectory, "package.json");
    const applicationManifest = JSON.parse(
      await readFile(applicationManifestPath, "utf8"),
    ) as { scripts: Record<string, string> };
    applicationManifest.scripts.alpha = "node -e \"console.log('alpha run')\"";
    applicationManifest.scripts.beta = "node -e \"console.log('beta run')\"";
    await writeFile(
      applicationManifestPath,
      `${JSON.stringify(applicationManifest, undefined, 2)}\n`,
    );
    const ignoredSource = join(applicationDirectory, "ignored-source");
    await mkdir(ignoredSource);
    await writeFile(join(ignoredSource, "input.txt"), "input\n");
    await writeFile(
      join(applicationDirectory, ".gitignore"),
      "ignored-source/\ngenerated/\n",
    );
    const child = spawn(
      process.execPath,
      [
        candidate,
        "watch",
        "alpha",
        "beta",
        "--filter=synthetic-app",
        "--cwd",
        directory,
        "--no-cache",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const closed = new Promise<void>((resolve) => child.once("close", resolve));
    try {
      await waitUntil(
        () => stdout.includes("alpha run") && stdout.includes("beta run"),
      );
      await rename(
        join(ignoredSource, "input.txt"),
        join(applicationDirectory, "generated"),
      );
      await waitUntil(
        () =>
          (stdout.match(/synthetic-app:alpha: cache miss, executing/g) ?? [])
            .length >= 2,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(
        (stdout.match(/synthetic-app:beta: cache miss, executing/g) ?? [])
          .length,
        stdout,
      ).toBe(1);

      await mkdir(join(applicationDirectory, "dist"));
      await writeFile(
        join(applicationDirectory, "dist/config.json"),
        "excluded output input\n",
      );
      await waitUntil(
        () =>
          (stdout.match(/synthetic-app:alpha: cache miss, executing/g) ?? [])
            .length >= 3,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(
        (stdout.match(/synthetic-app:beta: cache miss, executing/g) ?? [])
          .length,
        stdout,
      ).toBe(1);

      const alphaRuns = (
        stdout.match(/synthetic-app:alpha: cache miss, executing/g) ?? []
      ).length;
      const betaRuns = (
        stdout.match(/synthetic-app:beta: cache miss, executing/g) ?? []
      ).length;
      await Promise.all([
        writeFile(join(applicationDirectory, "alpha.txt"), "alpha change\n"),
        writeFile(join(applicationDirectory, "beta.txt"), "beta change\n"),
      ]);
      await waitUntil(
        () =>
          (stdout.match(/synthetic-app:alpha: cache miss, executing/g) ?? [])
            .length > alphaRuns &&
          (stdout.match(/synthetic-app:beta: cache miss, executing/g) ?? [])
            .length > betaRuns,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(
        (stdout.match(/synthetic-app:alpha: cache miss, executing/g) ?? [])
          .length,
        stdout,
      ).toBe(alphaRuns + 1);
      expect(
        (stdout.match(/synthetic-app:beta: cache miss, executing/g) ?? [])
          .length,
        stdout,
      ).toBe(betaRuns + 1);
    } finally {
      child.kill();
      await Promise.race([
        closed,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await closed;
      }
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it("recovers a watch task after a failed run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-recovery-"));
    await prepareFixture(directory);
    const child = spawn(
      process.execPath,
      [candidate, "watch", "fail", "--cwd", directory, "--no-cache"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const closed = new Promise<void>((resolve) => child.once("close", resolve));
    try {
      await waitUntil(() => stdout.includes("Command failed with exit code 7"));
      const manifestPath = join(directory, "packages/app/package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      manifest.scripts.fail = `node -e "console.log('watch recovered')"`;
      await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, undefined, 2)}\n`,
      );
      await waitUntil(() => stdout.includes("watch recovered"));
    } finally {
      child.kill();
      await Promise.race([
        closed,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await closed;
      }
      await rm(directory, { force: true, recursive: true });
    }
  }, 40_000);

  it("serves GraphQL queries and isolates malformed HTTP requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-query-server-"));
    const outside = await mkdtemp(join(tmpdir(), "turbo-ts-query-outside-"));
    await prepareFixture(directory);
    const appManifestPath = join(directory, "packages/app/package.json");
    const appManifest = JSON.parse(await readFile(appManifestPath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    appManifest.dependencies["external-package"] = "1.2.3";
    await writeFile(
      appManifestPath,
      `${JSON.stringify(appManifest, undefined, 2)}\n`,
    );
    await writeFile(
      join(directory, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  .: {}
  packages/app:
    dependencies:
      synthetic-library:
        specifier: workspace:*
        version: link:../library
      external-package:
        specifier: 1.2.3
        version: 1.2.3
  packages/library: {}
packages:
  external-package@1.2.3: {}
  external-package@9.9.9: {}
snapshots:
  external-package@1.2.3: {}
  external-package@9.9.9: {}
`,
    );
    await writeFile(join(outside, "secret.txt"), "outside\n");
    await symlink(join(outside, "secret.txt"), join(directory, "outside.txt"));
    const child = spawn(
      process.execPath,
      [candidate, "query", "--port=0", "--cwd", directory],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const closed = new Promise<void>((resolve) => child.once("close", resolve));
    try {
      await waitUntil(() =>
        /GraphQL endpoint: http:\/\/localhost:\d+/.test(stdout),
      );
      const port = /GraphQL endpoint: http:\/\/localhost:(\d+)/.exec(
        stdout,
      )?.[1];
      expect(port).toBeDefined();
      const endpoint = `http://127.0.0.1:${port}`;
      const graphiql = await fetch(endpoint);
      expect(graphiql.status).toBe(200);
      expect(await graphiql.text()).toContain("GraphQL endpoint");

      const malformed = await fetch(endpoint, {
        method: "POST",
        body: "{not-json",
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({
        errors: [{ message: "invalid JSON request" }],
      });

      const oversized = await fetch(endpoint, {
        method: "POST",
        body: "x".repeat(1024 * 1024 + 1),
      });
      expect(oversized.status).toBe(413);

      const query = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ version packages { length } }" }),
      });
      expect(query.status).toBe(200);
      expect(await query.json()).toEqual({
        data: { version: "2.10.12", packages: { length: 3 } },
      });
      const filtered = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query:
            '{ packages(filter: { equal: { field: "name", value: "synthetic-app" } }) { length items { name } } externalDependencies { length items } }',
        }),
      });
      expect(await filtered.json()).toEqual({
        data: {
          packages: { length: 1, items: [{ name: "synthetic-app" }] },
          externalDependencies: {
            length: 1,
            items: [{ name: "external-package", version: "1.2.3" }],
          },
        },
      });
      const packageGraphs = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query:
            '{ centered: packageGraph(center: "synthetic-app") { nodes { items { name } } edges { items { source target } } } filtered: packageGraph(filter: { equal: { field: "name", value: "synthetic-library" } }) { nodes { items { name } } edges { items { source target } } } }',
        }),
      });
      expect(await packageGraphs.json()).toEqual({
        data: {
          centered: {
            nodes: {
              items: [{ name: "synthetic-app" }, { name: "synthetic-library" }],
            },
            edges: {
              items: [
                {
                  source: "synthetic-app",
                  target: "synthetic-library",
                },
              ],
            },
          },
          filtered: {
            nodes: { items: [{ name: "synthetic-library" }] },
            edges: {
              items: [
                {
                  source: "synthetic-app",
                  target: "synthetic-library",
                },
              ],
            },
          },
        },
      });
      const escapedFile = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: '{ file(path: "outside.txt") { contents } }',
        }),
      });
      expect(escapedFile.status).toBe(400);
      expect(JSON.stringify(await escapedFile.json())).toContain(
        "file path must stay within the repository",
      );
      const relationships = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query:
            '{ package(name: "synthetic-app") { tasks { items { name directDependencies { items { fullName } } } } } }',
        }),
      });
      expect(relationships.status).toBe(200);
      expect(await relationships.json()).toMatchObject({
        data: {
          package: {
            tasks: {
              items: expect.arrayContaining([
                {
                  name: "build",
                  directDependencies: {
                    items: [{ fullName: "synthetic-library#build" }],
                  },
                },
              ]),
            },
          },
        },
      });
      await rm(join(directory, "pnpm-lock.yaml"));
      const independent = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "{ version packageGraph { nodes { length } } }",
        }),
      });
      expect(independent.status).toBe(200);
      expect(await independent.json()).toEqual({
        data: {
          version: "2.10.12",
          packageGraph: { nodes: { length: 3 } },
        },
      });
      const missingExternalDependencies = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "{ externalDependencies { length } }",
        }),
      });
      expect(missingExternalDependencies.status).toBe(400);
      expect(
        JSON.stringify(await missingExternalDependencies.json()),
      ).toContain("externalDependencies");
    } finally {
      child.kill();
      await Promise.race([
        closed,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await closed;
      }
      await rm(directory, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  }, 30_000);

  it("interrupts affected GraphQL work when its HTTP request closes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-query-cancel-"));
    const git = (...arguments_: ReadonlyArray<string>) =>
      execFilePromise("/usr/bin/git", [
        "-C",
        directory,
        "-c",
        "user.email=synthetic@example.test",
        "-c",
        "user.name=Synthetic Fixture",
        ...arguments_,
      ]);
    try {
      await prepareFixture(directory);
      await git("init", "--quiet");
      await git("add", ".");
      await git("commit", "--quiet", "-m", "base");
      await writeFile(join(directory, "packages/app/source.txt"), "changed\n");
      await git("add", ".");
      await git("commit", "--quiet", "-m", "changed");
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const processService = yield* ProcessService;
            const terminal = yield* TerminalService;
            const gitStarted = yield* Deferred.make<void>();
            const gitFinalized = yield* Deferred.make<void>();
            let stdout = "";
            const overrides = Layer.mergeAll(
              Layer.succeed(ProcessService, {
                ...processService,
                runBytes: (request) =>
                  request.command === "git" && request.args[0] === "diff"
                    ? Effect.acquireRelease(
                        Deferred.succeed(gitStarted, undefined),
                        () => Deferred.succeed(gitFinalized, undefined),
                      ).pipe(Effect.zipRight(Effect.never))
                    : processService.runBytes(request),
              }),
              Layer.succeed(TerminalService, {
                ...terminal,
                writeStdout: (text) =>
                  Effect.sync(() => {
                    stdout += text;
                  }),
              }),
            );
            const serverFiber = yield* Effect.forkScoped(
              executeQuery({
                cwd: directory,
                schema: false,
                port: 0,
              }).pipe(Effect.provide(overrides)),
            );
            while (!stdout.includes("GraphQL endpoint:")) {
              yield* Effect.sleep("10 millis");
            }
            const port = /GraphQL endpoint: http:\/\/localhost:(\d+)/.exec(
              stdout,
            )?.[1];
            expect(port).toBeDefined();
            const controller = new AbortController();
            const request = fetch(`http://127.0.0.1:${port}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                query:
                  '{ affectedPackages(base: "HEAD~1", head: "HEAD") { length } }',
              }),
              signal: controller.signal,
            }).catch(() => undefined);
            yield* Deferred.await(gitStarted);
            controller.abort();
            yield* Deferred.await(gitFinalized);
            yield* Effect.promise(() => request);
            yield* Fiber.interrupt(serverFiber);
          }),
        ).pipe(Effect.provide(nodeFoundationLayer)),
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("matches the reference prune output and generated tree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-prune-"));
    const output = join(directory, "result");
    try {
      await prepareFixture(directory);
      await writeFile(
        join(directory, ".gitignore"),
        "packages/app/generated.txt\n",
      );
      await writeFile(
        join(directory, ".pnpmfile.cjs"),
        "module.exports = { hooks: {} };\n",
      );
      await writeFile(
        join(directory, "bunfig.toml"),
        '[install]\nlinker = "isolated"\n',
      );
      await writeFile(
        join(directory, "packages/app/generated.txt"),
        "ignored\n",
      );
      await mkdir(join(directory, ".yarn/releases"), { recursive: true });
      await mkdir(join(directory, ".yarn/patches"), { recursive: true });
      await writeFile(
        join(directory, ".yarnrc.yml"),
        "yarnPath: .yarn/releases/yarn.cjs\n",
      );
      await writeFile(join(directory, ".pnp.cjs"), "module.exports = {};\n");
      await writeFile(join(directory, ".yarn/releases/yarn.cjs"), "release\n");
      await writeFile(
        join(directory, ".yarn/patches/example.patch"),
        "patch\n",
      );
      await writeFile(
        join(directory, "packages/library/shared.txt"),
        "shared\n",
      );
      const reference = await executeDifferentialCommand(official, [
        "--cwd",
        directory,
        "prune",
        "synthetic-app",
        "--out-dir=result",
      ]);
      const referenceTree = await readTextTree(output);
      await rm(output, { force: true, recursive: true });
      await symlink(
        "../library/shared.txt",
        join(directory, "packages/app/shared-link.txt"),
      );
      const implementation = await executeDifferentialCommand(
        process.execPath,
        [
          candidate,
          "--cwd",
          directory,
          "prune",
          "synthetic-app",
          "--out-dir=result",
        ],
      );
      expect(implementation.stdout).toBe(reference.stdout);
      expect(normalizeOutput(implementation.stderr, ["branding"])).toBe(
        reference.stderr,
      );
      const implementationTree = await readTextTree(output);
      const {
        ".pnp.cjs": pnpLoader,
        ".pnpmfile.cjs": pnpmHook,
        ".yarn/patches/example.patch": yarnPatch,
        ...referenceCompatibleTree
      } = implementationTree;
      expect(referenceCompatibleTree).toEqual(referenceTree);
      expect(pnpLoader).toBe("module.exports = {};\n");
      expect(pnpmHook).toBe("module.exports = { hooks: {} };\n");
      expect(yarnPatch).toBe("patch\n");
      expect(
        await readFile(
          join(output, "packages/app/generated.txt"),
          "utf8",
        ).catch(() => undefined),
      ).toBeUndefined();
      expect(await readlink(join(output, "packages/app/shared-link.txt"))).toBe(
        "../library/shared.txt",
      );
      expect(await readFile(join(output, ".yarnrc.yml"), "utf8")).toContain(
        "yarnPath",
      );
      expect(await readFile(join(output, ".pnpmfile.cjs"), "utf8")).toBe(
        "module.exports = { hooks: {} };\n",
      );
      expect(
        await readFile(join(output, ".yarn/releases/yarn.cjs"), "utf8"),
      ).toBe("release\n");
      await executeDifferentialCommand(process.execPath, [
        candidate,
        "--cwd",
        directory,
        "prune",
        "synthetic-app",
        "--docker",
        "--out-dir=docker-result",
      ]);
      expect(
        await readFile(
          join(directory, "docker-result/json/.yarnrc.yml"),
          "utf8",
        ),
      ).toContain("yarnPath");
      expect(
        await readFile(
          join(directory, "docker-result/json/.yarn/patches/example.patch"),
          "utf8",
        ),
      ).toBe("patch\n");
      for (const root of ["full", "json"]) {
        expect(
          await readFile(
            join(directory, `docker-result/${root}/.pnpmfile.cjs`),
            "utf8",
          ),
        ).toBe("module.exports = { hooks: {} };\n");
        expect(
          await readFile(
            join(directory, `docker-result/${root}/bunfig.toml`),
            "utf8",
          ),
        ).toBe('[install]\nlinker = "isolated"\n');
      }
      const applicationManifestPath = join(
        directory,
        "packages/app/package.json",
      );
      const applicationManifest = JSON.parse(
        await readFile(applicationManifestPath, "utf8"),
      ) as Record<string, unknown>;
      applicationManifest.devDependencies = {
        "synthetic-development-only": "workspace:*",
      };
      await writeFile(
        applicationManifestPath,
        `${JSON.stringify(applicationManifest, undefined, 2)}\n`,
      );
      const developmentOnlyDirectory = join(
        directory,
        "packages/development-only",
      );
      await mkdir(developmentOnlyDirectory);
      await writeFile(
        join(developmentOnlyDirectory, "package.json"),
        `${JSON.stringify({
          name: "synthetic-development-only",
          version: "1.0.0",
          private: true,
        })}\n`,
      );
      await writeFile(
        join(directory, "pnpm-lock.yaml"),
        `${workflowLockfile.trimEnd()}
  packages/development-only: {}
`,
      );
      await executeDifferentialCommand(process.execPath, [
        candidate,
        "--cwd",
        directory,
        "prune",
        "synthetic-app",
        "--production",
        "--out-dir=production-result",
      ]);
      for (const path of [
        "package.json",
        "turbo.json",
        "pnpm-workspace.yaml",
        "packages/app/package.json",
      ]) {
        expect(
          (await stat(join(directory, "production-result", path))).mode & 0o777,
        ).toBe(0o644);
      }
      expect(
        await readFile(
          join(
            directory,
            "production-result/packages/development-only/package.json",
          ),
          "utf8",
        ).catch(() => undefined),
      ).toBeUndefined();
      expect(
        await readFile(
          join(directory, "production-result/pnpm-lock.yaml"),
          "utf8",
        ),
      ).not.toContain("packages/development-only");
      expect(
        JSON.parse(
          await readFile(
            join(directory, "production-result/packages/app/package.json"),
            "utf8",
          ),
        ),
      ).not.toHaveProperty("devDependencies");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it("copies opted-in global dependency files into prune source trees", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-prune-global-"));
    try {
      await prepareFixture(directory);
      const configurationPath = join(directory, "turbo.json");
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as Record<string, unknown>;
      configuration.globalDependencies = [
        "tooling/*.json",
        "!tooling/excluded.json",
      ];
      configuration.futureFlags = { pruneIncludesGlobalFiles: true };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, undefined, 2)}\n`,
      );
      await mkdir(join(directory, "tooling"));
      await writeFile(join(directory, "tooling/included.json"), "{}\n");
      await writeFile(join(directory, "tooling/excluded.json"), "{}\n");
      await writeFile(join(directory, "tooling/ignored.json"), "{}\n");
      await writeFile(join(directory, ".gitignore"), "tooling/ignored.json\n");
      await executeDifferentialCommand(process.execPath, [
        candidate,
        "--cwd",
        directory,
        "prune",
        "synthetic-app",
        "--out-dir=result",
      ]);
      expect(
        await readFile(join(directory, "result/tooling/included.json"), "utf8"),
      ).toBe("{}\n");
      for (const name of ["excluded.json", "ignored.json"]) {
        expect(
          await readFile(join(directory, "result/tooling", name), "utf8").catch(
            () => undefined,
          ),
        ).toBeUndefined();
      }
      await executeDifferentialCommand(process.execPath, [
        candidate,
        "--cwd",
        directory,
        "prune",
        "synthetic-app",
        "--docker",
        "--out-dir=docker-result",
      ]);
      expect(
        await readFile(
          join(directory, "docker-result/full/tooling/included.json"),
          "utf8",
        ),
      ).toBe("{}\n");
      expect(
        await readFile(
          join(directory, "docker-result/json/tooling/included.json"),
          "utf8",
        ).catch(() => undefined),
      ).toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it("copies a contained configured Yarn executable into prune outputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-prune-yarn-"));
    try {
      await prepareFixture(directory);
      const rootManifestPath = join(directory, "package.json");
      const rootManifest = JSON.parse(
        await readFile(rootManifestPath, "utf8"),
      ) as Record<string, unknown>;
      rootManifest.packageManager = "yarn@4.18.0";
      rootManifest.workspaces = ["packages/*"];
      await writeFile(
        rootManifestPath,
        `${JSON.stringify(rootManifest, undefined, 2)}\n`,
      );
      await writeFile(join(directory, ".pnp.cjs"), "module.exports = {};\n");
      await writeFile(
        join(directory, ".yarnrc.yml"),
        "yarnPath: scripts/yarn.cjs\n",
      );
      await mkdir(join(directory, "scripts"));
      await writeFile(join(directory, "scripts/yarn.cjs"), "yarn executable\n");

      await executeDifferentialCommand(process.execPath, [
        candidate,
        "prune",
        "synthetic-app",
        "--out-dir=yarn-result",
        "--cwd",
        directory,
      ]);
      expect(
        await readFile(join(directory, "yarn-result/scripts/yarn.cjs"), "utf8"),
      ).toBe("yarn executable\n");

      await executeDifferentialCommand(process.execPath, [
        candidate,
        "prune",
        "synthetic-app",
        "--docker",
        "--out-dir=yarn-docker-result",
        "--cwd",
        directory,
      ]);
      for (const root of ["full", "json"]) {
        expect(
          await readFile(
            join(directory, `yarn-docker-result/${root}/scripts/yarn.cjs`),
            "utf8",
          ),
        ).toBe("yarn executable\n");
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it("includes root workspace dependencies in the prune closure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-prune-root-"));
    const output = join(directory, "result");
    try {
      await prepareFixture(directory);
      const rootManifest = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      rootManifest.dependencies = { "synthetic-root-only": "workspace:*" };
      await writeFile(
        join(directory, "package.json"),
        `${JSON.stringify(rootManifest, undefined, 2)}\n`,
      );
      for (const [path, manifest] of [
        [
          "root-only",
          {
            name: "synthetic-root-only",
            private: true,
            dependencies: { "synthetic-root-leaf": "workspace:*" },
          },
        ],
        ["root-leaf", { name: "synthetic-root-leaf", private: true }],
        ["unused", { name: "synthetic-unused", private: true }],
      ] as const) {
        await mkdir(join(directory, `packages/${path}`), { recursive: true });
        await writeFile(
          join(directory, `packages/${path}/package.json`),
          `${JSON.stringify(manifest, undefined, 2)}\n`,
        );
      }
      await writeFile(
        join(directory, "pnpm-lock.yaml"),
        `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      synthetic-root-only:
        specifier: workspace:*
        version: link:packages/root-only
  packages/app:
    dependencies:
      synthetic-library:
        specifier: workspace:*
        version: link:../library
  packages/library: {}
  packages/root-only:
    dependencies:
      synthetic-root-leaf:
        specifier: workspace:*
        version: link:../root-leaf
  packages/root-leaf: {}
  packages/unused: {}
`,
      );
      await executeDifferentialCommand(process.execPath, [
        candidate,
        "--cwd",
        directory,
        "prune",
        "synthetic-app",
        "--out-dir=result",
      ]);
      expect(
        await readFile(join(output, "packages/root-only/package.json"), "utf8"),
      ).toContain("synthetic-root-only");
      expect(
        await readFile(join(output, "packages/root-leaf/package.json"), "utf8"),
      ).toContain("synthetic-root-leaf");
      expect(
        await readFile(
          join(output, "packages/unused/package.json"),
          "utf8",
        ).catch(() => undefined),
      ).toBeUndefined();
      const lockfile = await readFile(join(output, "pnpm-lock.yaml"), "utf8");
      expect(lockfile).toContain("packages/root-only:");
      expect(lockfile).toContain("packages/root-leaf:");
      expect(lockfile).not.toContain("packages/unused:");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it("selects every cross-ecosystem package matching a plain prune scope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-prune-scopes-"));
    const packageName = "synthetic-polyglot";
    const javascriptDirectory = join(directory, "packages/polyglot");
    const cargoWorkspaceDirectory = join(directory, "rust");
    const cargoDirectory = join(cargoWorkspaceDirectory, "polyglot");
    const cargoDependencyDirectory = join(cargoWorkspaceDirectory, "leaf");
    const uvDirectory = join(directory, "python/polyglot");
    const cargoPackageId = `path+file://${cargoDirectory}#${packageName}@0.1.0`;
    const cargoDependencyId = `path+file://${cargoDependencyDirectory}#synthetic-cargo-leaf@0.1.0`;
    try {
      await prepareFixture(directory);
      const configurationPath = join(directory, "turbo.json");
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as { futureFlags?: Record<string, boolean> };
      configuration.futureFlags = {
        ...configuration.futureFlags,
        experimentalCargoWorkspaces: true,
        experimentalPythonWorkspaces: true,
      };
      await writeFile(
        configurationPath,
        `${JSON.stringify(configuration, undefined, 2)}\n`,
      );
      await mkdir(javascriptDirectory, { recursive: true });
      await writeFile(
        join(javascriptDirectory, "package.json"),
        `${JSON.stringify({ name: packageName, private: true }, undefined, 2)}\n`,
      );
      await mkdir(cargoDirectory, { recursive: true });
      await mkdir(cargoDependencyDirectory, { recursive: true });
      await writeFile(
        join(cargoWorkspaceDirectory, "Cargo.toml"),
        '[workspace]\nmembers = ["polyglot", "leaf"]\nresolver = "3"\n',
      );
      await writeFile(
        join(cargoDirectory, "Cargo.toml"),
        `[package]\nname = "${packageName}"\nversion = "0.1.0"\nedition = "2024"\n`,
      );
      await writeFile(
        join(cargoDependencyDirectory, "Cargo.toml"),
        '[package]\nname = "synthetic-cargo-leaf"\nversion = "0.1.0"\nedition = "2024"\n',
      );
      await writeFile(
        join(cargoWorkspaceDirectory, "Cargo.lock"),
        `version = 4\n\n[[package]]\nname = "${packageName}"\nversion = "0.1.0"\n\n[[package]]\nname = "synthetic-cargo-leaf"\nversion = "0.1.0"\n`,
      );
      await writeFile(
        join(directory, "pyproject.toml"),
        '[tool.uv.workspace]\nmembers = ["python/polyglot"]\n',
      );
      await mkdir(uvDirectory, { recursive: true });
      await writeFile(
        join(uvDirectory, "pyproject.toml"),
        `[project]\nname = "${packageName}"\nversion = "0.1.0"\ndependencies = []\n`,
      );
      await writeFile(
        join(directory, "uv.lock"),
        "version = 1\nrevision = 1\n",
      );
      const cargoMetadata = JSON.stringify({
        workspace_root: cargoWorkspaceDirectory,
        workspace_members: [cargoPackageId, cargoDependencyId],
        target_directory: join(cargoWorkspaceDirectory, "target"),
        packages: [
          {
            id: cargoPackageId,
            name: packageName,
            version: "0.1.0",
            manifest_path: join(cargoDirectory, "Cargo.toml"),
            dependencies: [
              {
                name: "synthetic-cargo-leaf",
                path: cargoDependencyDirectory,
              },
            ],
            targets: [{ kind: ["lib"], name: "synthetic_polyglot" }],
          },
          {
            id: cargoDependencyId,
            name: "synthetic-cargo-leaf",
            version: "0.1.0",
            manifest_path: join(cargoDependencyDirectory, "Cargo.toml"),
            dependencies: [],
            targets: [{ kind: ["lib"], name: "synthetic_cargo_leaf" }],
          },
        ],
      });
      const runPrune = (
        scopes: ReadonlyArray<string>,
        outputDirectory: string,
        docker = false,
      ) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const processService = yield* ProcessService;
            return yield* executePrune({
              scopes,
              cwd: directory,
              outputDirectory,
              docker,
              production: false,
              useGitignore: false,
            }).pipe(
              Effect.provide(
                Layer.succeed(ProcessService, {
                  ...processService,
                  run: (request) => {
                    if (
                      request.command === "cargo" &&
                      request.args[0] === "metadata"
                    ) {
                      return Effect.succeed({
                        exitCode: 0,
                        stdout: cargoMetadata,
                        stderr: "",
                        combinedOutput: cargoMetadata,
                      });
                    }
                    if (request.command === "rustc") {
                      const stdout =
                        "rustc 1.96.0-nightly\nhost: synthetic-target-triple\n";
                      return Effect.succeed({
                        exitCode: 0,
                        stdout,
                        stderr: "",
                        combinedOutput: stdout,
                      });
                    }
                    return processService.run(request);
                  },
                }),
              ),
            );
          }).pipe(Effect.provide(nodeFoundationLayer)),
        );
      const qualifiedOutput = join(directory, "qualified-result");
      expect(await runPrune([`cargo:${packageName}`], qualifiedOutput)).toBe(0);
      expect(
        await readFile(
          join(qualifiedOutput, "rust/polyglot/Cargo.toml"),
          "utf8",
        ),
      ).toContain(packageName);
      expect(
        await readFile(join(qualifiedOutput, "rust/leaf/Cargo.toml"), "utf8"),
      ).toContain("synthetic-cargo-leaf");
      expect(
        await readFile(
          join(qualifiedOutput, "packages/polyglot/package.json"),
          "utf8",
        ).catch(() => undefined),
      ).toBeUndefined();
      expect(
        await readFile(
          join(qualifiedOutput, "python/polyglot/pyproject.toml"),
          "utf8",
        ).catch(() => undefined),
      ).toBeUndefined();
      await rm(qualifiedOutput, { force: true, recursive: true });
      const plainOutput = join(directory, "plain-result");
      expect(await runPrune([packageName], plainOutput)).toBe(0);
      for (const path of [
        "packages/polyglot/package.json",
        "rust/polyglot/Cargo.toml",
        "rust/leaf/Cargo.toml",
        "python/polyglot/pyproject.toml",
      ]) {
        expect(await readFile(join(plainOutput, path), "utf8")).not.toBe("");
      }
      const dockerOutput = join(directory, "docker-result");
      expect(await runPrune([packageName], dockerOutput, true)).toBe(0);
      for (const path of [
        "rust/polyglot/Cargo.toml",
        "rust/leaf/Cargo.toml",
        "python/polyglot/pyproject.toml",
      ]) {
        expect(
          await readFile(join(dockerOutput, "full", path), "utf8"),
        ).not.toBe("");
        expect(
          await readFile(join(dockerOutput, "json", path), "utf8").catch(
            () => undefined,
          ),
        ).toBeUndefined();
      }
      expect(
        await readFile(
          join(dockerOutput, "json/packages/polyglot/package.json"),
          "utf8",
        ),
      ).toContain(packageName);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it("rejects unsafe prune output aliases and escaping package symlinks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-prune-safety-"));
    const outside = await mkdtemp(join(tmpdir(), "turbo-ts-prune-control-"));
    try {
      await prepareFixture(directory);
      await mkdir(join(directory, "config"));
      await writeFile(join(directory, "config/npmrc"), "safe-control\n");
      await symlink("config/npmrc", join(directory, ".npmrc"));
      await execFilePromise(process.execPath, [
        candidate,
        "prune",
        "synthetic-app",
        "--out-dir=safe-control-result",
        "--cwd",
        directory,
      ]);
      expect(
        await readlink(join(directory, "safe-control-result/.npmrc")),
      ).toBe("config/npmrc");
      expect(
        await readFile(join(directory, "safe-control-result/.npmrc"), "utf8"),
      ).toBe("safe-control\n");
      expect(
        await readFile(
          join(directory, "safe-control-result/config/npmrc"),
          "utf8",
        ),
      ).toBe("safe-control\n");
      await execFilePromise(process.execPath, [
        candidate,
        "prune",
        "synthetic-app",
        "--docker",
        "--out-dir=safe-control-docker",
        "--cwd",
        directory,
      ]);
      for (const root of ["full", "json"]) {
        expect(
          await readFile(
            join(directory, `safe-control-docker/${root}/.npmrc`),
            "utf8",
          ),
        ).toBe("safe-control\n");
        expect(
          await readFile(
            join(directory, `safe-control-docker/${root}/config/npmrc`),
            "utf8",
          ),
        ).toBe("safe-control\n");
      }
      await rm(join(directory, ".npmrc"));
      const outsideControl = join(outside, ".npmrc");
      await writeFile(outsideControl, "registry-token=secret\n");
      await symlink(
        relative(directory, outsideControl),
        join(directory, ".npmrc"),
      );
      await expect(
        execFilePromise(process.execPath, [
          candidate,
          "prune",
          "synthetic-app",
          "--out-dir=unsafe-control-result",
          "--cwd",
          directory,
        ]),
      ).rejects.toThrow(
        /prune root control symlink must use a relative target/,
      );
      await rm(join(directory, ".npmrc"));
      const exactOutput = join(directory, "packages/app/exact-output");
      await symlink(outside, exactOutput);
      await expect(
        execFilePromise(process.execPath, [
          candidate,
          "prune",
          "synthetic-app",
          "--out-dir=packages/app/exact-output",
          "--use-gitignore=false",
          "--cwd",
          directory,
        ]),
      ).rejects.toThrow(/prune output must not be a symlink/);
      expect(await readlink(exactOutput)).toBe(outside);
      await rm(exactOutput);
      await symlink(".", join(directory, "output-alias"));
      await expect(
        execFilePromise(process.execPath, [
          candidate,
          "prune",
          "synthetic-app",
          "--out-dir=output-alias",
          "--cwd",
          directory,
        ]),
      ).rejects.toThrow(/prune output must not contain the repository root/);
      await rm(join(directory, "output-alias"));
      await symlink("packages/app", join(directory, "output-parent"));
      await execFilePromise(process.execPath, [
        candidate,
        "prune",
        "synthetic-app",
        "--out-dir=output-parent/generated-out",
        "--cwd",
        directory,
      ]);
      expect(
        await readdir(
          join(
            directory,
            "packages/app/generated-out/packages/app/generated-out",
          ),
        ).catch(() => undefined),
      ).toBeUndefined();
      await rm(join(directory, "packages/app/generated-out"), {
        force: true,
        recursive: true,
      });
      await rm(join(directory, "output-parent"));
      await writeFile(join(directory, "secret.txt"), "secret\n");
      await symlink(
        "../../secret.txt",
        join(directory, "packages/app/secret-link.txt"),
      );
      await expect(
        execFilePromise(process.execPath, [
          candidate,
          "prune",
          "synthetic-app",
          "--out-dir=safe-result",
          "--cwd",
          directory,
        ]),
      ).rejects.toThrow(/prune symlink must use a relative target/);
    } finally {
      await rm(directory, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  }, 15_000);

  it("rejects a workflow cwd that resolves to a regular file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-workflow-cwd-"));
    const file = join(directory, "not-a-directory");
    try {
      await writeFile(file, "file\n");
      await expect(
        execFilePromise(process.execPath, [candidate, "query", "--cwd", file]),
      ).rejects.toThrow(/working directory is not a directory/);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects a selected symlinked workspace before prune traversal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-prune-link-"));
    try {
      await prepareFixture(directory);
      await cp(
        join(directory, "packages/app"),
        join(directory, ".workspace-target"),
        { recursive: true },
      );
      await rm(join(directory, "packages/app"), {
        force: true,
        recursive: true,
      });
      await symlink("../.workspace-target", join(directory, "packages/app"));
      await expect(
        execFilePromise(process.execPath, [
          candidate,
          "prune",
          "synthetic-app",
          "--cwd",
          directory,
        ]),
      ).rejects.toThrow(/cannot prune symlinked workspace/);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);

  it("matches affected task and package responses", async () => {
    const fixtureParent = join(repositoryRoot, ".turbo");
    await mkdir(fixtureParent, { recursive: true });
    const directory = await mkdtemp(
      join(fixtureParent, "turbo-ts-query-affected-"),
    );
    const git = (...arguments_: ReadonlyArray<string>) =>
      execFilePromise("/usr/bin/git", [
        "-C",
        directory,
        "-c",
        "user.email=synthetic@example.test",
        "-c",
        "user.name=Synthetic Fixture",
        ...arguments_,
      ]);
    try {
      await prepareFixture(directory);
      const rootConfigurationPath = join(directory, "turbo.json");
      const rootConfiguration = JSON.parse(
        await readFile(rootConfigurationPath, "utf8"),
      ) as { tasks: Record<string, Record<string, unknown>> };
      rootConfiguration.tasks.aggregate = {};
      await writeFile(
        rootConfigurationPath,
        `${JSON.stringify(rootConfiguration, undefined, 2)}\n`,
      );
      if (process.platform !== "win32") {
        await mkdir(join(directory, "real/linked"), { recursive: true });
        await writeFile(
          join(directory, "real/linked/package.json"),
          `${JSON.stringify({
            name: "synthetic-linked",
            version: "1.0.0",
            private: true,
            scripts: { build: "node -e \"console.log('linked build')\"" },
          })}\n`,
        );
        await writeFile(join(directory, "real/linked/source.txt"), "base\n");
        await symlink("../real/linked", join(directory, "packages/linked"));
      }
      await git("init", "--quiet");
      await git("add", ".");
      await git("commit", "--quiet", "-m", "base");
      await git("branch", "-M", "main");
      await writeFile(
        join(directory, "packages/library/source.txt"),
        "changed\n",
      );
      await git("add", ".");
      await git("commit", "--quiet", "-m", "changed");
      for (const mode of [[], ["--packages"]] as const) {
        const arguments_ = [
          "query",
          "affected",
          ...mode,
          "--base=HEAD~1",
          "--head=HEAD",
          "--cwd",
          directory,
        ];
        const reference = await executeDifferentialCommand(
          official,
          arguments_,
        );
        const implementation = await executeDifferentialCommand(
          process.execPath,
          [candidate, ...arguments_],
        );
        expect(implementation.stdout).toBe(reference.stdout);
        expect(normalizeOutput(implementation.stderr, ["branding"])).toBe(
          reference.stderr,
        );
      }
      const commandlessAffected = await execFilePromise(process.execPath, [
        candidate,
        "query",
        "affected",
        "--tasks",
        "aggregate",
        "--base=HEAD~1",
        "--head=HEAD",
        "--cwd",
        directory,
      ]);
      expect(JSON.parse(commandlessAffected.stdout)).toMatchObject({
        data: {
          affectedTasks: {
            length: 2,
            items: [
              {
                name: "aggregate",
                fullName: "synthetic-app#aggregate",
              },
              {
                name: "aggregate",
                fullName: "synthetic-library#aggregate",
              },
            ],
          },
        },
      });
      const rootManifestPath = join(directory, "package.json");
      const rootManifest = JSON.parse(
        await readFile(rootManifestPath, "utf8"),
      ) as { dependencies?: Record<string, string> };
      rootManifest.dependencies = {
        ...rootManifest.dependencies,
        "synthetic-library": "workspace:*",
      };
      await writeFile(
        rootManifestPath,
        `${JSON.stringify(rootManifest, undefined, 2)}\n`,
      );
      await git("add", ".");
      await git("commit", "--quiet", "-m", "add root dependency");
      await writeFile(
        join(directory, "packages/library/source.txt"),
        "changed for root dependent\n",
      );
      await git("add", ".");
      await git("commit", "--quiet", "-m", "change root dependency");
      const affectedGraphql = await execFilePromise(process.execPath, [
        candidate,
        "query",
        '{ affectedPackages(base: "HEAD~1", head: "HEAD", filter: { equal: { field: "name", value: "synthetic-app" } }) { length items { name } } rootPackage: affectedPackages(base: "HEAD~1", head: "HEAD", filter: { equal: { field: "name", value: "//" } }) { length items { name } } rootTask: affectedTasks(base: "HEAD~1", head: "HEAD", tasks: ["build"], filter: { equal: { field: "name", value: "//" } }) { length items { fullName } } affectedTasks(base: "HEAD", head: "HEAD", tasks: ["build"]) { length } }',
        "--cwd",
        directory,
      ]);
      expect(JSON.parse(affectedGraphql.stdout)).toEqual({
        data: {
          affectedPackages: {
            length: 1,
            items: [{ name: "synthetic-app" }],
          },
          rootPackage: { length: 1, items: [{ name: "//" }] },
          rootTask: { length: 1, items: [{ fullName: "//#build" }] },
          affectedTasks: { length: 0 },
        },
      });
      await rename(
        join(directory, "packages/library/source.txt"),
        join(directory, "packages/app/moved-source.txt"),
      );
      await git("add", ".");
      await git("commit", "--quiet", "-m", "move source between workspaces");
      const renameAffected = await execFilePromise(
        process.execPath,
        [candidate, "ls", "--affected", "--output=json", "--cwd", directory],
        {
          env: {
            ...differentialEnvironment,
            TURBO_SCM_BASE: "HEAD~1",
            TURBO_SCM_HEAD: "HEAD",
          },
        },
      );
      expect(JSON.parse(renameAffected.stdout)).toMatchObject({
        packages: {
          count: 2,
          items: [
            { name: "synthetic-app", path: "packages/app" },
            { name: "synthetic-library", path: "packages/library" },
          ],
        },
      });
      let requestedRange: string | undefined;
      expect(
        await Effect.runPromise(
          Effect.gen(function* () {
            const environment = yield* EnvironmentService;
            const processService = yield* ProcessService;
            const entries = yield* environment.entries;
            return yield* executeList({
              cwd: directory,
              filters: [],
              output: "json",
              affected: true,
            }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  Layer.succeed(EnvironmentService, {
                    ...environment,
                    platform: Effect.succeed("win32" as const),
                    entries: Effect.succeed({
                      ...entries,
                      turbo_scm_base: "HEAD~1",
                      Turbo_Scm_Head: "HEAD",
                    }),
                  }),
                  Layer.succeed(ProcessService, {
                    ...processService,
                    runBytes: (request) => {
                      if (
                        request.command === "git" &&
                        request.args[0] === "diff"
                      ) {
                        requestedRange = request.args.at(-1);
                      }
                      return processService.runBytes(request);
                    },
                  }),
                ),
              ),
            );
          }).pipe(Effect.provide(nodeFoundationLayer)),
        ),
      ).toBe(0);
      expect(requestedRange).toBe("HEAD~1...HEAD");
      if (process.platform !== "win32") {
        await writeFile(
          join(directory, "real/linked/source.txt"),
          "canonical change\n",
        );
        await git("add", ".");
        await git("commit", "--quiet", "-m", "change canonical workspace");
        const canonicalAffected = await execFilePromise(process.execPath, [
          candidate,
          "query",
          '{ affectedPackages(base: "HEAD~1", head: "HEAD") { items { name } } affectedTasks(base: "HEAD~1", head: "HEAD", tasks: ["build"]) { items { fullName } } }',
          "--cwd",
          directory,
        ]);
        expect(JSON.parse(canonicalAffected.stdout)).toEqual({
          data: {
            affectedPackages: { items: [{ name: "synthetic-linked" }] },
            affectedTasks: {
              items: [{ fullName: "synthetic-linked#build" }],
            },
          },
        });
        const canonicalList = await execFilePromise(
          process.execPath,
          [candidate, "ls", "--affected", "--output=json", "--cwd", directory],
          {
            env: {
              ...differentialEnvironment,
              TURBO_SCM_BASE: "HEAD~1",
              TURBO_SCM_HEAD: "HEAD",
            },
          },
        );
        expect(JSON.parse(canonicalList.stdout)).toMatchObject({
          packages: {
            count: 1,
            items: [{ name: "synthetic-linked", path: "packages/linked" }],
          },
        });
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 60_000);

  it("includes the root package in affected GraphQL collections", async () => {
    const fixtureParent = join(repositoryRoot, ".turbo");
    await mkdir(fixtureParent, { recursive: true });
    const directory = await mkdtemp(
      join(fixtureParent, "turbo-ts-query-root-affected-"),
    );
    const git = (...arguments_: ReadonlyArray<string>) =>
      execFilePromise("/usr/bin/git", [
        "-C",
        directory,
        "-c",
        "user.email=synthetic@example.test",
        "-c",
        "user.name=Synthetic Fixture",
        ...arguments_,
      ]);
    try {
      await writeFile(
        join(directory, "package.json"),
        `${JSON.stringify({
          name: "root-only",
          private: true,
          packageManager: "pnpm@10.34.5",
          scripts: { build: "node -e \"console.log('root build')\"" },
        })}\n`,
      );
      await writeFile(
        join(directory, "turbo.json"),
        `${JSON.stringify({ tasks: { build: {} } })}\n`,
      );
      await writeFile(
        join(directory, "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
      );
      await writeFile(join(directory, "source.txt"), "base\n");
      await git("init", "--quiet");
      await git("add", ".");
      await git("commit", "--quiet", "-m", "base");
      await writeFile(join(directory, "source.txt"), "changed\n");
      await git("add", ".");
      await git("commit", "--quiet", "-m", "changed");
      const affected = await execFilePromise(process.execPath, [
        candidate,
        "query",
        '{ affectedPackages(base: "HEAD~1", head: "HEAD") { items { name path } } affectedTasks(base: "HEAD~1", head: "HEAD", tasks: ["build"]) { items { fullName } } }',
        "--cwd",
        directory,
      ]);
      expect(JSON.parse(affected.stdout)).toEqual({
        data: {
          affectedPackages: { items: [{ name: "//", path: "" }] },
          affectedTasks: { items: [{ fullName: "//#build" }] },
        },
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("propagates dependency-task reasons through affected package chains", async () => {
    const fixtureParent = join(repositoryRoot, ".turbo");
    await mkdir(fixtureParent, { recursive: true });
    const directory = await mkdtemp(
      join(fixtureParent, "turbo-ts-query-reasons-"),
    );
    const git = (...arguments_: ReadonlyArray<string>) =>
      execFilePromise("/usr/bin/git", [
        "-C",
        directory,
        "-c",
        "user.email=synthetic@example.test",
        "-c",
        "user.name=Synthetic Fixture",
        ...arguments_,
      ]);
    try {
      await prepareFixture(directory);
      const libraryManifestPath = join(
        directory,
        "packages/library/package.json",
      );
      const libraryManifest = JSON.parse(
        await readFile(libraryManifestPath, "utf8"),
      ) as { dependencies?: Record<string, string> };
      libraryManifest.dependencies = { "synthetic-core": "workspace:*" };
      await writeFile(
        libraryManifestPath,
        `${JSON.stringify(libraryManifest, undefined, 2)}\n`,
      );
      await mkdir(join(directory, "packages/core"), { recursive: true });
      await writeFile(
        join(directory, "packages/core/package.json"),
        `${JSON.stringify({
          name: "synthetic-core",
          version: "1.0.0",
          private: true,
          scripts: { build: "node -e \"console.log('core build')\"" },
        })}\n`,
      );
      await writeFile(join(directory, "packages/core/source.txt"), "base\n");
      await writeFile(
        join(directory, "pnpm-lock.yaml"),
        workflowLockfile.replace(
          "  packages/library: {}",
          `  packages/library:
    dependencies:
      synthetic-core:
        specifier: workspace:*
        version: link:../core
  packages/core: {}`,
        ),
      );
      await git("init", "--quiet");
      await git("add", ".");
      await git("commit", "--quiet", "-m", "base");
      await writeFile(join(directory, "packages/core/source.txt"), "changed\n");
      await git("add", ".");
      await git("commit", "--quiet", "-m", "changed");

      const shortcut = await execFilePromise(process.execPath, [
        candidate,
        "query",
        "affected",
        "--tasks",
        "build",
        "--base=HEAD~1",
        "--head=HEAD",
        "--cwd",
        directory,
      ]);
      const graphqlResult = await execFilePromise(process.execPath, [
        candidate,
        "query",
        '{ affectedTasks(base: "HEAD~1", head: "HEAD", tasks: ["build"]) { items { fullName reason } } }',
        "--cwd",
        directory,
      ]);
      const shortcutItems = (
        JSON.parse(shortcut.stdout) as {
          data: {
            affectedTasks: {
              items: ReadonlyArray<{
                fullName: string;
                reason: { __typename: string };
              }>;
            };
          };
        }
      ).data.affectedTasks.items;
      const graphqlItems = (
        JSON.parse(graphqlResult.stdout) as {
          data: {
            affectedTasks: {
              items: ReadonlyArray<{
                fullName: string;
                reason: { __typename: string };
              }>;
            };
          };
        }
      ).data.affectedTasks.items;
      const taskReasons = (
        items: ReadonlyArray<{
          fullName: string;
          reason: { __typename: string };
        }>,
      ) =>
        Object.fromEntries(
          items.map((item) => [item.fullName, item.reason.__typename]),
        );
      expect(taskReasons(shortcutItems)).toEqual(taskReasons(graphqlItems));
      expect(taskReasons(shortcutItems)).toEqual({
        "synthetic-app#build": "TaskDependencyTaskChanged",
        "synthetic-core#build": "TaskFileChanged",
        "synthetic-library#build": "TaskDependencyTaskChanged",
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it(evidenceId.repositorySecurity, async () => {
    const source = new TextEncoder().encode(`lockfileVersion: '9.0'
importers:
  .:
    dependencies: {}
  packages/app:
    dependencies:
      kept:
        version: 1.0.0
  packages/unused:
    dependencies:
      removed:
        version: 2.0.0
packages:
  kept@1.0.0: {}
  removed@2.0.0: {}
snapshots:
  kept@1.0.0: {}
  removed@2.0.0: {}
`);
    const output = new TextDecoder().decode(
      pruneLockfile("/repo/pnpm-lock.yaml", source, new Set(["packages/app"])),
    );
    expect(output).toContain("packages/app:");
    expect(output).toContain("kept@1.0.0:");
    expect(output).not.toContain("packages/unused:");
    expect(output).not.toContain("removed@2.0.0:");
    const aliasesAndPeers = new TextDecoder().decode(
      pruneLockfile(
        "/repo/pnpm-lock.yaml",
        new TextEncoder().encode(`lockfileVersion: '9.0'
importers:
  packages/app:
    dependencies:
      alias-name:
        specifier: npm:actual-name@^1
        version: actual-name@1.0.0
      peer-qualified:
        version: 2.0.0(peer-name@3.0.0)
packages:
  actual-name@1.0.0: {}
  peer-qualified@2.0.0: {}
snapshots:
  actual-name@1.0.0: {}
  peer-qualified@2.0.0(peer-name@3.0.0): {}
`),
        new Set(["packages/app"]),
      ),
    );
    expect(aliasesAndPeers).toContain("actual-name@1.0.0");
    expect(aliasesAndPeers).toContain("peer-qualified@2.0.0:");
    expect(aliasesAndPeers).toContain("peer-qualified@2.0.0(peer-name@3.0.0)");
    const npmPruned = JSON.parse(
      new TextDecoder().decode(
        pruneLockfile(
          "/repo/package-lock.json",
          new TextEncoder().encode(
            JSON.stringify({
              lockfileVersion: 2,
              packages: {
                "": {},
                "packages/app": {
                  dependencies: { shared: "1.0.0", unused: "workspace:*" },
                },
                "packages/unused": {
                  dependencies: { "unused-only": "1.0.0" },
                },
                "node_modules/shared": {
                  version: "1.0.0",
                  dependencies: { "shared-leaf": "1.1.0" },
                },
                "node_modules/shared/node_modules/shared-leaf": {
                  version: "1.1.0",
                },
                "node_modules/unused": {
                  link: true,
                  resolved: "packages/unused",
                },
                "node_modules/unused-only": { version: "1.0.0" },
              },
              dependencies: {
                shared: {
                  version: "1.0.0",
                  dependencies: { "shared-leaf": { version: "1.1.0" } },
                },
                unused: {
                  version: "file:packages/unused",
                  dependencies: { "unused-only": { version: "1.0.0" } },
                },
                "unused-only": { version: "1.0.0" },
              },
            }),
          ),
          new Set(["packages/app"]),
        ),
      ),
    ) as {
      packages: Record<string, unknown>;
      dependencies: Record<
        string,
        { readonly dependencies?: Readonly<Record<string, unknown>> }
      >;
    };
    expect(Object.keys(npmPruned.packages)).toEqual([
      "",
      "packages/app",
      "node_modules/shared",
      "node_modules/shared/node_modules/shared-leaf",
    ]);
    expect(Object.keys(npmPruned.dependencies)).toEqual(["shared"]);
    expect(Object.keys(npmPruned.dependencies.shared!.dependencies!)).toEqual([
      "shared-leaf",
    ]);
    const npmDevelopmentSource = new TextEncoder().encode(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": {},
          "packages/app": {
            dependencies: { runtime: "1.0.0" },
            devDependencies: { "build-tool": "2.0.0" },
          },
          "node_modules/runtime": { version: "1.0.0" },
          "node_modules/build-tool": { version: "2.0.0" },
        },
      }),
    );
    const npmDevelopment = JSON.parse(
      new TextDecoder().decode(
        pruneLockfile(
          "/repo/package-lock.json",
          npmDevelopmentSource,
          new Set(["packages/app"]),
        ),
      ),
    ) as { packages: Record<string, Record<string, unknown>> };
    expect(Object.keys(npmDevelopment.packages)).toContain(
      "node_modules/build-tool",
    );
    const npmProduction = JSON.parse(
      new TextDecoder().decode(
        pruneLockfile(
          "/repo/package-lock.json",
          npmDevelopmentSource,
          new Set(["packages/app"]),
          { production: true },
        ),
      ),
    ) as { packages: Record<string, Record<string, unknown>> };
    expect(Object.keys(npmProduction.packages)).toEqual([
      "",
      "packages/app",
      "node_modules/runtime",
    ]);
    expect(
      npmProduction.packages["packages/app"]?.devDependencies,
    ).toBeUndefined();
    const npmV1Source = new TextEncoder().encode(
      JSON.stringify({
        name: "legacy-root",
        lockfileVersion: 1,
        requires: true,
        dependencies: {
          runtime: {
            version: "1.0.0",
            dependencies: {
              transitive: { version: "1.1.0" },
              "nested-dev": { version: "2.0.0", dev: true },
            },
          },
          "build-tool": {
            version: "3.0.0",
            dev: true,
            dependencies: { "build-leaf": { version: "3.1.0", dev: true } },
          },
        },
      }),
    );
    const npmV1Development = JSON.parse(
      new TextDecoder().decode(
        pruneLockfile("/repo/package-lock.json", npmV1Source, new Set()),
      ),
    ) as { dependencies: Record<string, unknown> };
    expect(npmV1Development.dependencies["build-tool"]).toBeDefined();
    const npmV1Production = JSON.parse(
      new TextDecoder().decode(
        pruneLockfile("/repo/package-lock.json", npmV1Source, new Set(), {
          production: true,
        }),
      ),
    ) as {
      dependencies: Record<
        string,
        { readonly dependencies?: Readonly<Record<string, unknown>> }
      >;
    };
    expect(Object.keys(npmV1Production.dependencies)).toEqual(["runtime"]);
    expect(
      Object.keys(npmV1Production.dependencies.runtime!.dependencies!),
    ).toEqual(["transitive"]);
    const developmentSource = new TextEncoder().encode(`lockfileVersion: '9.0'
importers:
  packages/app:
    devDependencies:
      build-tool:
        version: 3.0.0
packages:
  build-tool@3.0.0: {}
snapshots:
  build-tool@3.0.0: {}
`);
    expect(
      new TextDecoder().decode(
        pruneLockfile(
          "/repo/pnpm-lock.yaml",
          developmentSource,
          new Set(["packages/app"]),
        ),
      ),
    ).toContain("build-tool@3.0.0");
    expect(
      new TextDecoder().decode(
        pruneLockfile(
          "/repo/pnpm-lock.yaml",
          developmentSource,
          new Set(["packages/app"]),
          { production: true },
        ),
      ),
    ).not.toContain("build-tool");
    const pruneManifests = [
      {
        dependencies: { a: "^1.0.0" },
        devDependencies: { "build-tool": "^5.0.0" },
      },
    ];
    const yarnClassicSource =
      new TextEncoder().encode(`# synthetic Yarn lockfile

a@^1.0.0:
  version "1.0.0"
  dependencies:
    b "^2.0.0"
b@^2.0.0:
  version "2.0.0"
build-tool@^5.0.0:
  version "5.0.0"
unused@^4.0.0:
  version "4.0.0"
`);
    const yarnClassic = new TextDecoder().decode(
      pruneLockfile("/repo/yarn.lock", yarnClassicSource, new Set(), {
        manifests: pruneManifests,
      }),
    );
    expect(yarnClassic).toContain("a@^1.0.0:");
    expect(yarnClassic).toContain("b@^2.0.0:");
    expect(yarnClassic).toContain("build-tool@^5.0.0:");
    expect(yarnClassic).not.toContain("unused@^4.0.0:");
    expect(
      new TextDecoder().decode(
        pruneLockfile("/repo/yarn.lock", yarnClassicSource, new Set(), {
          manifests: pruneManifests,
          production: true,
        }),
      ),
    ).not.toContain("build-tool@^5.0.0:");
    const yarnBerrySource = new TextEncoder().encode(`__metadata:
  version: 8
"root@workspace:.":
  version: 0.0.0-use.local
  resolution: "root@workspace:."
"app@workspace:packages/app":
  version: 0.0.0-use.local
  resolution: "app@workspace:packages/app"
  dependencies:
    a: "npm:^1.0.0"
  devDependencies:
    build-tool: "npm:^5.0.0"
"unused-workspace@workspace:packages/unused":
  version: 0.0.0-use.local
  resolution: "unused-workspace@workspace:packages/unused"
  dependencies:
    unused: "npm:^4.0.0"
"a@npm:^1.0.0":
  version: 1.0.0
  resolution: "a@npm:1.0.0"
  dependencies:
    b: "npm:^2.0.0"
"b@npm:^2.0.0":
  version: 2.0.0
  resolution: "b@npm:2.0.0"
"build-tool@npm:^5.0.0":
  version: 5.0.0
  resolution: "build-tool@npm:5.0.0"
"unused@npm:^4.0.0":
  version: 4.0.0
  resolution: "unused@npm:4.0.0"
`);
    const yarnBerry = new TextDecoder().decode(
      pruneLockfile(
        "/repo/yarn.lock",
        yarnBerrySource,
        new Set(["packages/app"]),
        { manifests: pruneManifests },
      ),
    );
    expect(yarnBerry).toContain("app@workspace:packages/app");
    expect(yarnBerry).toContain("a@npm:^1.0.0");
    expect(yarnBerry).toContain("b@npm:^2.0.0");
    expect(yarnBerry).not.toContain("unused-workspace");
    expect(yarnBerry).not.toContain("unused@npm:^4.0.0");
    const yarnBerryProduction = new TextDecoder().decode(
      pruneLockfile(
        "/repo/yarn.lock",
        yarnBerrySource,
        new Set(["packages/app"]),
        { manifests: pruneManifests, production: true },
      ),
    );
    expect(yarnBerryProduction).not.toContain("devDependencies");
    expect(yarnBerryProduction).not.toContain("build-tool@npm:^5.0.0");
    const bunSource = new TextEncoder().encode(
      JSON.stringify({
        lockfileVersion: 1,
        workspaces: {
          "": { name: "root" },
          "packages/app": {
            name: "app",
            dependencies: { a: "a@1.0.0" },
            devDependencies: { "build-tool": "build-tool@5.0.0" },
          },
          "packages/unused": {
            name: "unused-workspace",
            dependencies: { unused: "unused@4.0.0" },
          },
        },
        packages: {
          root: ["root@workspace:.", ""],
          app: ["app@workspace:packages/app", ""],
          "unused-workspace": [
            "unused-workspace@workspace:packages/unused",
            "",
          ],
          "a@1.0.0": ["a@1.0.0", "", { dependencies: { b: "b@2.0.0" } }, ""],
          "b@2.0.0": ["b@2.0.0", "", {}, ""],
          "build-tool@5.0.0": ["build-tool@5.0.0", "", {}, ""],
          "unused@4.0.0": ["unused@4.0.0", "", {}, ""],
        },
      }),
    );
    const bunPruned = JSON.parse(
      new TextDecoder().decode(
        pruneLockfile("/repo/bun.lock", bunSource, new Set(["packages/app"]), {
          manifests: pruneManifests,
        }),
      ),
    ) as {
      readonly workspaces: Readonly<Record<string, unknown>>;
      readonly packages: Readonly<Record<string, unknown>>;
    };
    expect(Object.keys(bunPruned.workspaces)).toEqual(["", "packages/app"]);
    expect(Object.keys(bunPruned.packages)).toEqual([
      "root",
      "app",
      "a@1.0.0",
      "b@2.0.0",
      "build-tool@5.0.0",
    ]);
    const bunProduction = JSON.parse(
      new TextDecoder().decode(
        pruneLockfile("/repo/bun.lock", bunSource, new Set(["packages/app"]), {
          manifests: pruneManifests,
          production: true,
        }),
      ),
    ) as {
      readonly workspaces: Readonly<
        Record<string, { readonly devDependencies?: unknown }>
      >;
      readonly packages: Readonly<Record<string, unknown>>;
    };
    expect(
      bunProduction.workspaces["packages/app"]?.devDependencies,
    ).toBeUndefined();
    expect(bunProduction.packages["build-tool@5.0.0"]).toBeUndefined();
    expect(() =>
      pruneLockfile(
        "/repo/pnpm-lock.yaml",
        new TextEncoder().encode("lockfileVersion: 9\u0000"),
        new Set(),
      ),
    ).toThrow(/NUL/);
    let seed = 0x2_10_12;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    for (let index = 0; index < 64; index += 1) {
      const kept = `kept-${index}-${next().toString(16)}`;
      const removed = `removed-${index}-${next().toString(16)}`;
      const generated = new TextEncoder().encode(`lockfileVersion: '9.0'
importers:
  packages/app:
    dependencies:
      ${kept}:
        version: 1.0.0
  packages/unused:
    dependencies:
      ${removed}:
        version: 2.0.0
packages:
  ${kept}@1.0.0: {}
  ${removed}@2.0.0: {}
snapshots:
  ${kept}@1.0.0: {}
  ${removed}@2.0.0: {}
`);
      const pruned = new TextDecoder().decode(
        pruneLockfile(
          "/repo/pnpm-lock.yaml",
          generated,
          new Set(["packages/app"]),
        ),
      );
      expect(pruned).toContain(`${kept}@1.0.0`);
      expect(pruned).not.toContain(removed);
    }
    const schemaResult = await graphql({
      schema: repositoryQuerySchema,
      source: "{ __schema { queryType { name } } }",
    });
    expect(schemaResult.errors).toBeUndefined();
    expect(schemaResult.data).toEqual({
      __schema: { queryType: { name: "RepositoryQuery" } },
    });
    expect(await readFile(join(packageRoot, "package.json"), "utf8")).toContain(
      '"graphql": "16.14.0"',
    );
  });
});
