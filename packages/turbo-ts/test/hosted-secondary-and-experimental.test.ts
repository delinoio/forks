import { execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import {
  createServer as createHttp2Server,
  constants as http2Constants,
} from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "@rstest/core";
import { Effect, Layer } from "effect";
import {
  headRemoteCache,
  type RemoteCacheOptions,
  recordRemoteCacheEvent,
  verifyRemoteCacheStatus,
} from "../src/cache/remote-cache.js";
import { parseCommonArguments } from "../src/cli/common-options.js";
import { evidenceId } from "../src/compatibility/ledger.js";
import { BoundaryError, ProcessExecutionError } from "../src/effect/errors.js";
import { nodeFoundationLayer } from "../src/effect/node-layer.js";
import {
  deterministicRetryLayer,
  EnvironmentService,
  type HttpRequest,
  type HttpResponse,
  HttpService,
  ProcessService,
} from "../src/effect/services.js";
import { redactRecord, redactText } from "../src/logging/redaction.js";
import { parseLockfile } from "../src/repository/lockfiles.js";
import {
  resolvePackageManagerRuntimeIdentity,
  resolveUvRuntimeIdentity,
} from "../src/repository/model.js";
import { parseRunArguments } from "../src/run/options.js";
import {
  encodeOtlpMetrics,
  exportRunMetrics,
  makeOtlpJsonMetrics,
} from "../src/telemetry/observability.js";
import { parseGenerateArguments } from "../src/workflow/generate.js";
import { parseHostedArguments } from "../src/workflow/hosted.js";
import { selectCurrentPackage } from "../src/workflow/secondary.js";

const execFilePromise = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const candidate = join(packageRoot, "dist/bin/turbo-ts.js");
const official = join(repositoryRoot, "node_modules/.bin/turbo");
// Keep Gate 4 command assertions independent of ambient CI and test-runner
// color behavior. Remove this isolation when those environments gain coverage.
const ambientOutputEnvironmentNames = new Set([
  "CI",
  "FORCE_COLOR",
  "GITHUB_ACTIONS",
  "NO_COLOR",
  "TURBO_TELEMETRY_DISABLED",
]);
const commandEnvironment: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !ambientOutputEnvironmentNames.has(name.toUpperCase()),
    ),
  ),
  NO_COLOR: "1",
  TURBO_TELEMETRY_DISABLED: "1",
};

interface CommandResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

