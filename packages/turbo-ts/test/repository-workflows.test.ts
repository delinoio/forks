import { execFile, spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
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
import { parseRunArguments } from "../src/run/options.js";
import { parseDaemonArguments } from "../src/workflow/daemon.js";
import { parsePruneArguments } from "../src/workflow/prune.js";
import { repositoryQuerySchema } from "../src/workflow/query.js";

const execFilePromise = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = join(packageRoot, "test/fixtures/basic-workspace");
const candidate = join(packageRoot, "dist/bin/turbo-ts.js");
const official = join(repositoryRoot, "node_modules/.bin/turbo");
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
      json: true,
    });
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
      const listed = await execFilePromise(process.execPath, [
        candidate,
        "--cwd",
        directory,
        "ls",
        "--output=json",
      ]);
      const officialList = await execFilePromise(official, [
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
      const queried = await execFilePromise(process.execPath, [
        candidate,
        "query",
        "{ packages { length } version }",
        "--cwd",
        directory,
      ]);
      const officialQuery = await execFilePromise(official, [
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
      const queriedFile = await execFilePromise(process.execPath, [
        candidate,
        "query",
        fileQuery,
        "--cwd",
        directory,
      ]);
      const officialFile = await execFilePromise(official, [
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
      expect(structured.stdout).toContain('"type":"run_summary"');
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
        readonly pid_file: string;
        readonly sock_file: string;
      };
      expect(officialState).toMatchObject({
        pid_file: expect.stringContaining("turbod.pid"),
        sock_file: expect.stringContaining("turbod.sock"),
      });
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
      await runCandidate("daemon", "stop").catch(() => undefined);
      await runOfficial("daemon", "stop").catch(() => undefined);
      await rm(directory, { force: true, recursive: true });
    }
  }, 60_000);

  it("coalesces file storms, restarts watch runs, and closes on interruption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-watch-"));
    await prepareFixture(directory);
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
    await prepareFixture(directory);
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
        /GraphiQL IDE: http:\/\/localhost:\d+/.test(stdout),
      );
      const port = /GraphiQL IDE: http:\/\/localhost:(\d+)/.exec(stdout)?.[1];
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

      const query = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ version packages { length } }" }),
      });
      expect(query.status).toBe(200);
      expect(await query.json()).toEqual({
        data: { version: "2.10.12", packages: { length: 3 } },
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
    }
  }, 30_000);

  it("matches the reference prune output and generated tree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-prune-"));
    const output = join(directory, "result");
    try {
      await prepareFixture(directory);
      const reference = await execFilePromise(official, [
        "--cwd",
        directory,
        "prune",
        "synthetic-app",
        "--out-dir=result",
      ]);
      const referenceTree = await readTextTree(output);
      await rm(output, { force: true, recursive: true });
      const implementation = await execFilePromise(process.execPath, [
        candidate,
        "--cwd",
        directory,
        "prune",
        "synthetic-app",
        "--out-dir=result",
      ]);
      expect(implementation.stdout).toBe(reference.stdout);
      expect(normalizeOutput(implementation.stderr, ["branding"])).toBe(
        reference.stderr,
      );
      expect(await readTextTree(output)).toEqual(referenceTree);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

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
        const reference = await execFilePromise(official, arguments_);
        const implementation = await execFilePromise(process.execPath, [
          candidate,
          ...arguments_,
        ]);
        expect(implementation.stdout).toBe(reference.stdout);
        expect(normalizeOutput(implementation.stderr, ["branding"])).toBe(
          reference.stderr,
        );
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
