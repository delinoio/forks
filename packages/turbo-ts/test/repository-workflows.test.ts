import { execFile, spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  connect as connectHttp2,
  constants as http2Constants,
} from "node:http2";
import { createConnection as createNetConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "@rstest/core";
import { graphql } from "graphql";
import { evidenceId } from "../src/compatibility/ledger.js";
import { normalizeOutput } from "../src/compatibility/normalizers.js";
import { pruneLockfile } from "../src/repository/lockfiles.js";
import {
  renderRunTui,
  renderTimestampedStreamText,
  resolveRunUiMode,
} from "../src/run/engine.js";
import { parseRunArguments } from "../src/run/options.js";
import { parseDaemonArguments } from "../src/workflow/daemon.js";
import { isWindowsSubsystemForLinux } from "../src/workflow/misc.js";
import { parsePruneArguments } from "../src/workflow/prune.js";
import { repositoryQuerySchema } from "../src/workflow/query.js";
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

const sendDaemonRequest = async (
  socket: string,
  method: string,
  payload: Uint8Array = Buffer.alloc(0),
): Promise<Buffer> =>
  new Promise<Buffer>((resolve, reject) => {
    const session = connectHttp2("http://localhost", {
      createConnection: () => createNetConnection(socket),
    });
    const chunks: Array<Buffer> = [];
    const stream = session.request({
      [http2Constants.HTTP2_HEADER_METHOD]: "POST",
      [http2Constants.HTTP2_HEADER_PATH]: `/turbodprotocol.Turbod/${method}`,
      [http2Constants.HTTP2_HEADER_CONTENT_TYPE]: "application/grpc",
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
      resolve(framed.length >= 5 ? framed.subarray(5) : framed);
    });
    const header = Buffer.alloc(5);
    header.writeUInt32BE(payload.length, 1);
    stream.end(Buffer.concat([header, payload]));
  });

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
      json: true,
    });
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

    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-workflow-"));
    try {
      await prepareFixture(directory);
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
        return (
          JSON.parse(result.stdout) as {
            tasks: ReadonlyArray<{ hash: string }>;
          }
        ).tasks.map((task) => task.hash);
      };
      const firstGlobalHashes = await hashWithGlobalInput();
      await writeFile(join(directory, "global-input.txt"), "two\n");
      expect(await hashWithGlobalInput()).not.toEqual(firstGlobalHashes);

      const structured = await execFilePromise(process.execPath, [
        candidate,
        "run",
        "build",
        "--no-cache",
        "--summarize",
        "--json",
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
        readonly type: string;
        readonly tasks: ReadonlyArray<{
          readonly taskId: string;
          readonly execution: {
            readonly startTime: number;
            readonly endTime: number;
          };
        }>;
      };
      expect(runSummary.type).toBe("run_summary");
      const logRecords = (await readFile(join(directory, "run.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(logRecords.map((record) => record.type)).toContain("task_event");
      expect(logRecords.at(-1)?.type).toBe("run_summary");
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
      expect(await readdir(join(directory, ".turbo/runs"))).toHaveLength(1);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 45_000);

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
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-watch-"));
    await prepareFixture(directory);
    const appManifestPath = join(directory, "packages/app/package.json");
    const appManifest = JSON.parse(await readFile(appManifestPath, "utf8")) as {
      scripts: Record<string, string>;
    };
    appManifest.scripts.build =
      "node -e \"const fs=require('node:fs');const output=JSON.parse(fs.readFileSync('turbo.json','utf8')).tasks.build.outputs[0].split('/')[0];fs.mkdirSync(output,{recursive:true});fs.writeFileSync(output+'/generated.txt','generated');console.log('app build')\"";
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
      await rm(directory, { force: true, recursive: true });
    }
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 40_000);

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
snapshots:
  external-package@1.2.3: {}
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
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it("rejects unsafe prune output aliases and escaping package symlinks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-prune-safety-"));
    try {
      await prepareFixture(directory);
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
      const affectedGraphql = await execFilePromise(process.execPath, [
        candidate,
        "query",
        '{ affectedPackages(base: "HEAD~1", head: "HEAD", filter: { equal: { field: "name", value: "synthetic-app" } }) { length items { name } } affectedTasks(base: "HEAD", head: "HEAD", tasks: ["build"]) { length } }',
        "--cwd",
        directory,
      ]);
      expect(JSON.parse(affectedGraphql.stdout)).toEqual({
        data: {
          affectedPackages: {
            length: 1,
            items: [{ name: "synthetic-app" }],
          },
          affectedTasks: { length: 0 },
        },
      });
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
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 60_000);

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
        version: npm:actual-name@1.0.0
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
              lockfileVersion: 3,
              packages: {
                "": {},
                "packages/app": {
                  dependencies: { shared: "1.0.0", unused: "workspace:*" },
                },
                "packages/unused": {
                  dependencies: { "unused-only": "1.0.0" },
                },
                "node_modules/shared": { version: "1.0.0" },
                "node_modules/unused": {
                  link: true,
                  resolved: "packages/unused",
                },
                "node_modules/unused-only": { version: "1.0.0" },
              },
            }),
          ),
          new Set(["packages/app"]),
        ),
      ),
    ) as { packages: Record<string, unknown> };
    expect(Object.keys(npmPruned.packages)).toEqual([
      "",
      "packages/app",
      "node_modules/shared",
    ]);
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