const runCommand = async (
  command: string,
  arguments_: ReadonlyArray<string>,
  cwd: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<CommandResult> => {
  try {
    const result = await execFilePromise(command, [...arguments_], {
      cwd,
      env: {
        ...commandEnvironment,
        ...environment,
      },
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (cause) {
    const failure = cause as {
      readonly code?: number;
      readonly stderr?: string;
      readonly stdout?: string;
    };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
};

const runCandidate = (
  arguments_: ReadonlyArray<string>,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): Promise<CommandResult> =>
  runCommand(process.execPath, [candidate, ...arguments_], cwd, environment);

interface CapturedRequest {
  readonly body: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly method: string;
  readonly path: string;
}

const requestBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.once("end", () => resolve(body));
    request.once("error", reject);
  });

const withServer = async <A>(
  handler: (
    request: IncomingMessage,
    body: string,
  ) =>
    | readonly [number, Readonly<Record<string, string>>, string]
    | Promise<readonly [number, Readonly<Record<string, string>>, string]>,
  use: (baseUrl: string, requests: Array<CapturedRequest>) => Promise<A>,
): Promise<A> => {
  const requests: Array<CapturedRequest> = [];
  const server = createServer(async (request, response) => {
    const body = await requestBody(request);
    requests.push({
      body,
      headers: request.headers,
      method: request.method ?? "GET",
      path: request.url ?? "/",
    });
    const [status, headers, responseBody] = await handler(request, body);
    response.writeHead(status, headers);
    response.end(responseBody);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("mock server did not expose a TCP address");
  }
  try {
    return await use(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

const prepareRepository = async (root: string): Promise<void> => {
  await mkdir(join(root, "packages/app"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "synthetic-hosted-root",
      private: true,
      packageManager: "pnpm@9.15.9",
    }),
  );
  await writeFile(
    join(root, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\n",
  );
  await writeFile(
    join(root, "turbo.json"),
    JSON.stringify({ tasks: { build: {} } }),
  );
  await writeFile(
    join(root, "packages/app/package.json"),
    JSON.stringify({
      name: "synthetic-app",
      private: true,
      scripts: { build: 'node -e ""' },
    }),
  );
};

const exerciseDevtools = async (root: string): Promise<void> => {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  if (address === null || typeof address === "string") {
    reservation.close();
    throw new Error("port reservation did not expose an address");
  }
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const child = spawn(
    process.execPath,
    [candidate, "devtools", `--port=${port}`, "--no-open", `--cwd=${root}`],
    {
      cwd: root,
      env: { ...process.env, NO_COLOR: "1", TURBO_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("devtools start timed out")),
      10_000,
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`devtools exited early: ${code}`)),
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      const match = /turbo-ts devtools: (http:\/\/[^\s]+)/.exec(output);
      if (match?.[1] !== undefined) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
  });
  try {
    const authorized = new URL(url);
    authorized.pathname = "/graph";
    const graphResponse = await fetch(authorized);
    expect(graphResponse.status).toBe(200);
    expect(await graphResponse.json()).toMatchObject({
      root: "//",
    });
    const forbidden = new URL(authorized);
    forbidden.search = "";
    expect((await fetch(forbidden)).status).toBe(403);
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
      child.once("close", () => {
        clearTimeout(force);
        resolve();
      });
    });
  }
};

describe("hosted compatibility", () => {
  it(evidenceId.hostedCompatibility, async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-hosted-"));
    const root = join(directory, "repository");
    const configurationHome = join(directory, "configuration");
    const token = "synthetic-secret-token";
    await prepareRepository(root);
    await rm(join(root, "turbo.json"));
    const rootConfigurationPath = join(root, "turbo.jsonc");
    const rootConfiguration =
      '{\n  // retained login comment\n  "tasks": { "build": {} }\n}\n';
    await writeFile(rootConfigurationPath, rootConfiguration);
    try {
      await withServer(
        (request) =>
          request.url === "/v2/user"
            ? [
                200,
                { "content-type": "application/json" },
                '{"user":{"id":"user_synthetic","username":"synthetic-user","name":"Synthetic User"}}',
              ]
            : request.url === "/v2/teams?limit=100"
              ? [
                  200,
                  { "content-type": "application/json" },
                  '{"teams":[{"id":"team_synthetic","slug":"synthetic","name":"Synthetic Team"},{"id":"team_disabled","slug":"disabled","name":"Disabled Team"}]}',
                ]
              : request.url?.startsWith("/v8/artifacts/status") === true
                ? [
                    200,
                    { "content-type": "application/json" },
                    request.url.includes("teamId=team_disabled") ||
                    request.url.includes("slug=disabled")
                      ? '{"status":"disabled"}'
                      : '{"status":"enabled"}',
                  ]
                : request.url === "/v3/user/tokens/current"
                  ? [200, { "content-type": "application/json" }, "{}"]
                  : [404, {}, "not found"],
        async (baseUrl, requests) => {
          const environment = { XDG_CONFIG_HOME: configurationHome };
          const login = await runCandidate(
            [
              "login",
              "--manual",
              `--token=${token}`,
              "--team=synthetic-team",
              `--api=${baseUrl}`,
              `--cwd=${root}`,
            ],
            root,
            environment,
          );
          expect(login.code).toBe(0);
          expect(`${login.stdout}${login.stderr}`).not.toContain(token);
          expect(await readFile(rootConfigurationPath, "utf8")).toBe(
            rootConfiguration,
          );
          const userPath = join(configurationHome, "turborepo/config.json");
          expect(JSON.parse(await readFile(userPath, "utf8"))).toEqual({
            token,
          });
          if (process.platform !== "win32") {
            expect((await stat(userPath)).mode & 0o777).toBe(0o600);
          }

          // The official client must be able to retain and update the same
          // independently-created shared credential document.
          const officialLogout = await runCommand(
            official,
            ["logout", "--invalidate=false", `--cwd=${root}`],
            root,
            environment,
          );
          expect(officialLogout.code).toBe(0);
          expect(JSON.parse(await readFile(userPath, "utf8"))).toEqual({});

          expect(
            (
              await runCandidate(
                [
                  "login",
                  "--manual",
                  `--token=${token}`,
                  "--team=synthetic-team",
                  `--api=${baseUrl}`,
                  `--cwd=${root}`,
                ],
                root,
                environment,
              )
            ).code,
          ).toBe(0);
          const link = await runCandidate(
            [
              "link",
              "--scope=synthetic",
              "--yes",
              `--api=${baseUrl}`,
              `--cwd=${root}`,
            ],
            root,
            environment,
          );
          expect(link.code).toBe(0);
          expect(`${link.stdout}${link.stderr}`).not.toContain(token);
          expect(
            JSON.parse(
              await readFile(join(root, ".turbo/config.json"), "utf8"),
            ),
          ).toEqual({ teamId: "team_synthetic" });
          expect(await readFile(join(root, ".gitignore"), "utf8")).toContain(
            ".turbo",
          );

          expect(
            (await runCandidate(["unlink", `--cwd=${root}`], root, environment))
              .code,
          ).toBe(0);
          expect(
            JSON.parse(
              await readFile(join(root, ".turbo/config.json"), "utf8"),
            ),
          ).toEqual({});
          const personalLink = await runCandidate(
            [
              "link",
              "--scope=synthetic-user",
              "--yes",
              `--api=${baseUrl}`,
              `--cwd=${root}`,
            ],
            root,
            environment,
          );
          expect(personalLink.code).toBe(0);
          expect(
            JSON.parse(
              await readFile(join(root, ".turbo/config.json"), "utf8"),
            ),
          ).toEqual({ teamId: "user_synthetic" });
          const disabledLink = await runCandidate(
            [
              "link",
              "--scope=disabled",
              "--yes",
              `--api=${baseUrl}`,
              `--cwd=${root}`,
            ],
            root,
            environment,
          );
          expect(disabledLink.code).toBe(1);
          expect(disabledLink.stderr).toContain(
            "remote caching status response is invalid",
          );
          expect(
            JSON.parse(
              await readFile(join(root, ".turbo/config.json"), "utf8"),
            ),
          ).toEqual({ teamId: "user_synthetic" });
          const disabledLogin = await runCandidate(
            [
              "login",
              "--manual",
              `--token=${token}`,
              "--team=disabled",
              `--api=${baseUrl}`,
              `--cwd=${root}`,
            ],
            root,
            environment,
          );
          expect(disabledLogin.code).toBe(1);
          expect(JSON.parse(await readFile(userPath, "utf8"))).toEqual({
            token,
          });
          expect(await readFile(rootConfigurationPath, "utf8")).toBe(
            rootConfiguration,
          );
          const logout = await runCandidate(
            ["logout", `--api=${baseUrl}`, `--cwd=${root}`],
            root,
            environment,
          );
          expect(logout.code).toBe(0);
          expect(`${logout.stdout}${logout.stderr}`).not.toContain(token);
          expect(JSON.parse(await readFile(userPath, "utf8"))).toEqual({});

          expect(
            requests.some(
              (request) =>
                request.path === "/v8/artifacts/status?slug=synthetic-team",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.path ===
                "/v8/artifacts/status?teamId=user_synthetic&slug=synthetic-user",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.path ===
                "/v8/artifacts/status?teamId=team_synthetic&slug=synthetic",
            ),
          ).toBe(true);
          expect(requests.some((request) => request.path === "/v2/user")).toBe(
            true,
          );
          expect(
            requests.some((request) => request.path === "/v2/teams?limit=100"),
          ).toBe(true);
          expect(requests.at(-1)?.method).toBe("DELETE");
          for (const request of requests) {
            expect(request.headers.authorization).toBe(`Bearer ${token}`);
            expect(request.headers["user-agent"]).toBe("turbo-ts/0.1.0");
          }
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it(evidenceId.hostedSecurity, async () => {
    const secret = "synthetic-sensitive-value";
    expect(
      redactText(
        `authorization: Bearer ${secret}; endpoint=https://user:${secret}@cache.invalid`,
        [secret],
      ),
    ).not.toContain(secret);
    expect(
      redactRecord(
        {
          authorization: `Bearer ${secret}`,
          nested: {
            cacheToken: secret,
            safe: "visible",
            values: [{ password: secret }],
          },
          signature: secret,
        },
        [secret],
      ),
    ).toEqual({
      authorization: "[REDACTED]",
      nested: {
        cacheToken: "[REDACTED]",
        safe: "visible",
        values: [{ password: "[REDACTED]" }],
      },
      signature: "[REDACTED]",
    });
    expect(redactText("Bearer synthetic:secret? token=visible-secret")).toBe(
      "Bearer [REDACTED] token=[REDACTED]",
    );

    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-permission-"));
    const root = join(directory, "repository");
    const configurationHome = join(directory, "configuration");
    await prepareRepository(root);
    const credentialDirectory = join(configurationHome, "turborepo");
    await mkdir(credentialDirectory, { recursive: true });
    const credentialPath = join(credentialDirectory, "config.json");
    await writeFile(credentialPath, JSON.stringify({ token: secret }));
    if (process.platform !== "win32") await chmod(credentialPath, 0o644);
    try {
      const result = await runCandidate(
        ["logout", "--invalidate=false", `--cwd=${root}`],
        root,
        { XDG_CONFIG_HOME: configurationHome },
      );
      if (process.platform !== "win32") expect(result.code).toBe(1);
      expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ignores relative XDG configuration paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-xdg-"));
    const root = join(directory, "repository");
    const fallbackHome = join(directory, "home");
    const fallbackAppData = join(fallbackHome, "AppData", "Roaming");
    await prepareRepository(root);
    try {
      await withServer(
        () => [
          200,
          { "content-type": "application/json" },
          '{"status":"enabled"}',
        ],
        async (baseUrl) => {
          const result = await runCandidate(
            [
              "login",
              "--manual",
              "--token=synthetic-token",
              `--api=${baseUrl}`,
            ],
            root,
            {
              APPDATA: fallbackAppData,
              HOME: fallbackHome,
              XDG_CONFIG_HOME: ".relative-config",
            },
          );
          expect(result.code, result.stderr).toBe(0);
          const configurationRoot =
            process.platform === "darwin"
              ? join(fallbackHome, "Library", "Application Support")
              : process.platform === "win32"
                ? fallbackAppData
                : join(fallbackHome, ".config");
          expect(
            JSON.parse(
              await readFile(
                join(configurationRoot, "turborepo/config.json"),
                "utf8",
              ),
            ),
          ).toEqual({ token: "synthetic-token" });
          await expect(
            readFile(join(root, ".relative-config/turborepo/config.json")),
          ).rejects.toThrow();
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not load credentials or probe hosted status for local-only runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-local-only-"));
    const root = join(directory, "repository");
    const configurationHome = join(directory, "configuration");
    const userPath = join(configurationHome, "turborepo/config.json");
    const projectPath = join(root, ".turbo/config.json");
    await prepareRepository(root);
    await mkdir(join(configurationHome, "turborepo"), { recursive: true });
    await mkdir(join(root, ".turbo"), { recursive: true });
    await writeFile(userPath, "invalid user credentials");
    await writeFile(projectPath, "invalid project credentials");
    if (process.platform !== "win32") await chmod(userPath, 0o600);
    try {
      const disabled = await runCandidate(
        [
          "run",
          "build",
          "--filter=synthetic-app",
          "--no-cache",
          `--cwd=${root}`,
        ],
        root,
        { XDG_CONFIG_HOME: configurationHome },
      );
      expect(disabled.code, disabled.stderr).toBe(0);

      await withServer(
        () => [
          200,
          { "content-type": "application/json" },
          '{"status":"enabled"}',
        ],
        async (baseUrl, requests) => {
          await writeFile(
            userPath,
            JSON.stringify({ token: "synthetic-token" }),
          );
          if (process.platform !== "win32") await chmod(userPath, 0o600);
          await writeFile(projectPath, JSON.stringify({ apiUrl: baseUrl }));
          const localOnly = await runCandidate(
            [
              "run",
              "build",
              "--filter=synthetic-app",
              "--cache=local:rw",
              `--cwd=${root}`,
            ],
            root,
            { XDG_CONFIG_HOME: configurationHome },
          );
          expect(localOnly.code, localOnly.stderr).toBe(0);
          expect(requests).toHaveLength(0);
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("secondary command and parser compatibility", () => {
  it(evidenceId.secondaryCompatibility, async () => {
    const common = parseCommonArguments([
      "--skip-infer",
      "--no-update-notifier",
      "--api=https://cache.invalid/api",
      "--login=https://login.invalid",
      "--color",
      "--no-color",
      "--cwd=/synthetic",
      "--heap=heap.heapsnapshot",
      "--preflight",
      "--remote-cache-timeout=1.5",
      "--team=synthetic",
      "--token=synthetic-token",
      "--trace=trace.json",
      "--ui=tui",
      "--verbosity=3",
      "--experimental-otel-enabled=false",
      "--experimental-otel-protocol=http-json",
      "--experimental-otel-endpoint=http://127.0.0.1:4318",
      "--experimental-otel-timeout-ms=50",
      "--experimental-otel-interval-ms=25",
      "--experimental-otel-header=x-synthetic=value",
      "--experimental-otel-resource=deployment.environment=test",
      "--experimental-otel-metrics-run-summary=true",
      "--experimental-otel-metrics-task-details=false",
      "--experimental-otel-use-remote-cache-token=true",
      "--dangerously-disable-package-manager-check",
      "--root-turbo-json=turbo.alternate.json",
      "build",
    ]);
    expect(common.remaining).toEqual(["build"]);
    expect(common.options).toMatchObject({
      apiUrl: "https://cache.invalid/api",
      color: false,
      cwd: "/synthetic",
      dangerouslyDisablePackageManagerCheck: true,
      heap: "heap.heapsnapshot",
      loginUrl: "https://login.invalid",
      noUpdateNotifier: true,
      preflight: true,
      remoteCacheTimeoutSeconds: 1.5,
      rootTurboJson: "turbo.alternate.json",
      skipInfer: true,
      team: "synthetic",
      token: "synthetic-token",
      trace: "trace.json",
      ui: "tui",
      verbosity: 3,
    });
    expect(common.options.openTelemetry).toMatchObject({
      enabled: false,
      headers: [["x-synthetic", "value"]],
      intervalMilliseconds: 25,
      metricsRunSummary: true,
      metricsTaskDetails: false,
      protocol: "http-json",
      resources: [["deployment.environment", "test"]],
      timeoutMilliseconds: 50,
      useRemoteCacheToken: true,
    });
    expect(
      parseRunArguments([
        "run",
        "build",
        "--cache-workers=4",
        "--daemon",
        "--no-daemon",
        "--dry=json",
      ]),
    ).toMatchObject({
      cacheWorkers: 4,
      daemonPreference: false,
      dryRun: "json",
      tasks: ["build"],
    });
    expect(
      parseHostedArguments("logout", ["--invalidate", "false"]),
    ).toMatchObject({ invalidate: false });
    expect(
      parseGenerateArguments([
        "workspace",
        "--name=generated-app",
        "--empty",
        "--destination=apps/generated-app",
        "--type=app",
        "--show-all-dependencies",
      ]),
    ).toMatchObject({
      destination: "apps/generated-app",
      empty: true,
      name: "generated-app",
      showAllDependencies: true,
      type: "app",
      workspace: true,
    });
    expect(
      selectCurrentPackage(
        [
          { directory: "C:/synthetic/repository" },
          { directory: "C:/synthetic/repository/packages/app" },
        ],
        "c:\\SYNTHETIC\\repository\\packages\\app\\src",
        true,
      ),
    ).toEqual({ directory: "C:/synthetic/repository/packages/app" });

    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-secondary-"));
    const root = join(directory, "repository");
    await prepareRepository(root);
    await writeFile(
      join(root, "microfrontends.json"),
      JSON.stringify({
        applications: {
          "synthetic-app": { development: { local: { port: 4001 } } },
        },
      }),
    );
    await writeFile(
      join(root, "packages/app/microfrontends.json"),
      JSON.stringify({
        applications: {
          "synthetic-app": { development: { local: { port: 4123 } } },
        },
      }),
    );
    try {
      const binary = await runCandidate(["bin"], root);
      expect(binary.code).toBe(0);
      expect(binary.stdout.trim()).toBe(candidate);
      expect((await runCandidate(["bin", "extra"], root)).code).toBe(1);

      const completion = await runCandidate(
        ["completion", "--api=https://cache.invalid", "bash"],
        root,
      );
      expect(completion.code).toBe(0);
      expect(completion.stdout).toContain("complete -W");

      const scan = await runCandidate(["scan"], root);
      expect(scan.code).toBe(1);
      expect(scan.stderr).toContain("DEPRECATED");
      expect((await runCandidate(["scan", "extra"], root)).stderr).toContain(
        "unexpected argument: extra",
      );

      const generated = await runCandidate(
        [
          "generate",
          "workspace",
          "--name=generated-library",
          "--empty",
          "--destination=packages/generated-library",
          `--root=${root}`,
        ],
        root,
      );
      expect(generated.code).toBe(0);
      expect(
        JSON.parse(
          await readFile(
            join(root, "packages/generated-library/package.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ name: "generated-library", private: true });

      const recursiveCopy = await runCandidate(
        [
          "generate",
          "workspace",
          "--name=recursive-copy",
          "--copy=.",
          "--destination=packages/recursive-copy",
          `--root=${root}`,
        ],
        root,
      );
      expect(recursiveCopy.code).toBe(1);
      expect(recursiveCopy.stderr).toContain(
        "workspace template must not contain its destination",
      );
      await expect(
        access(join(root, "packages/recursive-copy")),
      ).rejects.toThrow();

      if (process.platform !== "win32") {
        const outside = join(directory, "outside");
        const linkedDestination = join(root, "generated");
        const generatorDirectory = join(root, "turbo/generators");
        await mkdir(outside, { recursive: true });
        await mkdir(generatorDirectory, { recursive: true });
        await symlink(outside, linkedDestination, "dir");
        await writeFile(
          join(generatorDirectory, "config.mjs"),
          'export default (api) => api.setGenerator("unsafe", { actions: [{ type: "add", path: "generated/outside.txt", template: "unsafe" }] });\n',
        );
        const unsafe = await runCandidate(
          ["generate", "unsafe", `--root=${root}`],
          root,
        );
        expect(unsafe.code).toBe(1);
        expect(unsafe.stderr).toContain(
          "generator action escapes the repository",
        );
        await expect(access(join(outside, "outside.txt"))).rejects.toThrow();
      }

      const mfe = await runCandidate(
        ["get-mfe-port", `--cwd=${root}`],
        join(root, "packages/app"),
      );
      expect(mfe).toMatchObject({ code: 0, stdout: "4123\n" });
      await writeFile(
        join(root, "packages/app/microfrontends.json"),
        JSON.stringify({
          applications: {
            "synthetic-app": { development: { local: {} } },
          },
        }),
      );
      const generatedMfe = await runCandidate(
        ["get-mfe-port", `--cwd=${root}`],
        join(root, "packages/app"),
      );
      expect(generatedMfe).toMatchObject({ code: 0, stdout: "6697\n" });
      await rm(join(root, "packages/app/microfrontends.json"));
      const inheritedMfe = await runCandidate(
        ["get-mfe-port", `--cwd=${root}`],
        join(root, "packages/app"),
      );
      expect(inheritedMfe).toMatchObject({ code: 0, stdout: "4001\n" });

      const configuration = await runCandidate(
        ["config", `--cwd=${root}`],
        root,
      );
      expect(configuration.code).toBe(0);
      expect(JSON.parse(configuration.stdout)).toMatchObject({
        apiUrl: "https://vercel.com/api",
        enabled: true,
        packageManager: "pnpm9",
        timeout: 30,
        ui: "stream",
      });
      const invalidEnvironment = await runCandidate(
        ["run", "build", `--cwd=${root}`],
        root,
        { TURBO_CACHE_WORKERS: "invalid" },
      );
      expect(invalidEnvironment.code).toBe(1);
      expect(invalidEnvironment.stderr).toContain("invalid cache worker count");

      expect(
        (
          await runCandidate(
            [
              "boundaries",
              "--ignore=all",
              "--reason=synthetic",
              `--cwd=${root}`,
            ],
            root,
          )
        ).code,
      ).toBe(0);
      await exerciseDevtools(root);

      await withServer(
        (request) =>
          request.url?.startsWith("/search?") === true
            ? [
                200,
                { "content-type": "application/json" },
                JSON.stringify({
                  results: [
                    {
                      title: "Synthetic guide",
                      url: "https://example.invalid/guide",
                    },
                  ],
                }),
              ]
            : request.url === "/tags"
              ? [
                  200,
                  { "content-type": "application/json" },
                  '[{"name":"v2.10.12"},{"name":"v3.0.0-canary.1"}]',
                ]
              : [404, {}, "not found"],
        async (baseUrl, requests) => {
          const docs = await runCandidate(
            ["docs", "synthetic query", "--api=https://ignored.invalid"],
            root,
            { TURBO_TS_DOCS_ENDPOINT: `${baseUrl}/search` },
          );
          expect(docs.code).toBe(0);
          expect(docs.stdout).toContain(
            "Found 1 results for 'synthetic query'",
          );
          expect(docs.stdout).toContain("Synthetic guide");
          expect(docs.stdout).not.toContain("\u001B");
          const explicitlyPlainDocs = await runCandidate(
            ["docs", "synthetic query", "--no-color"],
            root,
            {
              NO_COLOR: undefined,
              TURBO_TS_DOCS_ENDPOINT: `${baseUrl}/search`,
            },
          );
          expect(explicitlyPlainDocs.code).toBe(0);
          expect(explicitlyPlainDocs.stdout).not.toContain("\u001B");
          const update = await runCandidate(
            [`--force-update-check=${baseUrl}/tags`],
            root,
          );
          expect(update.code).toBe(0);
          expect(update.stdout).toContain("latest stable Turbo baseline");
          const failedUpdate = await runCandidate(
            [`--force-update-check=${baseUrl}/missing`],
            root,
          );
          expect(failedUpdate.code).toBe(1);
          expect(failedUpdate.stderr).toContain("update check returned 404");
          expect(
            requests.every(
              (request) => request.headers["user-agent"] === "turbo-ts/0.1.0",
            ),
          ).toBe(true);
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it(evidenceId.telemetryCompatibility, async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-telemetry-"));
    const root = join(directory, "repository");
    const configurationHome = join(directory, "configuration");
    await prepareRepository(root);
    const environment = { XDG_CONFIG_HOME: configurationHome };
    try {
      const status = await runCandidate(
        ["telemetry", "status"],
        root,
        environment,
      );
      expect(status).toMatchObject({ code: 0 });
      expect(status.stdout).toContain("Status: Disabled");
      const path = join(configurationHome, "turborepo/telemetry.json");
      const initial = JSON.parse(await readFile(path, "utf8")) as Record<
        string,
        unknown
      >;
      expect(initial.telemetry_id).toMatch(/^[0-9a-f]{64}$/);
      expect(initial.telemetry_salt).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(Number.isNaN(Date.parse(String(initial.telemetry_alerted)))).toBe(
        false,
      );
      if (process.platform !== "win32") {
        expect((await stat(path)).mode & 0o777).toBe(0o644);
      }
      const enable = await runCandidate(["telemetry", "enable"], root, {
        ...environment,
        TURBO_TELEMETRY_DISABLED: "0",
      });
      expect(enable.stdout).toContain("Status: Enabled");
      const enabled = JSON.parse(await readFile(path, "utf8")) as Record<
        string,
        unknown
      >;
      expect(enabled).toMatchObject({ ...initial, telemetry_enabled: true });
      const officialStatus = await runCommand(
        official,
        ["telemetry", "status"],
        root,
        { ...environment, TURBO_TELEMETRY_DISABLED: "0" },
      );
      expect(officialStatus.code).toBe(0);
      expect(officialStatus.stdout).toContain("Status: Enabled");
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject(enabled);
      const disable = await runCandidate(["telemetry", "disable"], root, {
        ...environment,
        TURBO_TELEMETRY_DISABLED: "0",
      });
      expect(disable.stdout).toContain("Status: Disabled");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const emptyResponse = (status = 200): HttpResponse => ({
  status,
  headers: {},
  body: new Uint8Array(),
});

describe("hosted protocols and experimental transports", () => {
  it("uses mocked Aube, Nub, and uv executable identities and delegated lockfiles", async () => {
    const commands: Array<string> = [];
    const processLayer = Layer.succeed(ProcessService, {
      run: (request) => {
        commands.push(`${request.command} ${request.args.join(" ")}`);
        const stdout =
          request.command === "aube"
            ? "2.2.0\n"
            : request.command === "nub"
              ? "0.1.0\n"
              : request.args[0] === "--version"
                ? "uv 0.12.7\n"
                : "3.14.0\n";
        return Effect.succeed({
          exitCode: 0,
          stdout,
          stderr: "",
          combinedOutput: stdout,
        });
      },
      runBytes: (request) =>
        Effect.fail(
          new ProcessExecutionError({
            command: request.command,
            message: "unused mocked binary request",
          }),
        ),
    });
    const identities = await Effect.runPromise(
      Effect.all([
        resolvePackageManagerRuntimeIdentity("aube", "/synthetic", {}),
        resolvePackageManagerRuntimeIdentity("nub", "/synthetic", {}),
        resolveUvRuntimeIdentity("/synthetic", {}),
      ]).pipe(Effect.provide(processLayer)),
    );
    expect(identities).toEqual([
      { name: "aube", version: "2.2.0" },
      { name: "nub", version: "0.1.0" },
      { uvVersion: "uv 0.12.7", pythonVersion: "3.14.0" },
    ]);
    expect(commands).toEqual([
      "aube --version",
      "nub --version",
      "uv --version",
      "uv python find --show-version --no-python-downloads",
    ]);
    const encoder = new TextEncoder();
    expect(
      parseLockfile(
        "/synthetic/aube.lock",
        encoder.encode("lockfileVersion: '9.0'\nimporters: {}\npackages: {}\n"),
      ).format,
    ).toBe("aube");
    expect(
      parseLockfile(
        "/synthetic/package-lock.json",
        encoder.encode('{"lockfileVersion":3,"packages":{}}'),
      ).format,
    ).toBe("npm");
    expect(
      parseLockfile(
        "/synthetic/nub.lock",
        encoder.encode("lockfileVersion: '9.0'\nimporters: {}\npackages: {}\n"),
      ).format,
    ).toBe("nub");
  });

  it(evidenceId.hostedProtocol, async () => {
    const requests: Array<HttpRequest> = [];
    let statusAttempts = 0;
    const httpLayer = Layer.succeed(HttpService, {
      request: (request) =>
        Effect.sync(() => {
          requests.push(request);
          if (request.method === "GET" && request.url.includes("/status")) {
            statusAttempts += 1;
            return emptyResponse(statusAttempts < 3 ? 429 : 200);
          }
          if (request.method === "HEAD") return emptyResponse(404);
          return emptyResponse(201);
        }),
      downloadToFile: () =>
        Effect.fail(
          new BoundaryError({
            boundary: "test",
            message: "unused",
            retryable: false,
          }),
        ),
    });
    const options: RemoteCacheOptions = {
      apiUrl: "https://cache.invalid/api",
      token: "synthetic-token",
      teamId: "team_synthetic",
      timeoutMilliseconds: 100,
      uploadTimeoutMilliseconds: 100,
      preflight: true,
      requireSignature: false,
      sessionId: "01992345-6789-7abc-8def-0123456789ab",
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* verifyRemoteCacheStatus(options);
        const present = yield* headRemoteCache(options, "synthetic-hash");
        yield* headRemoteCache(
          { ...options, teamId: undefined, teamSlug: "other-synthetic" },
          "synthetic-hash",
        );
        yield* recordRemoteCacheEvent(options, "synthetic-hash", "MISS");
        return present;
      }).pipe(Effect.provide(Layer.merge(httpLayer, deterministicRetryLayer))),
    );
    expect(result).toBe(false);
    expect(statusAttempts).toBe(3);
    expect(requests.some((request) => request.method === "OPTIONS")).toBe(true);
    expect(requests.some((request) => request.method === "HEAD")).toBe(true);
    expect(
      requests.some((request) => request.url.endsWith("?slug=other-synthetic")),
    ).toBe(true);
    const event = requests.find((request) => request.method === "POST");
    expect(event?.url).toBe(
      "https://cache.invalid/api/v8/artifacts/events?teamId=team_synthetic",
    );
    expect(JSON.parse(String(event?.body))).toEqual([
      {
        duration: 0,
        event: "MISS",
        hash: "synthetic-hash",
        sessionId: "01992345-6789-7abc-8def-0123456789ab",
        source: "REMOTE",
      },
    ]);
    expect(event?.headers).toMatchObject({
      authorization: "Bearer synthetic-token",
      "content-type": "application/json",
      "user-agent": "turbo-ts/0.1.0",
    });
  });

  it(evidenceId.observabilityCompatibility, async () => {
    const requests: Array<HttpRequest> = [];
    const httpLayer = Layer.succeed(HttpService, {
      request: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return emptyResponse();
        }),
      downloadToFile: () =>
        Effect.fail(
          new BoundaryError({
            boundary: "test",
            message: "unused",
            retryable: false,
          }),
        ),
    });
    const environmentLayer = Layer.succeed(EnvironmentService, {
      argv: Effect.succeed([]),
      cwd: Effect.succeed("/synthetic"),
      platform: Effect.succeed(process.platform),
      get: () => Effect.succeed(undefined),
      entries: Effect.succeed({}),
    });
    const summary = {
      exitCode: 0,
      taskCount: 2,
      tasks: [
        {
          id: "synthetic-app#build",
          package: "synthetic-app",
          task: "build",
          status: "succeeded" as const,
          exitCode: 0,
          durationMilliseconds: 12,
          cacheSource: "local" as const,
        },
      ],
    };
    for (const protocol of ["http-json", "http-protobuf"] as const) {
      await Effect.runPromise(
        exportRunMetrics(
          {
            enabled: true,
            protocol,
            endpoint: "http://127.0.0.1:4318",
            headers: [["x-synthetic", "yes"]],
            resources: [["deployment.environment", "test"]],
            useRemoteCacheToken: true,
          },
          "synthetic-token",
          summary,
        ).pipe(Effect.provide(Layer.merge(httpLayer, environmentLayer))),
      );
    }
    expect(
      requests.map((request) => request.headers?.["content-type"]),
    ).toEqual(["application/json", "application/x-protobuf"]);
    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:4318/v1/metrics",
      "http://127.0.0.1:4318/v1/metrics",
    ]);
    for (const request of requests) {
      expect(request.headers).toMatchObject({
        authorization: "Bearer synthetic-token",
        "user-agent": "turbo-ts/0.1.0",
        "x-synthetic": "yes",
      });
    }
    const json = makeOtlpJsonMetrics(summary);
    expect(JSON.stringify(json)).toContain('"service.name"');
    expect(encodeOtlpMetrics(summary).byteLength).toBeGreaterThan(20);

    await Effect.runPromise(
      exportRunMetrics(
        {
          enabled: true,
          protocol: "http-json",
          endpoint: "http://127.0.0.1:4318",
          headers: [],
          resources: [],
          metricsRunSummary: false,
          metricsTaskDetails: true,
        },
        undefined,
        summary,
      ).pipe(Effect.provide(Layer.merge(httpLayer, environmentLayer))),
    );
    const taskMetricBody = requests.at(-1)?.body;
    const taskMetrics = JSON.parse(
      typeof taskMetricBody === "string"
        ? taskMetricBody
        : new TextDecoder().decode(taskMetricBody),
    );
    expect(
      taskMetrics.resourceMetrics[0].scopeMetrics[0].metrics.map(
        (metric: { readonly name: string }) => metric.name,
      ),
    ).toEqual(["turbo.task"]);
    expect(JSON.stringify(taskMetrics)).toContain("synthetic-app#build");

    const requestCount = requests.length;
    await Effect.runPromise(
      exportRunMetrics(
        {
          enabled: true,
          protocol: "http-json",
          endpoint: "http://127.0.0.1:4318",
          headers: [],
          resources: [],
          metricsRunSummary: false,
          metricsTaskDetails: false,
        },
        undefined,
        summary,
      ).pipe(Effect.provide(Layer.merge(httpLayer, environmentLayer))),
    );
    expect(requests).toHaveLength(requestCount);
  });

  it("sends OTLP gRPC over HTTP/2 and handles gRPC status", async () => {
    const requests: Array<{
      readonly body: Buffer;
      readonly headers: Readonly<Record<string, unknown>>;
    }> = [];
    let grpcStatus = "0";
    const server = createHttp2Server();
    server.on("stream", (stream, headers) => {
      const chunks: Array<Buffer> = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        requests.push({ body: Buffer.concat(chunks), headers });
        stream.respond(
          {
            [http2Constants.HTTP2_HEADER_STATUS]: 200,
            [http2Constants.HTTP2_HEADER_CONTENT_TYPE]: "application/grpc",
          },
          { waitForTrailers: true },
        );
        stream.on("wantTrailers", () =>
          stream.sendTrailers({
            "grpc-status": grpcStatus,
            ...(grpcStatus === "0"
              ? {}
              : { "grpc-message": "permission%20denied" }),
          }),
        );
        stream.end(Buffer.alloc(5));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("HTTP/2 test server did not expose a TCP address");
    }
    const options = {
      enabled: true,
      protocol: "grpc" as const,
      endpoint: `http://127.0.0.1:${address.port}`,
      headers: [["x-synthetic", "yes"]] as const,
      resources: [],
    };
    const summary = { exitCode: 0, taskCount: 0, tasks: [] };
    try {
      await Effect.runPromise(
        exportRunMetrics(options, undefined, summary).pipe(
          Effect.provide(nodeFoundationLayer),
        ),
      );
      expect(requests[0]?.headers[http2Constants.HTTP2_HEADER_METHOD]).toBe(
        "POST",
      );
      expect(requests[0]?.headers[http2Constants.HTTP2_HEADER_PATH]).toBe(
        "/opentelemetry.proto.collector.metrics.v1.MetricsService/Export",
      );
      expect(requests[0]?.body[0]).toBe(0);

      grpcStatus = "7";
      const failed = await Effect.runPromise(
        Effect.either(
          exportRunMetrics(options, undefined, summary).pipe(
            Effect.provide(nodeFoundationLayer),
          ),
        ),
      );
      expect(failed._tag).toBe("Left");
      if (failed._tag === "Right") throw new Error("expected gRPC failure");
      expect(failed.left.message).toContain("permission denied");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("exports resolved environment and stored remote tokens with task details", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-otel-run-"));
    const root = join(directory, "repository");
    const configurationHome = join(directory, "configuration");
    await prepareRepository(root);
    try {
      await withServer(
        () => [200, { "content-type": "application/json" }, "{}"],
        async (baseUrl, requests) => {
          const commonArguments = [
            "run",
            "build",
            "--filter=synthetic-app",
            "--no-cache",
            "--experimental-otel-enabled=true",
            "--experimental-otel-protocol=http-json",
            `--experimental-otel-endpoint=${baseUrl}`,
            "--experimental-otel-use-remote-cache-token=true",
            `--cwd=${root}`,
          ];
          const environmentToken = await runCandidate(commonArguments, root, {
            TURBO_TOKEN: "environment-token",
          });
          expect(environmentToken.code, environmentToken.stderr).toBe(0);
          expect(requests[0]?.headers.authorization).toBe(
            "Bearer environment-token",
          );

          const userPath = join(configurationHome, "turborepo/config.json");
          await mkdir(join(configurationHome, "turborepo"), {
            recursive: true,
          });
          await writeFile(userPath, JSON.stringify({ token: "stored-token" }));
          if (process.platform !== "win32") await chmod(userPath, 0o600);
          const storedToken = await runCandidate(
            [
              ...commonArguments,
              "--experimental-otel-metrics-run-summary=false",
              "--experimental-otel-metrics-task-details=true",
            ],
            root,
            { XDG_CONFIG_HOME: configurationHome },
          );
          expect(storedToken.code, storedToken.stderr).toBe(0);
          expect(requests[1]?.headers.authorization).toBe(
            "Bearer stored-token",
          );
          const document = JSON.parse(requests[1]?.body ?? "{}");
          const metrics = document.resourceMetrics[0].scopeMetrics[0].metrics;
          expect(
            metrics.map((metric: { readonly name: string }) => metric.name),
          ).toEqual(["turbo.task"]);
          expect(JSON.stringify(metrics)).toContain("synthetic-app#build");
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("strips secrets on cross-origin redirects and enforces timeouts", async () => {
    await withServer(
      () => [200, {}, "ok"],
      async (destination, destinationRequests) => {
        await withServer(
          () => [302, { location: destination }, "redirect"],
          async (source) => {
            const result = await Effect.runPromise(
              HttpService.pipe(
                Effect.flatMap((http) =>
                  http.request({
                    url: source,
                    method: "GET",
                    headers: {
                      authorization: "Bearer synthetic-token",
                      "x-cache-signature": "synthetic-signature",
                    },
                    timeoutMilliseconds: 1_000,
                  }),
                ),
                Effect.provide(nodeFoundationLayer),
              ),
            );
            expect(result.status).toBe(200);
            expect(
              destinationRequests[0]?.headers.authorization,
            ).toBeUndefined();
            expect(
              destinationRequests[0]?.headers["x-cache-signature"],
            ).toBeUndefined();
          },
        );
      },
    );

    await withServer(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return [200, {}, "late"];
      },
      async (baseUrl) => {
        const outcome = await Effect.runPromise(
          Effect.either(
            HttpService.pipe(
              Effect.flatMap((http) =>
                http.request({
                  url: baseUrl,
                  method: "GET",
                  timeoutMilliseconds: 1,
                }),
              ),
              Effect.provide(nodeFoundationLayer),
            ),
          ),
        );
        expect(outcome._tag).toBe("Left");
        if (outcome._tag === "Right") throw new Error("expected HTTP timeout");
        expect(outcome.left).toBeInstanceOf(BoundaryError);
        expect(outcome.left.boundary).toBe("http");
      },
    );
  });
});
