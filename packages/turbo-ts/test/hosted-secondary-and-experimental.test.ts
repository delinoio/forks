import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import {
  createServer as createHttp2Server,
  constants as http2Constants,
  type ServerHttp2Session,
} from "node:http2";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "@rstest/core";
import { Effect, Fiber, Layer } from "effect";
import {
  headRemoteCache,
  type RemoteCacheOptions,
  recordRemoteCacheEvent,
  verifyRemoteCacheStatus,
} from "../src/cache/remote-cache.js";
import { parseCommonArguments } from "../src/cli/common-options.js";
import { renderTerminalSafeText } from "../src/cli/terminal-text.js";
import { evidenceId } from "../src/compatibility/ledger.js";
import { BoundaryError, ProcessExecutionError } from "../src/effect/errors.js";
import {
  nodeFoundationLayer,
  readBoundedConfigurationHandle,
  resolveUserConfigurationDirectory,
} from "../src/effect/node-layer.js";
import {
  ClockService,
  CredentialService,
  deterministicRetryLayer,
  EnvironmentService,
  FileSystemService,
  type HttpRequest,
  type HttpResponse,
  HttpService,
  ProcessService,
  RandomnessService,
  type StoredUserConfiguration,
  TerminalService,
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
import { browserInvocation } from "../src/workflow/browser.js";
import {
  executeDevtools,
  parseDevtoolsArguments,
} from "../src/workflow/devtools.js";
import {
  executeGenerate,
  parseGenerateArguments,
} from "../src/workflow/generate.js";
import {
  executeHostedCommand,
  parseHostedArguments,
  resolveHostedTimeoutMilliseconds,
} from "../src/workflow/hosted.js";
import {
  executeSecondaryCommand,
  selectCurrentPackage,
} from "../src/workflow/secondary.js";

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

const rawLoopbackStatus = (port: number, target: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.once("end", () => {
      const status = /^HTTP\/1\.1 (\d{3})/.exec(response)?.[1];
      if (status === undefined) {
        reject(new Error(`loopback response omitted a status: ${response}`));
        return;
      }
      resolve(Number(status));
    });
    socket.once("error", reject);
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

type DevtoolsLaunchMode =
  | "browser"
  | "failure"
  | "no-open"
  | "nonzero"
  | "unavailable";

const exerciseDevtools = async (
  root: string,
  mode: DevtoolsLaunchMode,
): Promise<void> => {
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
  const services = await Effect.runPromise(
    Effect.gen(function* () {
      return {
        environment: yield* EnvironmentService,
        processes: yield* ProcessService,
        terminal: yield* TerminalService,
      };
    }).pipe(Effect.provide(nodeFoundationLayer)),
  );
  let output = "";
  let resolveOpened: ((url: string) => void) | undefined;
  const opened = new Promise<string>((resolve) => {
    resolveOpened = resolve;
  });
  let resolveFallback: (() => void) | undefined;
  const fallback = new Promise<void>((resolve) => {
    resolveFallback = resolve;
  });
  let launchAttempts = 0;
  const token = "018f05c9-7b4a-7cc0-98c4-66395a148002";
  const overrides = Layer.mergeAll(
    Layer.succeed(EnvironmentService, {
      ...services.environment,
      platform: Effect.succeed("linux" as NodeJS.Platform),
    }),
    Layer.succeed(ProcessService, {
      ...services.processes,
      run: (request) => {
        if (request.command !== "xdg-open") {
          return services.processes.run(request);
        }
        launchAttempts += 1;
        if (mode === "failure") {
          return Effect.fail(
            new ProcessExecutionError({
              command: request.command,
              message: "synthetic browser launch failure",
            }),
          );
        }
        return Effect.sync(() => {
          const url = request.args.find((argument) =>
            argument.startsWith("http://"),
          );
          if (url === undefined) {
            throw new Error("browser URL was not passed");
          }
          resolveOpened?.(url);
          return {
            exitCode: mode === "nonzero" ? 1 : 0,
            stdout: "",
            stderr: "",
            combinedOutput: "",
          };
        });
      },
      spawnDetached:
        mode === "unavailable" ? undefined : services.processes.spawnDetached,
    }),
    Layer.succeed(RandomnessService, {
      uuidV7: Effect.succeed(token),
    }),
    Layer.succeed(TerminalService, {
      ...services.terminal,
      writeStdout: (text) =>
        Effect.sync(() => {
          output += text;
          if (text.startsWith("turbo-ts devtools authenticated:")) {
            resolveFallback?.();
          }
        }),
      writeStderr: () => Effect.void,
    }),
  );
  const arguments_ = [`--port=${port}`, `--cwd=${root}`];
  if (mode === "no-open") arguments_.push("--no-open");
  const fiber = Effect.runFork(
    executeDevtools(arguments_).pipe(
      Effect.provide(overrides),
      Effect.provide(nodeFoundationLayer),
    ),
  );
  try {
    const publicUrl = `http://127.0.0.1:${port}/`;
    const authenticatedUrl = `${publicUrl}?token=${token}`;
    const accessedUrl =
      mode === "browser"
        ? await Promise.race([
            opened,
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("devtools browser launch timed out")),
                10_000,
              ),
            ),
          ])
        : await Promise.race([
            fallback.then(() => authenticatedUrl),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("devtools fallback URL timed out")),
                10_000,
              ),
            ),
          ]);
    expect(output).toContain(`turbo-ts devtools: ${publicUrl}`);
    if (mode === "browser") {
      expect(output).not.toContain(token);
      expect(launchAttempts).toBe(1);
    } else {
      expect(output).toContain(
        `turbo-ts devtools authenticated: ${authenticatedUrl}`,
      );
      expect(launchAttempts).toBe(
        mode === "failure" || mode === "nonzero" ? 1 : 0,
      );
    }
    const authorized = new URL(accessedUrl);
    expect(authorized.searchParams.get("token")).toBe(token);
    if (mode === "browser") {
      expect(await rawLoopbackStatus(port, "http://[")).toBe(400);
    }
    const pageResponse = await fetch(authorized);
    expect(pageResponse.status).toBe(200);
    const page = await pageResponse.text();
    expect(page).toContain("synthetic-app");
    expect(page).toContain("synthetic-library");
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
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
};

const promptForBoundaries = async (
  root: string,
  answer: string,
  filter?: string,
): Promise<{
  readonly code: number;
  readonly prompts: ReadonlyArray<string>;
}> => {
  const terminal = await Effect.runPromise(
    TerminalService.pipe(Effect.provide(nodeFoundationLayer)),
  );
  const prompts: Array<string> = [];
  const arguments_ = ["--ignore=prompt", "--reason=synthetic", `--cwd=${root}`];
  if (filter !== undefined) arguments_.push(`--filter=${filter}`);
  const code = await Effect.runPromise(
    executeSecondaryCommand("boundaries", arguments_).pipe(
      Effect.provide(
        Layer.succeed(TerminalService, {
          ...terminal,
          stdinIsTerminal: Effect.succeed(true),
          readLine: (prompt) =>
            Effect.sync(() => {
              prompts.push(prompt);
              return answer;
            }),
        }),
      ),
      Effect.provide(nodeFoundationLayer),
    ),
  );
  return { code, prompts };
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
                  '{"teams":[{"id":"team_synthetic","slug":"synthetic","name":"Synthetic Team"},{"id":"team_disabled","slug":"disabled","name":"Disabled Team"}],"pagination":{"next":123}}',
                ]
              : request.url === "/v2/teams?limit=100&until=123"
                ? [
                    200,
                    { "content-type": "application/json" },
                    '{"teams":[{"id":"team_later","slug":"later","name":"Later Team"}],"pagination":{"next":null}}',
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
          const configuredApiUrl = new URL(baseUrl).toString();
          const environment = {
            XDG_CONFIG_HOME: configurationHome,
          };
          const unusedLoginEnvironment = {
            ...environment,
            TURBO_LOGIN: "not-a-url",
          };
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
            unusedLoginEnvironment,
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

          const storedManualLogin = await runCandidate(
            ["login", "--manual", `--api=${baseUrl}`, `--cwd=${root}`],
            root,
            unusedLoginEnvironment,
          );
          expect(storedManualLogin.code).toBe(1);
          expect(storedManualLogin.stderr).toContain(
            "manual login requires a token from --token or TURBO_TOKEN",
          );
          const storedNonInteractiveLogin = await runCandidate(
            ["login", `--api=${baseUrl}`, `--cwd=${root}`],
            root,
            unusedLoginEnvironment,
          );
          expect(storedNonInteractiveLogin.code).toBe(1);
          expect(storedNonInteractiveLogin.stderr).toContain(
            "login requires a token from --token or TURBO_TOKEN in non-interactive mode",
          );
          expect(JSON.parse(await readFile(userPath, "utf8"))).toEqual({
            token,
          });

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
                unusedLoginEnvironment,
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
            unusedLoginEnvironment,
          );
          expect(link.code).toBe(0);
          expect(`${link.stdout}${link.stderr}`).not.toContain(token);
          expect(
            JSON.parse(
              await readFile(join(root, ".turbo/config.json"), "utf8"),
            ),
          ).toEqual({
            apiUrl: configuredApiUrl,
            teamId: "team_synthetic",
            teamSlug: "synthetic",
          });
          const linkedConfiguration = await runCandidate(
            ["config", `--cwd=${root}`],
            root,
            environment,
          );
          expect(linkedConfiguration.code, linkedConfiguration.stderr).toBe(0);
          expect(JSON.parse(linkedConfiguration.stdout).apiUrl).toBe(
            configuredApiUrl,
          );
          expect(await readFile(join(root, ".gitignore"), "utf8")).toContain(
            ".turbo",
          );

          const paginatedLink = await runCandidate(
            ["link", "--scope=later", "--yes", `--cwd=${root}`],
            root,
            unusedLoginEnvironment,
          );
          expect(paginatedLink.code, paginatedLink.stderr).toBe(0);
          expect(
            JSON.parse(
              await readFile(join(root, ".turbo/config.json"), "utf8"),
            ),
          ).toEqual({
            apiUrl: configuredApiUrl,
            teamId: "team_later",
            teamSlug: "later",
          });

          expect(
            (await runCandidate(["unlink", `--cwd=${root}`], root, environment))
              .code,
          ).toBe(0);
          expect(
            JSON.parse(
              await readFile(join(root, ".turbo/config.json"), "utf8"),
            ),
          ).toEqual({});
          await writeFile(userPath, "{malformed");
          const recoveryUnlink = await runCandidate(
            ["unlink", `--cwd=${root}`],
            root,
            {
              ...environment,
              TURBO_API: "not-a-url",
              TURBO_LOGIN: "not-a-url",
            },
          );
          expect(recoveryUnlink.code, recoveryUnlink.stderr).toBe(0);
          expect(
            JSON.parse(
              await readFile(join(root, ".turbo/config.json"), "utf8"),
            ),
          ).toEqual({});
          await writeFile(userPath, JSON.stringify({ token }));
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
          ).toEqual({
            apiUrl: configuredApiUrl,
            teamId: "user_synthetic",
            teamSlug: "synthetic-user",
          });
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
          ).toEqual({
            apiUrl: configuredApiUrl,
            teamId: "user_synthetic",
            teamSlug: "synthetic-user",
          });
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
            ["logout", `--cwd=${root}`],
            root,
            unusedLoginEnvironment,
          );
          expect(logout.code).toBe(0);
          expect(`${logout.stdout}${logout.stderr}`).not.toContain(token);
          expect(JSON.parse(await readFile(userPath, "utf8"))).toEqual({});

          await writeFile(
            userPath,
            JSON.stringify({ retained: "synthetic", token }),
          );
          const localLogout = await runCandidate(
            ["logout", "--invalidate=false", `--cwd=${root}`],
            root,
            {
              ...environment,
              TURBO_API: "not-a-url",
              TURBO_LOGIN: "not-a-url",
            },
          );
          expect(localLogout.code, localLogout.stderr).toBe(0);
          expect(JSON.parse(await readFile(userPath, "utf8"))).toEqual({
            retained: "synthetic",
          });

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
          expect(
            requests.some(
              (request) => request.path === "/v2/teams?limit=100&until=123",
            ),
          ).toBe(true);
          expect(requests.at(-1)).toMatchObject({
            method: "DELETE",
            path: "/v3/user/tokens/current",
          });
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

  it("removes the local token when persisted invalidation is unavailable or rejected", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-logout-"));
    const root = join(directory, "repository");
    const token = "synthetic-logout-token";
    await prepareRepository(root);
    try {
      const services = await Effect.runPromise(
        Effect.gen(function* () {
          return {
            credentials: yield* CredentialService,
            environment: yield* EnvironmentService,
            http: yield* HttpService,
            terminal: yield* TerminalService,
          };
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      let storedUser: StoredUserConfiguration = {
        retained: "synthetic-value",
        token,
      };
      let invalidationStatus: number | undefined;
      let output = "";
      const requests: Array<HttpRequest> = [];
      const overrides = Layer.mergeAll(
        Layer.succeed(CredentialService, {
          ...services.credentials,
          readUserConfiguration: Effect.sync(() => storedUser),
          writeUserConfiguration: (value) =>
            Effect.sync(() => {
              storedUser = value;
            }),
          readProjectConfiguration: () =>
            Effect.succeed({ apiUrl: "https://api.example.test" }),
        }),
        Layer.succeed(EnvironmentService, {
          ...services.environment,
          cwd: Effect.succeed(root),
          get: () => Effect.succeed(undefined),
        }),
        Layer.succeed(HttpService, {
          ...services.http,
          request: (request) =>
            Effect.suspend(() => {
              requests.push(request);
              return invalidationStatus === undefined
                ? Effect.fail(
                    new BoundaryError({
                      boundary: "http",
                      message: "synthetic issuing API unavailable",
                      retryable: true,
                    }),
                  )
                : Effect.succeed({
                    status: invalidationStatus,
                    headers: {},
                    body: new Uint8Array(),
                  });
            }),
        }),
        Layer.succeed(TerminalService, {
          ...services.terminal,
          writeStdout: (text) =>
            Effect.sync(() => {
              output += text;
            }),
        }),
      );
      const logout = () =>
        executeHostedCommand("logout", [`--cwd=${root}`]).pipe(
          Effect.provide(overrides),
          Effect.provide(nodeFoundationLayer),
        );

      expect(await Effect.runPromise(logout())).toBe(0);
      expect(requests).toHaveLength(3);
      expect(requests[0]).toMatchObject({
        method: "DELETE",
        url: "https://api.example.test/v3/user/tokens/current",
      });
      expect(storedUser).toEqual({ retained: "synthetic-value" });
      expect(output).toContain(">>> Logged out");

      for (const status of [401, 403]) {
        storedUser = { retained: "synthetic-value", token };
        invalidationStatus = status;
        output = "";
        requests.length = 0;
        const rejected = await Effect.runPromise(Effect.either(logout()));
        expect(rejected).toMatchObject({
          _tag: "Left",
          left: {
            message: `token was removed locally, but remote invalidation failed with status ${status}`,
          },
        });
        expect(requests).toHaveLength(1);
        expect(storedUser).toEqual({ retained: "synthetic-value" });
        expect(output).toBe("");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not persist link state when the gitignore update fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-link-atomic-"));
    const root = join(directory, "repository");
    const configurationHome = join(directory, "configuration");
    const projectPath = join(root, ".turbo/config.json");
    const existingProject = {
      apiUrl: "https://previous.example.test/api",
      retained: "synthetic-value",
      teamId: "team_previous",
      teamSlug: "previous",
    };
    await prepareRepository(root);
    await mkdir(join(root, ".turbo"), { recursive: true });
    await writeFile(projectPath, JSON.stringify(existingProject));
    await mkdir(join(root, ".gitignore"));
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
              ? [200, { "content-type": "application/json" }, '{"teams":[]}']
              : request.url?.startsWith("/v8/artifacts/status") === true
                ? [
                    200,
                    { "content-type": "application/json" },
                    '{"status":"enabled"}',
                  ]
                : [404, {}, "not found"],
        async (baseUrl, requests) => {
          const result = await runCandidate(
            [
              "link",
              "--scope=synthetic-user",
              "--yes",
              "--token=synthetic-token",
              `--api=${baseUrl}`,
              `--cwd=${root}`,
            ],
            root,
            { XDG_CONFIG_HOME: configurationHome },
          );
          expect(result.code).toBe(1);
          expect(
            requests.some((request) =>
              request.path.startsWith("/v8/artifacts/status"),
            ),
          ).toBe(true);
          expect(JSON.parse(await readFile(projectPath, "utf8"))).toEqual(
            existingProject,
          );
          if (process.platform !== "win32") {
            const ignorePath = join(root, ".gitignore");
            const sharedIgnorePath = join(directory, "shared.gitignore");
            await rm(ignorePath, { recursive: true });
            await writeFile(sharedIgnorePath, "dist/\n");
            await symlink("../shared.gitignore", ignorePath);
            const symlinkResult = await runCandidate(
              [
                "link",
                "--scope=synthetic-user",
                "--yes",
                "--token=synthetic-token",
                `--api=${baseUrl}`,
                `--cwd=${root}`,
              ],
              root,
              { XDG_CONFIG_HOME: configurationHome },
            );
            expect(symlinkResult.code).toBe(1);
            expect(symlinkResult.stderr).toContain(
              "symlinked repository .gitignore",
            );
            expect(await readlink(ignorePath)).toBe("../shared.gitignore");
            expect(await readFile(sharedIgnorePath, "utf8")).toBe("dist/\n");
            expect(JSON.parse(await readFile(projectPath, "utf8"))).toEqual(
              existingProject,
            );
          }
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("selects and confirms a link scope interactively", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-link-scope-"));
    const root = join(directory, "repository");
    const token = "synthetic-link-token";
    await prepareRepository(root);
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
                  '{"teams":[{"id":"team_synthetic","slug":"synthetic","name":"Synthetic Team"}],"pagination":{"next":123}}',
                ]
              : request.url === "/v2/teams?limit=100&until=123"
                ? [
                    200,
                    { "content-type": "application/json" },
                    '{"teams":[{"id":"team_later","slug":"later","name":"Later Team"},{"id":"team_unsafe","slug":"unsafe\\u001b[31m","name":"Unsafe\\u001b]52;c;c3ludGhldGlj\\u0007 Team"}],"pagination":{"next":null}}',
                  ]
                : request.url?.startsWith("/v8/artifacts/status") === true
                  ? [
                      200,
                      { "content-type": "application/json" },
                      '{"status":"enabled"}',
                    ]
                  : [404, {}, "not found"],
        async (baseUrl, requests) => {
          const services = await Effect.runPromise(
            Effect.gen(function* () {
              return {
                credentials: yield* CredentialService,
                environment: yield* EnvironmentService,
                terminal: yield* TerminalService,
              };
            }).pipe(Effect.provide(nodeFoundationLayer)),
          );
          let answers: Array<string> = [];
          let environmentTeamId: string | undefined;
          let environmentTeamSlug: string | undefined;
          let output = "";
          const prompts: Array<string> = [];
          let storedProject:
            | {
                readonly apiUrl?: string;
                readonly teamId?: string;
                readonly teamSlug?: string;
              }
            | undefined;
          const credentialsLayer = Layer.succeed(CredentialService, {
            ...services.credentials,
            readUserConfiguration: Effect.succeed({ token }),
            readProjectConfiguration: () =>
              Effect.succeed({
                teamSlug: "stale-team",
                retained: "synthetic-value",
              }),
            writeProjectConfiguration: (_root, configuration) =>
              Effect.sync(() => {
                storedProject = configuration;
              }),
          });
          const environmentLayer = Layer.succeed(EnvironmentService, {
            ...services.environment,
            cwd: Effect.succeed(root),
            get: (name) =>
              Effect.succeed(
                name === "TURBO_TEAMID"
                  ? environmentTeamId
                  : name === "TURBO_TEAM"
                    ? environmentTeamSlug
                    : undefined,
              ),
          });
          const terminalLayer = (interactive: boolean) =>
            Layer.succeed(TerminalService, {
              ...services.terminal,
              stdinIsTerminal: Effect.succeed(interactive),
              readLine: (prompt) =>
                Effect.sync(() => {
                  prompts.push(prompt);
                  return answers.shift() ?? "";
                }),
              writeStdout: (text) =>
                Effect.sync(() => {
                  output += text;
                }),
              writeStderr: () => Effect.void,
            });
          const execute = (
            arguments_: ReadonlyArray<string>,
            interactive: boolean,
          ) =>
            Effect.runPromise(
              executeHostedCommand("link", arguments_).pipe(
                Effect.provide(
                  Layer.mergeAll(
                    credentialsLayer,
                    environmentLayer,
                    terminalLayer(interactive),
                  ),
                ),
                Effect.provide(nodeFoundationLayer),
              ),
            );
          const commonArguments = [
            `--api=${baseUrl}`,
            `--cwd=${root}`,
            "--no-gitignore",
          ];

          answers = ["3", "yes"];
          expect(await execute(commonArguments, true)).toBe(0);
          expect(output).toContain(
            "1. Synthetic User (synthetic-user)\n  2. Synthetic Team (synthetic)\n  3. Later Team (later)",
          );
          expect(prompts).toEqual([
            "Enter a scope [1-4]: ",
            "Enable Remote Caching for Later Team? [y/N] ",
          ]);
          expect(storedProject).toEqual({
            apiUrl: new URL(baseUrl).toString(),
            retained: "synthetic-value",
            teamId: "team_later",
            teamSlug: "later",
          });
          expect(
            requests.some(
              (request) =>
                request.path ===
                "/v8/artifacts/status?teamId=team_later&slug=later",
            ),
          ).toBe(true);

          storedProject = undefined;
          output = "";
          prompts.length = 0;
          answers = ["no"];
          expect(
            await execute(["--scope=synthetic", ...commonArguments], true),
          ).toBe(0);
          expect(storedProject).toBeUndefined();
          expect(output).toContain("Remote Caching link cancelled.");
          expect(prompts).toEqual([
            "Enable Remote Caching for Synthetic Team? [y/N] ",
          ]);

          prompts.length = 0;
          answers = [];
          const nonInteractive = await Effect.runPromise(
            Effect.either(
              executeHostedCommand("link", ["--yes", ...commonArguments]).pipe(
                Effect.provide(
                  Layer.mergeAll(
                    credentialsLayer,
                    environmentLayer,
                    terminalLayer(false),
                  ),
                ),
                Effect.provide(nodeFoundationLayer),
              ),
            ),
          );
          expect(nonInteractive).toMatchObject({
            _tag: "Left",
            left: {
              message:
                "link requires --scope, --team, TURBO_TEAM, or TURBO_TEAMID in non-interactive mode",
            },
          });
          expect(prompts).toEqual([]);
          expect(storedProject).toBeUndefined();

          environmentTeamId = "team_stale";
          expect(
            await execute(
              ["--team=synthetic-user", "--yes", ...commonArguments],
              false,
            ),
          ).toBe(0);
          expect(storedProject).toEqual({
            apiUrl: new URL(baseUrl).toString(),
            retained: "synthetic-value",
            teamId: "user_synthetic",
            teamSlug: "synthetic-user",
          });
          expect(requests.at(-1)?.path).toBe(
            "/v8/artifacts/status?teamId=user_synthetic&slug=synthetic-user",
          );

          storedProject = undefined;
          environmentTeamSlug = "later";
          expect(await execute(["--yes", ...commonArguments], false)).toBe(0);
          expect(storedProject).toEqual({
            apiUrl: new URL(baseUrl).toString(),
            retained: "synthetic-value",
            teamId: "team_later",
            teamSlug: "later",
          });
          expect(requests.at(-1)?.path).toBe(
            "/v8/artifacts/status?teamId=team_later&slug=later",
          );

          environmentTeamId = undefined;
          environmentTeamSlug = undefined;
          storedProject = undefined;
          output = "";
          prompts.length = 0;
          answers = ["4", "yes"];
          expect(await execute(commonArguments, true)).toBe(0);
          expect(output).not.toContain("\u001B");
          expect(output).not.toContain("\u0007");
          expect(output).toContain(
            "Unsafe\\u001b]52;c;c3ludGhldGlj\\u0007 Team (unsafe\\u001b[31m)",
          );
          expect(output).toContain(
            ">>> Enabled Remote Caching for Unsafe\\u001b]52;c;c3ludGhldGlj\\u0007 Team",
          );
          expect(prompts).toEqual([
            "Enter a scope [1-4]: ",
            "Enable Remote Caching for Unsafe\\u001b]52;c;c3ludGhldGlj\\u0007 Team? [y/N] ",
          ]);
          expect(storedProject).toEqual({
            apiUrl: new URL(baseUrl).toString(),
            retained: "synthetic-value",
            teamId: "team_unsafe",
            teamSlug: "unsafe\u001b[31m",
          });
          const unsafeStatusQuery = new URL(
            requests.at(-1)?.path ?? "",
            "http://127.0.0.1",
          ).searchParams;
          expect(unsafeStatusQuery.get("teamId")).toBe("team_unsafe");
          expect(unsafeStatusQuery.get("slug")).toBe("unsafe\u001b[31m");
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid, repeated, and unbounded hosted team pagination cursors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-team-pages-"));
    const root = join(directory, "repository");
    await prepareRepository(root);
    try {
      for (const scenario of ["invalid", "repeated", "unbounded"] as const) {
        let page = 0;
        await withServer(
          (request) =>
            request.url === "/v2/user"
              ? [
                  200,
                  { "content-type": "application/json" },
                  '{"user":{"id":"user_synthetic","username":"synthetic-user","name":"Synthetic User"}}',
                ]
              : request.url?.startsWith("/v2/teams?") === true
                ? [
                    200,
                    { "content-type": "application/json" },
                    JSON.stringify({
                      teams: [],
                      pagination: {
                        next:
                          scenario === "invalid"
                            ? "invalid"
                            : scenario === "repeated"
                              ? 123
                              : ++page,
                      },
                    }),
                  ]
                : [404, {}, "not found"],
          async (baseUrl, requests) => {
            const result = await runCandidate(
              [
                "link",
                "--scope=missing",
                "--yes",
                "--no-gitignore",
                "--token=synthetic-token",
                `--api=${baseUrl}`,
                `--cwd=${root}`,
              ],
              root,
            );
            expect(result.code).toBe(1);
            expect(result.stderr).toContain(
              scenario === "invalid"
                ? "invalid pagination cursor"
                : scenario === "repeated"
                  ? "repeated pagination cursor"
                  : "exceeded the 100 page limit",
            );
            expect(
              requests.filter((request) =>
                request.path.startsWith("/v2/teams?"),
              ),
            ).toHaveLength(
              scenario === "invalid" ? 1 : scenario === "repeated" ? 2 : 100,
            );
          },
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("passes complete browser URLs without Windows command expansion", () => {
    const url =
      "https://login.example.test/turborepo/token?redirect_uri=http%3A%2F%2F127.0.0.1%3A1234%2F&state=synthetic-state";
    expect(browserInvocation("win32", url)).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    });
    expect(browserInvocation("darwin", url)).toEqual({
      command: "open",
      args: [url],
    });
    expect(browserInvocation("linux", url)).toEqual({
      command: "xdg-open",
      args: [url],
    });
  });

  it("completes interactive browser login without exposing credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-login-browser-"));
    const root = join(directory, "repository");
    const token = "synthetic-browser-login-token";
    const state = "018f05c9-7b4a-7cc0-98c4-66395a148003";
    await prepareRepository(root);
    try {
      await withServer(
        (request) =>
          request.url?.startsWith("/v8/artifacts/status") === true
            ? [
                200,
                { "content-type": "application/json" },
                '{"status":"enabled"}',
              ]
            : [404, {}, "not found"],
        async (baseUrl, requests) => {
          const services = await Effect.runPromise(
            Effect.gen(function* () {
              return {
                credentials: yield* CredentialService,
                environment: yield* EnvironmentService,
                processes: yield* ProcessService,
                terminal: yield* TerminalService,
              };
            }).pipe(Effect.provide(nodeFoundationLayer)),
          );
          let output = "";
          let storedConfiguration:
            | { readonly token?: string; readonly [name: string]: unknown }
            | undefined;
          let resolveOpened: ((url: string) => void) | undefined;
          const opened = new Promise<string>((resolve) => {
            resolveOpened = resolve;
          });
          const overrides = Layer.mergeAll(
            Layer.succeed(CredentialService, {
              ...services.credentials,
              readUserConfiguration: Effect.succeed({
                retained: "synthetic-value",
                token: "stale-login-token",
              }),
              writeUserConfiguration: (configuration) =>
                Effect.sync(() => {
                  storedConfiguration = configuration;
                }),
            }),
            Layer.succeed(EnvironmentService, {
              ...services.environment,
              cwd: Effect.succeed(root),
              platform: Effect.succeed("linux" as NodeJS.Platform),
              get: (name) =>
                Effect.succeed(
                  name === "TURBO_TEAMID" ? "team_stored" : undefined,
                ),
            }),
            Layer.succeed(ProcessService, {
              ...services.processes,
              run: (request) => {
                if (request.command !== "xdg-open") {
                  return services.processes.run(request);
                }
                return Effect.sync(() => {
                  const url = request.args.find((argument) =>
                    argument.startsWith("https://"),
                  );
                  if (url === undefined) {
                    throw new Error("login URL was not passed to the browser");
                  }
                  resolveOpened?.(url);
                  return {
                    exitCode: 0,
                    stdout: "",
                    stderr: "",
                    combinedOutput: "",
                  };
                });
              },
              spawnDetached: undefined,
            }),
            Layer.succeed(RandomnessService, {
              uuidV7: Effect.succeed(state),
            }),
            Layer.succeed(TerminalService, {
              ...services.terminal,
              stdinIsTerminal: Effect.succeed(true),
              writeStdout: (text) =>
                Effect.sync(() => {
                  output += text;
                }),
              writeStderr: () => Effect.void,
            }),
          );
          const fiber = Effect.runFork(
            executeHostedCommand("login", [
              `--api=${baseUrl}`,
              "--login=https://login.example.test",
              "--sso-team=synthetic-sso",
              `--cwd=${root}`,
            ]).pipe(
              Effect.provide(overrides),
              Effect.provide(nodeFoundationLayer),
            ),
          );
          try {
            const openedUrl = await Promise.race([
              opened,
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error("login browser launch timed out")),
                  10_000,
                ),
              ),
            ]);
            const authorization = new URL(openedUrl);
            expect(authorization.origin).toBe("https://login.example.test");
            expect(authorization.pathname).toBe("/turborepo/token");
            expect(authorization.searchParams.get("state")).toBe(state);
            expect(authorization.searchParams.get("ssoTeam")).toBe(
              "synthetic-sso",
            );
            const redirect = authorization.searchParams.get("redirect_uri");
            expect(redirect).toBeDefined();
            const callback = new URL(redirect!);
            expect((await Effect.runPromise(Fiber.poll(fiber)))._tag).toBe(
              "None",
            );
            expect(
              await rawLoopbackStatus(Number(callback.port), "http://["),
            ).toBe(400);
            const invokeCallback = async (): Promise<Response> => {
              try {
                return await fetch(callback);
              } catch (cause) {
                const nested = (cause as { readonly cause?: unknown }).cause;
                throw new Error(
                  `login callback request failed for ${callback.origin}: ${String(nested ?? cause)}`,
                );
              }
            };
            callback.searchParams.set("state", "wrong-state");
            callback.searchParams.set("token", token);
            expect((await invokeCallback()).status).toBe(403);
            callback.searchParams.set("state", state);
            expect((await invokeCallback()).status).toBe(200);

            expect(await Effect.runPromise(Fiber.join(fiber))).toBe(0);
            expect(storedConfiguration).toEqual({
              retained: "synthetic-value",
              token,
            });
            expect(output).not.toContain(token);
            expect(output).not.toContain(state);
            expect(output).not.toContain(openedUrl);
            expect(requests).toHaveLength(1);
            expect(requests[0]).toMatchObject({
              method: "GET",
              path: "/v8/artifacts/status?slug=synthetic-sso",
            });
            expect(requests[0]?.headers.authorization).toBe(`Bearer ${token}`);
          } finally {
            await Effect.runPromise(Fiber.interrupt(fiber));
          }
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails interactive login when the browser launcher fails", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "turbo-ts-login-browser-failure-"),
    );
    const root = join(directory, "repository");
    const state = "018f05c9-7b4a-7cc0-98c4-66395a148004";
    await prepareRepository(root);
    try {
      const services = await Effect.runPromise(
        Effect.gen(function* () {
          return {
            credentials: yield* CredentialService,
            environment: yield* EnvironmentService,
            processes: yield* ProcessService,
            terminal: yield* TerminalService,
          };
        }).pipe(Effect.provide(nodeFoundationLayer)),
      );
      for (const mode of ["error", "nonzero"] as const) {
        let output = "";
        let wroteCredentials = false;
        const overrides = Layer.mergeAll(
          Layer.succeed(CredentialService, {
            ...services.credentials,
            readUserConfiguration: Effect.succeed(undefined),
            writeUserConfiguration: () =>
              Effect.sync(() => {
                wroteCredentials = true;
              }),
          }),
          Layer.succeed(EnvironmentService, {
            ...services.environment,
            cwd: Effect.succeed(root),
            platform: Effect.succeed("linux" as NodeJS.Platform),
            get: () => Effect.succeed(undefined),
          }),
          Layer.succeed(ProcessService, {
            ...services.processes,
            run: (request) =>
              request.command !== "xdg-open"
                ? services.processes.run(request)
                : mode === "error"
                  ? Effect.fail(
                      new ProcessExecutionError({
                        command: request.command,
                        message: "synthetic browser launch failure",
                      }),
                    )
                  : Effect.succeed({
                      exitCode: 1,
                      stdout: "",
                      stderr: "synthetic browser launch failure",
                      combinedOutput: "synthetic browser launch failure",
                    }),
            spawnDetached: () => Effect.succeed(12_347),
          }),
          Layer.succeed(RandomnessService, {
            uuidV7: Effect.succeed(state),
          }),
          Layer.succeed(TerminalService, {
            ...services.terminal,
            stdinIsTerminal: Effect.succeed(true),
            writeStdout: (text) =>
              Effect.sync(() => {
                output += text;
              }),
            writeStderr: () => Effect.void,
          }),
        );
        const fiber = Effect.runFork(
          Effect.either(
            executeHostedCommand("login", [
              "--login=https://login.example.test",
              `--cwd=${root}`,
            ]).pipe(
              Effect.provide(overrides),
              Effect.provide(nodeFoundationLayer),
            ),
          ),
        );
        try {
          const result = await Promise.race([
            Effect.runPromise(Fiber.join(fiber)),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("failed browser login remained open")),
                10_000,
              ),
            ),
          ]);
          expect(result).toMatchObject({
            _tag: "Left",
            left: {
              message:
                "interactive login cannot open a browser; use --manual with --token or TURBO_TOKEN",
            },
          });
          expect(wroteCredentials).toBe(false);
          expect(output).toContain("Opening browser for turbo-ts login.");
          expect(output).not.toContain(state);
          expect(output).not.toContain("login.example.test");
        } finally {
          await Effect.runPromise(Fiber.interrupt(fiber));
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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

  it("reads configuration through one bounded validated handle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-config-handle-"));
    const root = join(directory, "repository");
    const configurationHome = join(directory, "configuration");
    const credentialDirectory = join(configurationHome, "turborepo");
    const credentialPath = join(credentialDirectory, "config.json");
    const replacementPath = join(directory, "replacement.json");
    const original = JSON.stringify({ value: "original" });
    await prepareRepository(root);
    await mkdir(credentialDirectory, { recursive: true });
    await writeFile(credentialPath, original);
    await writeFile(replacementPath, JSON.stringify({ value: "replacement" }));
    const originalHandle = await open(credentialPath, "r");
    try {
      await rename(replacementPath, credentialPath);
      expect(await readBoundedConfigurationHandle(originalHandle)).toBe(
        original,
      );
    } finally {
      await originalHandle.close();
    }

    const oversizedPath = join(directory, "oversized.json");
    await writeFile(oversizedPath, Buffer.alloc(1024 * 1024 + 1, "x"));
    const oversizedHandle = await open(oversizedPath, "r");
    try {
      await expect(
        readBoundedConfigurationHandle(oversizedHandle),
      ).rejects.toThrow("configuration file exceeds the 1 MiB limit");
    } finally {
      await oversizedHandle.close();
    }

    try {
      if (process.platform !== "win32") {
        const outsidePath = join(directory, "outside.json");
        const secret = "synthetic-symlink-secret";
        await writeFile(outsidePath, JSON.stringify({ token: secret }));
        await rm(credentialPath);
        await symlink(outsidePath, credentialPath, "file");
        const symlinked = await runCandidate(
          ["logout", "--invalidate=false", `--cwd=${root}`],
          root,
          { XDG_CONFIG_HOME: configurationHome },
        );
        expect(symlinked.code).toBe(1);
        expect(symlinked.stderr).toContain(
          "credential configuration operation failed",
        );
        expect(`${symlinked.stdout}${symlinked.stderr}`).not.toContain(secret);
      }
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

  it("requires absolute credential configuration directories", () => {
    expect(
      resolveUserConfigurationDirectory(
        { HOME: ".", XDG_CONFIG_HOME: ".config" },
        "linux",
        "/system/home",
      ),
    ).toBe("/system/home/.config/turborepo");
    expect(
      resolveUserConfigurationDirectory(
        { HOME: ".", XDG_CONFIG_HOME: ".config" },
        "darwin",
        "/system/home",
      ),
    ).toBe("/system/home/Library/Application Support/turborepo");
    expect(
      resolveUserConfigurationDirectory(
        { APPDATA: ".appdata", HOME: "." },
        "win32",
        "C:\\system-home",
      ),
    ).toBe("C:\\system-home\\AppData\\Roaming\\turborepo");
    expect(
      resolveUserConfigurationDirectory(
        { XDG_CONFIG_HOME: "/custom/configuration" },
        "linux",
        "/system/home",
      ),
    ).toBe("/custom/configuration/turborepo");
    expect(() =>
      resolveUserConfigurationDirectory({}, "linux", ".system-home"),
    ).toThrow("system home directory must be absolute");
  });

  it("rejects symlinked project configuration directories", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-project-config-"));
    const root = join(directory, "repository");
    const outside = join(directory, "outside");
    const outsideConfiguration = join(outside, "config.json");
    await prepareRepository(root);
    await mkdir(outside, { recursive: true });
    await writeFile(
      outsideConfiguration,
      JSON.stringify({ sentinel: "retained" }),
    );
    await symlink(outside, join(root, ".turbo"), "dir");
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
              ? [200, { "content-type": "application/json" }, '{"teams":[]}']
              : request.url?.startsWith("/v8/artifacts/status") === true
                ? [
                    200,
                    { "content-type": "application/json" },
                    '{"status":"enabled"}',
                  ]
                : [404, {}, "not found"],
        async (baseUrl) => {
          const link = await runCandidate(
            [
              "link",
              "--scope=synthetic-user",
              "--yes",
              "--token=synthetic-token",
              `--api=${baseUrl}`,
              `--cwd=${root}`,
            ],
            root,
          );
          expect(link.code).toBe(1);
          expect(link.stderr).toContain(
            "credential configuration operation failed",
          );
          expect(
            JSON.parse(await readFile(outsideConfiguration, "utf8")),
          ).toEqual({ sentinel: "retained" });

          const unlink = await runCandidate(["unlink", `--cwd=${root}`], root);
          expect(unlink.code).toBe(1);
          expect(unlink.stderr).toContain(
            "credential configuration operation failed",
          );
          expect(
            JSON.parse(await readFile(outsideConfiguration, "utf8")),
          ).toEqual({ sentinel: "retained" });
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not initialize remote cache for local-only and non-executing runs", async () => {
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
      for (const mode of ["--dry-run=json", "--graph"] as const) {
        const nonExecuting = await runCandidate(
          ["run", "build", "--filter=synthetic-app", mode, `--cwd=${root}`],
          root,
          { XDG_CONFIG_HOME: configurationHome },
        );
        expect(nonExecuting.code, nonExecuting.stderr).toBe(0);
      }

      await writeFile(projectPath, "{}");
      const unlinked = await runCandidate(
        ["run", "build", "--filter=synthetic-app", `--cwd=${root}`],
        root,
        { XDG_CONFIG_HOME: configurationHome },
      );
      expect(unlinked.code, unlinked.stderr).toBe(0);

      await writeFile(
        join(root, "turbo.json"),
        JSON.stringify({
          remoteCache: { enabled: false },
          tasks: { build: {} },
        }),
      );
      const configurationDisabled = await runCandidate(
        ["run", "build", "--filter=synthetic-app", `--cwd=${root}`],
        root,
        { XDG_CONFIG_HOME: configurationHome },
      );
      expect(configurationDisabled.code, configurationDisabled.stderr).toBe(0);

      const cacheDisabled = await runCandidate(
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
      expect(cacheDisabled.code, cacheDisabled.stderr).toBe(0);

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
          await writeFile(
            join(root, "turbo.json"),
            JSON.stringify({ tasks: { build: {} } }),
          );
          for (const mode of ["--dry-run=json", "--graph"] as const) {
            const nonExecuting = await runCandidate(
              ["run", "build", "--filter=synthetic-app", mode, `--cwd=${root}`],
              root,
              { XDG_CONFIG_HOME: configurationHome },
            );
            expect(nonExecuting.code, nonExecuting.stderr).toBe(0);
          }
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

  it("skips project credentials for a fully explicit remote connection", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "turbo-ts-explicit-remote-"),
    );
    const root = join(directory, "repository");
    await prepareRepository(root);
    await mkdir(join(root, ".turbo"), { recursive: true });
    await writeFile(join(root, ".turbo/config.json"), "invalid credentials");
    try {
      await withServer(
        (request) =>
          request.url?.startsWith("/v8/artifacts/status") === true
            ? [
                200,
                { "content-type": "application/json" },
                '{"status":"enabled"}',
              ]
            : request.url?.startsWith("/v8/artifacts/events") === true
              ? [201, {}, ""]
              : request.method === "GET" &&
                  request.url?.startsWith("/v8/artifacts/") === true
                ? [404, {}, ""]
                : [500, {}, "unexpected hosted request"],
        async (baseUrl, requests) => {
          const result = await runCandidate(
            [
              "run",
              "build",
              "--filter=synthetic-app",
              "--cache=remote:r",
              "--output-logs=none",
              `--api=${baseUrl}`,
              "--token=synthetic-token",
              "--team=synthetic-team",
              `--cwd=${root}`,
            ],
            root,
          );
          expect(result.code, result.stderr).toBe(0);
          expect(
            requests.some(
              (request) =>
                request.method === "GET" &&
                request.path.startsWith("/v8/artifacts/status") &&
                request.path.includes("slug=synthetic-team"),
            ),
          ).toBe(true);
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("secondary command and parser compatibility", () => {
  it("rejects attached values for the manual login flag", () => {
    for (const attachedManual of [
      "--manual=",
      "--manual=false",
      "--manual=true",
    ]) {
      expect(() => parseHostedArguments("login", [attachedManual])).toThrow(
        "does not accept a value",
      );
    }
  });

  it("uses the environment timeout for documentation requests", async () => {
    const services = await Effect.runPromise(
      Effect.gen(function* () {
        return {
          environment: yield* EnvironmentService,
          http: yield* HttpService,
          terminal: yield* TerminalService,
        };
      }).pipe(Effect.provide(nodeFoundationLayer)),
    );
    const requests: Array<HttpRequest> = [];
    const runDocs = (timeout: string) =>
      Effect.runPromise(
        executeSecondaryCommand("docs", ["synthetic query"]).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(EnvironmentService, {
                ...services.environment,
                get: (name) =>
                  Effect.succeed(
                    name === "TURBO_REMOTE_CACHE_TIMEOUT"
                      ? timeout
                      : name === "TURBO_TS_DOCS_ENDPOINT"
                        ? "https://docs.example.test/search"
                        : undefined,
                  ),
              }),
              Layer.succeed(HttpService, {
                ...services.http,
                request: (request) =>
                  Effect.sync(() => {
                    requests.push(request);
                    return {
                      status: 200,
                      headers: {},
                      body: new TextEncoder().encode('{"results":[]}'),
                    };
                  }),
              }),
              Layer.succeed(TerminalService, {
                ...services.terminal,
                writeStdout: () => Effect.void,
              }),
            ),
          ),
          Effect.provide(nodeFoundationLayer),
        ),
      );

    const success = await runDocs("0.0004");
    expect(success).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.timeoutMilliseconds).toBe(1);

    await expect(runDocs("invalid")).rejects.toThrow(
      "invalid remote cache timeout",
    );
    expect(requests).toHaveLength(1);
  });

  it("resolves and validates TURBO_UI for config output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-config-ui-"));
    const root = join(directory, "repository");
    await prepareRepository(root);
    try {
      const environmentUi = await runCandidate(
        ["config", `--cwd=${root}`],
        root,
        { TURBO_UI: "tui" },
      );
      expect(environmentUi.code).toBe(0);
      expect(JSON.parse(environmentUi.stdout).ui).toBe("tui");

      const invalidEnvironmentUi = await runCandidate(
        ["config", `--cwd=${root}`],
        root,
        { TURBO_UI: "invalid" },
      );
      expect(invalidEnvironmentUi.code).toBe(1);
      expect(invalidEnvironmentUi.stderr).toContain("invalid UI mode");

      const explicitUi = await runCandidate(
        ["config", "--ui=stream", `--cwd=${root}`],
        root,
        { TURBO_UI: "invalid" },
      );
      expect(explicitUi.code).toBe(0);
      expect(JSON.parse(explicitUi.stdout).ui).toBe("stream");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

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
        "--skip-infer",
        "--cache-workers=4",
        "--daemon",
        "--no-daemon",
        "--dry=json",
      ]),
    ).toMatchObject({
      cacheWorkers: 4,
      daemonPreference: false,
      dryRun: "json",
      frameworkInference: false,
      tasks: ["build"],
    });
    expect(
      parseHostedArguments("logout", ["--invalidate", "false"]),
    ).toMatchObject({ invalidate: false });
    expect(parseHostedArguments("link", ["--yes"])).toMatchObject({
      yes: true,
    });
    expect(parseHostedArguments("link", ["-y"])).toMatchObject({ yes: true });
    for (const attachedYes of [
      "--yes=false",
      "--yes=true",
      "-y=false",
      "-y=true",
    ]) {
      expect(() => parseHostedArguments("link", [attachedYes])).toThrow(
        "does not accept a value",
      );
    }
    for (const attachedNoGitignore of [
      "--no-gitignore=",
      "--no-gitignore=false",
      "--no-gitignore=true",
    ]) {
      expect(() => parseHostedArguments("link", [attachedNoGitignore])).toThrow(
        "does not accept a value",
      );
    }
    for (const attachedBypass of [
      "--dangerously-disable-package-manager-check=false",
      "--dangerously-disable-package-manager-check=true",
    ]) {
      expect(() => parseCommonArguments([attachedBypass])).toThrow(
        "does not accept a value",
      );
    }
    for (const attachedSkipInfer of [
      "--skip-infer=",
      "--skip-infer=false",
      "--skip-infer=true",
    ]) {
      expect(() => parseCommonArguments([attachedSkipInfer])).toThrow(
        "does not accept a value",
      );
    }
    for (const attachedPreflight of [
      "--preflight=",
      "--preflight=false",
      "--preflight=true",
    ]) {
      expect(() => parseCommonArguments([attachedPreflight])).toThrow(
        "does not accept a value",
      );
    }
    expect(parseDevtoolsArguments(["--no-open"]).noOpen).toBe(true);
    for (const attachedNoOpen of [
      "--no-open=",
      "--no-open=false",
      "--no-open=true",
    ]) {
      expect(() => parseDevtoolsArguments([attachedNoOpen])).toThrow(
        "does not accept a value",
      );
    }
    expect(
      parseCommonArguments(["--experimental-otel-timeout-ms=2147483647"])
        .options.openTelemetry.timeoutMilliseconds,
    ).toBe(2_147_483_647);
    expect(() =>
      parseCommonArguments(["--experimental-otel-timeout-ms=2147483648"]),
    ).toThrow("invalid OTLP timeout: 2147483648");
    expect(
      parseCommonArguments(["--experimental-otel-interval-ms=2147483647"])
        .options.openTelemetry.intervalMilliseconds,
    ).toBe(2_147_483_647);
    expect(() =>
      parseCommonArguments(["--experimental-otel-interval-ms=2147483648"]),
    ).toThrow("invalid OTLP interval: 2147483648");
    expect(resolveHostedTimeoutMilliseconds(undefined, "12.5")).toBe(12_500);
    expect(resolveHostedTimeoutMilliseconds(1.25, "12.5")).toBe(1_250);
    expect(resolveHostedTimeoutMilliseconds(0.0004, undefined)).toBe(1);
    expect(resolveHostedTimeoutMilliseconds(undefined, "0.0004")).toBe(1);
    expect(resolveHostedTimeoutMilliseconds(undefined, undefined)).toBe(30_000);
    expect(resolveHostedTimeoutMilliseconds(undefined, "0")).toBe(0);
    expect(resolveHostedTimeoutMilliseconds(undefined, "2147483.647")).toBe(
      2_147_483_647,
    );
    for (const invalid of ["", "-1", "NaN", "Infinity", "2147483.648"]) {
      expect(() =>
        resolveHostedTimeoutMilliseconds(undefined, invalid),
      ).toThrow("invalid remote cache timeout");
    }
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
    for (const attachedEmpty of ["--empty=false", "-b=false"]) {
      expect(() =>
        parseGenerateArguments(["workspace", attachedEmpty]),
      ).toThrow("does not accept a value");
    }
    for (const invalidType of ["--type=service", "-t=service"]) {
      expect(() => parseGenerateArguments(["workspace", invalidType])).toThrow(
        "invalid workspace type: service",
      );
    }
    expect(
      selectCurrentPackage(
        [
          {
            canonicalRelativeDirectory: ".",
            directory: "C:/synthetic/repository",
          },
          {
            canonicalRelativeDirectory: "packages/app",
            directory: "C:/synthetic/repository/packages/app",
          },
        ],
        "c:\\SYNTHETIC\\repository\\packages\\app\\src",
        "C:/synthetic/repository",
        true,
      ),
    ).toEqual({
      canonicalRelativeDirectory: "packages/app",
      directory: "C:/synthetic/repository/packages/app",
    });

    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-secondary-"));
    const root = join(directory, "repository");
    await prepareRepository(root);
    await mkdir(join(root, "packages/library"), { recursive: true });
    await writeFile(
      join(root, "packages/app/package.json"),
      JSON.stringify({
        name: "synthetic-app",
        private: true,
        scripts: { build: 'node -e ""' },
        dependencies: { "synthetic-library": "workspace:*" },
      }),
    );
    await writeFile(
      join(root, "packages/app/turbo.json"),
      JSON.stringify({
        extends: ["//"],
        tags: ["app"],
        boundaries: { dependencies: { deny: ["library"] } },
      }),
    );
    await writeFile(
      join(root, "packages/library/package.json"),
      JSON.stringify({ name: "synthetic-library", private: true }),
    );
    await writeFile(
      join(root, "packages/library/turbo.json"),
      JSON.stringify({
        extends: ["//"],
        tags: ["library"],
        boundaries: { dependents: { deny: ["app"] } },
      }),
    );
    await writeFile(
      join(root, "microfrontends.json"),
      JSON.stringify({
        applications: {
          "synthetic-hosted-root": {
            packageName: "//",
            development: { local: { port: 4000 } },
          },
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

      const absoluteDestination = join(root, "packages/generated-absolute");
      const generatedAbsolute = await runCandidate(
        [
          "generate",
          "workspace",
          "--name=generated-absolute",
          "--empty",
          `--destination=${absoluteDestination}`,
          `--root=${root}`,
        ],
        root,
      );
      expect(generatedAbsolute.code, generatedAbsolute.stderr).toBe(0);
      expect(
        JSON.parse(
          await readFile(join(absoluteDestination, "package.json"), "utf8"),
        ),
      ).toMatchObject({ name: "generated-absolute", private: true });

      const invalidTypeDestination = "packages/generated-service";
      const invalidType = await runCandidate(
        [
          "generate",
          "workspace",
          "--name=generated-service",
          "--empty",
          "--type=service",
          `--destination=${invalidTypeDestination}`,
          `--root=${root}`,
        ],
        root,
      );
      expect(invalidType.code).toBe(1);
      expect(invalidType.stderr).toContain("invalid workspace type: service");
      await expect(
        access(join(root, invalidTypeDestination)),
      ).rejects.toThrow();

      for (const [name, destination] of [
        ["@bad scope/pkg", "packages/invalid-scoped-space"],
        ["UPPERCASE", "packages/invalid-uppercase"],
      ] as const) {
        const invalidName = await runCandidate(
          [
            "generate",
            "workspace",
            `--name=${name}`,
            "--empty",
            `--destination=${destination}`,
            `--root=${root}`,
          ],
          root,
        );
        expect(invalidName.code).toBe(1);
        expect(invalidName.stderr).toContain(
          "workspace generation requires a valid --name",
        );
        await expect(access(join(root, destination))).rejects.toThrow();
      }
      for (const name of [
        "node_modules",
        "favicon.ico",
        "http",
        "workspace~name",
      ]) {
        const destination = join(
          root,
          "packages",
          name.replace(/^@[^/]+\//, ""),
        );
        const invalidName = await runCandidate(
          [
            "generate",
            "workspace",
            `--name=${name}`,
            "--empty",
            `--root=${root}`,
          ],
          root,
        );
        expect(invalidName.code).toBe(1);
        expect(invalidName.stderr).toContain(
          "workspace generation requires a valid --name",
        );
        await expect(access(destination)).rejects.toThrow();
      }
      const scopedWorkspace = await runCandidate(
        [
          "generate",
          "workspace",
          "--name=@valid-scope/generated-scoped",
          "--empty",
          "--destination=packages/generated-scoped",
          `--root=${root}`,
        ],
        root,
      );
      expect(scopedWorkspace.code, scopedWorkspace.stderr).toBe(0);
      expect(
        JSON.parse(
          await readFile(
            join(root, "packages/generated-scoped/package.json"),
            "utf8",
          ),
        ).name,
      ).toBe("@valid-scope/generated-scoped");

      const sourceManifestPath = join(root, "packages/library/package.json");
      const sourceManifest = JSON.parse(
        await readFile(sourceManifestPath, "utf8"),
      ) as Record<string, unknown>;
      const copied = await runCandidate(
        [
          "generate",
          "workspace",
          "--name=generated-copy",
          "--copy=packages/library",
          "--destination=packages/generated-copy",
          `--root=${root}`,
        ],
        root,
      );
      expect(copied.code, copied.stderr).toBe(0);
      expect(
        JSON.parse(
          await readFile(
            join(root, "packages/generated-copy/package.json"),
            "utf8",
          ),
        ),
      ).toEqual({ ...sourceManifest, name: "generated-copy" });
      expect(JSON.parse(await readFile(sourceManifestPath, "utf8"))).toEqual(
        sourceManifest,
      );

      if (process.platform !== "win32") {
        const unsupportedTemplateEntry = join(
          root,
          "packages/library/z-unsupported-link",
        );
        await symlink("package.json", unsupportedTemplateEntry, "file");
        const failedCopyArguments = [
          "generate",
          "workspace",
          "--name=generated-after-failure",
          "--copy=packages/library",
          "--destination=packages/generated-after-failure",
          `--root=${root}`,
        ];
        const failedCopy = await runCandidate(failedCopyArguments, root);
        expect(failedCopy.code).toBe(1);
        expect(failedCopy.stderr).toContain(
          "template contains unsupported entry",
        );
        await expect(
          access(join(root, "packages/generated-after-failure")),
        ).rejects.toThrow();
        await rm(unsupportedTemplateEntry);
        const retriedCopy = await runCandidate(failedCopyArguments, root);
        expect(retriedCopy.code, retriedCopy.stderr).toBe(0);
      }

      const fileSystem = await Effect.runPromise(
        FileSystemService.pipe(Effect.provide(nodeFoundationLayer)),
      );
      const racedDestination = join(root, "packages/raced-destination");
      const marker = join(racedDestination, "other-process.txt");
      const racedFileSystemLayer = Layer.succeed(FileSystemService, {
        ...fileSystem,
        createExclusiveDirectory: (path) =>
          path === racedDestination
            ? fileSystem
                .makeDirectory(path)
                .pipe(
                  Effect.zipRight(
                    fileSystem.writeText(marker, "created elsewhere\n"),
                  ),
                  Effect.as(false),
                )
            : fileSystem.createExclusiveDirectory(path),
      });
      const racedGeneration = await Effect.runPromise(
        Effect.either(
          executeGenerate([
            "workspace",
            "--name=raced-destination",
            "--empty",
            "--destination=packages/raced-destination",
            `--root=${root}`,
          ]).pipe(
            Effect.provide(racedFileSystemLayer),
            Effect.provide(nodeFoundationLayer),
          ),
        ),
      );
      expect(racedGeneration._tag).toBe("Left");
      expect(await readFile(marker, "utf8")).toBe("created elsewhere\n");

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

      if (process.platform !== "win32") {
        const linkedTarget = join(root, "linked-app-target");
        const linkedWorkspace = join(root, "packages/linked-app");
        await mkdir(linkedTarget, { recursive: true });
        await writeFile(
          join(linkedTarget, "package.json"),
          JSON.stringify({ name: "synthetic-linked-app", private: true }),
        );
        await writeFile(
          join(linkedTarget, "microfrontends.json"),
          JSON.stringify({
            applications: {
              "synthetic-linked-app": {
                development: { local: { port: 4234 } },
              },
            },
          }),
        );
        await symlink("../linked-app-target", linkedWorkspace, "dir");
        const linkedMfe = await runCandidate(
          ["get-mfe-port", "--cwd=packages/linked-app"],
          root,
        );
        expect(linkedMfe).toMatchObject({ code: 0, stdout: "4234\n" });
      }

      const mfe = await runCandidate(
        ["get-mfe-port", "--cwd=packages/app"],
        root,
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
        ["get-mfe-port", "--cwd=packages/app"],
        root,
      );
      expect(generatedMfe).toMatchObject({ code: 0, stdout: "6697\n" });
      await rm(join(root, "packages/app/microfrontends.json"));
      const inheritedMfe = await runCandidate(
        ["get-mfe-port", "--cwd=packages/app"],
        root,
      );
      expect(inheritedMfe).toMatchObject({ code: 0, stdout: "4001\n" });
      const rootMfe = await runCandidate(
        ["get-mfe-port", `--cwd=${root}`],
        root,
      );
      expect(rootMfe).toMatchObject({ code: 0, stdout: "4000\n" });

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
        uploadTimeout: 30,
        ui: "stream",
      });
      const apiCredential = "synthetic-api-password";
      const unsafeEnvironmentConfiguration = await runCandidate(
        ["config", `--cwd=${root}`],
        root,
        { TURBO_API: `https://user:${apiCredential}@example.test` },
      );
      expect(unsafeEnvironmentConfiguration.code).toBe(1);
      expect(
        `${unsafeEnvironmentConfiguration.stdout}${unsafeEnvironmentConfiguration.stderr}`,
      ).not.toContain(apiCredential);
      await mkdir(join(root, ".turbo"), { recursive: true });
      await writeFile(
        join(root, ".turbo/config.json"),
        JSON.stringify({
          apiUrl: `https://user:${apiCredential}@example.test`,
        }),
      );
      const unsafeProjectConfiguration = await runCandidate(
        ["config", `--cwd=${root}`],
        root,
      );
      expect(unsafeProjectConfiguration.code).toBe(1);
      expect(
        `${unsafeProjectConfiguration.stdout}${unsafeProjectConfiguration.stderr}`,
      ).not.toContain(apiCredential);
      await writeFile(
        join(root, ".turbo/config.json"),
        JSON.stringify({ teamId: "stored-team-id", teamSlug: "stored-team" }),
      );
      const explicitTeamConfiguration = await runCandidate(
        ["config", "--team=explicit-team", `--cwd=${root}`],
        root,
      );
      expect(JSON.parse(explicitTeamConfiguration.stdout)).toMatchObject({
        teamId: null,
        teamSlug: "explicit-team",
      });
      const environmentConfiguration = await runCandidate(
        ["config", `--cwd=${root}`],
        root,
        {
          TURBO_CACHE_DIR: "environment-cache",
          TURBO_CONCURRENCY: "75%",
          TURBO_REMOTE_CACHE_TIMEOUT: "12.5",
          TURBO_REMOTE_CACHE_UPLOAD_TIMEOUT: "45",
          TURBO_TEAM: "environment-team",
        },
      );
      expect(JSON.parse(environmentConfiguration.stdout)).toMatchObject({
        cacheDir: "environment-cache",
        concurrency: "75%",
        teamId: null,
        teamSlug: "environment-team",
        timeout: 12.5,
        uploadTimeout: 45,
      });
      const invalidConfigTimeout = await runCandidate(
        ["config", `--cwd=${root}`],
        root,
        { TURBO_REMOTE_CACHE_UPLOAD_TIMEOUT: "invalid" },
      );
      expect(invalidConfigTimeout.code).toBe(1);
      expect(invalidConfigTimeout.stderr).toContain(
        "invalid remote cache upload timeout",
      );
      const overLimitConfigTimeout = await runCandidate(
        ["config", `--cwd=${root}`],
        root,
        { TURBO_REMOTE_CACHE_TIMEOUT: "2147483.648" },
      );
      expect(overLimitConfigTimeout.code).toBe(1);
      expect(overLimitConfigTimeout.stderr).toContain(
        "invalid remote cache timeout",
      );
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
      const acceptedPrompt = await promptForBoundaries(root, "yes");
      expect(acceptedPrompt.code).toBe(0);
      expect(acceptedPrompt.prompts).toEqual([
        "Ignore 2 boundary violations? [y/N] ",
      ]);
      const declinedPrompt = await promptForBoundaries(root, "no");
      expect(declinedPrompt.code).toBe(1);
      expect(declinedPrompt.prompts).toHaveLength(1);
      const emptyPrompt = await promptForBoundaries(root, "yes", "//");
      expect(emptyPrompt).toEqual({ code: 0, prompts: [] });
      const nonInteractivePrompt = await runCandidate(
        [
          "boundaries",
          "--ignore=prompt",
          "--reason=synthetic",
          `--cwd=${root}`,
        ],
        root,
      );
      expect(nonInteractivePrompt.code).toBe(1);
      expect(nonInteractivePrompt.stderr).toContain(
        "prompt ignore mode requires an interactive terminal",
      );
      const filteredBoundaries = await runCandidate(
        ["boundaries", "--filter={./packages/app}", `--cwd=${root}`],
        root,
      );
      expect(filteredBoundaries.code).toBe(1);
      expect(filteredBoundaries.stderr).toContain(
        "denylist for `synthetic-app`",
      );
      expect(filteredBoundaries.stderr).not.toContain(
        "denylist for `synthetic-library`",
      );
      for (const mode of [
        "browser",
        "no-open",
        "unavailable",
        "failure",
        "nonzero",
      ] as const) {
        await exerciseDevtools(root, mode);
      }

      await withServer(
        (request) =>
          request.url?.startsWith("/search?") === true
            ? [
                200,
                { "content-type": "application/json" },
                JSON.stringify({
                  results: [
                    {
                      title: "Malformed remote result",
                      url: "http://[",
                    },
                    {
                      title:
                        "Synthetic\u001b]52;c;payload\u0007\u009b31m guide",
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
          expect(docs.stdout).not.toContain("Malformed remote result");
          expect(docs.stdout).toContain(
            "Synthetic\\u001b]52;c;payload\\u0007\\u009b31m guide",
          );
          expect(docs.stdout).not.toContain("\u001B");
          expect(docs.stdout).not.toContain("\u0007");
          expect(docs.stdout).not.toContain("\u009B");
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

  it("cleans up a workspace destination after malformed template JSON", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "turbo-ts-generator-malformed-template-"),
    );
    const root = join(directory, "repository");
    const template = join(root, "templates/malformed");
    const destination = join(root, "packages/generated-malformed");
    await prepareRepository(root);
    await mkdir(template, { recursive: true });
    await writeFile(join(template, "package.json"), "{malformed");
    const arguments_ = [
      "generate",
      "workspace",
      "--name=generated-malformed",
      "--copy=templates/malformed",
      "--destination=packages/generated-malformed",
      `--root=${root}`,
    ];
    try {
      const failed = await runCandidate(arguments_, root);
      expect(failed.code).toBe(1);
      await expect(access(destination)).rejects.toThrow();

      await writeFile(
        join(template, "package.json"),
        JSON.stringify({ private: true }),
      );
      const retried = await runCandidate(arguments_, root);
      expect(retried.code, retried.stderr).toBe(0);
      expect(
        JSON.parse(await readFile(join(destination, "package.json"), "utf8")),
      ).toEqual({ private: true, name: "generated-malformed" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid explicit generator roots before materialization", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "turbo-ts-generator-invalid-root-"),
    );
    const missingRoot = join(directory, "missing-root");
    const fileRoot = join(directory, "file-root");
    await writeFile(fileRoot, "not a directory\n");
    try {
      const missing = await runCandidate(
        [
          "generate",
          "workspace",
          "--name=generated-missing-root",
          "--empty",
          `--root=${missingRoot}`,
        ],
        directory,
      );
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("working directory does not exist");
      await expect(access(missingRoot)).rejects.toThrow();

      const notDirectory = await runCandidate(
        [
          "generate",
          "workspace",
          "--name=generated-file-root",
          "--empty",
          `--root=${fileRoot}`,
        ],
        directory,
      );
      expect(notDirectory.code).toBe(1);
      expect(notDirectory.stderr).toContain(
        "working directory is not a directory",
      );
      expect(await readFile(fileRoot, "utf8")).toBe("not a directory\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("collects unresolved generator prompts before evaluating actions", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "turbo-ts-generator-prompt-"),
    );
    const root = join(directory, "repository");
    await prepareRepository(root);
    await mkdir(join(root, "turbo/generators"), { recursive: true });
    await writeFile(
      join(root, "turbo/generators/config.mjs"),
      `export default (api) => api.setGenerator("prompted", {
  prompts: [{ type: "input", name: "feature", message: "Feature name" }],
  actions: (answers) => [{ type: "add", path: "generated/{{feature}}.txt", template: "{{feature}}" }],
});\n`,
    );
    try {
      const terminal = await Effect.runPromise(
        TerminalService.pipe(Effect.provide(nodeFoundationLayer)),
      );
      const prompts: Array<string> = [];
      const terminalLayer = (interactive: boolean, answer = "") =>
        Layer.succeed(TerminalService, {
          ...terminal,
          stdinIsTerminal: Effect.succeed(interactive),
          readLine: (prompt) =>
            Effect.sync(() => {
              prompts.push(prompt);
              return answer;
            }),
          writeStdout: () => Effect.void,
          writeStderr: () => Effect.void,
        });
      const execute = (
        arguments_: ReadonlyArray<string>,
        interactive: boolean,
        answer?: string,
      ) =>
        Effect.runPromise(
          Effect.either(
            executeGenerate([...arguments_, `--root=${root}`]).pipe(
              Effect.provide(terminalLayer(interactive, answer)),
              Effect.provide(nodeFoundationLayer),
            ),
          ),
        );

      const nonInteractive = await execute(["prompted"], false);
      expect(nonInteractive).toMatchObject({
        _tag: "Left",
        left: {
          message:
            "generator prompts require an interactive terminal or supplied --args",
        },
      });
      await expect(access(join(root, "generated/.txt"))).rejects.toThrow();

      const interactive = await execute(["prompted"], true, "widget");
      expect(interactive).toMatchObject({ _tag: "Right", right: 0 });
      expect(prompts).toEqual(["Feature name: "]);
      expect(await readFile(join(root, "generated/widget.txt"), "utf8")).toBe(
        "widget",
      );

      const supplied = await execute(
        ["prompted", "--args=feature=supplied"],
        false,
      );
      expect(supplied).toMatchObject({ _tag: "Right", right: 0 });
      expect(prompts).toEqual(["Feature name: "]);
      expect(await readFile(join(root, "generated/supplied.txt"), "utf8")).toBe(
        "supplied",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("separates configured generator output from its result protocol", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "turbo-ts-generator-output-"),
    );
    const root = join(directory, "repository");
    await prepareRepository(root);
    await mkdir(join(root, "turbo/generators"), { recursive: true });
    await writeFile(
      join(root, "turbo/generators/config.mjs"),
      `export default (api) => {
  console.log("generator configuration log");
  api.setGenerator("logged", {
    actions: () => {
      console.log("generator action log");
      console.error("generator action warning");
      return [{ type: "add", path: "generated/logged.txt", template: "logged" }];
    },
  });
};
`,
    );
    try {
      const result = await runCandidate(
        ["generate", "logged", `--root=${root}`],
        root,
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("generator configuration log");
      expect(result.stdout).toContain("generator action log");
      expect(result.stderr).toContain("generator action warning");
      expect(result.stdout).not.toContain("turbo-ts-generator-result");
      expect(await readFile(join(root, "generated/logged.txt"), "utf8")).toBe(
        "logged",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("validates effective login URLs before rendering config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-config-login-"));
    const root = join(directory, "repository");
    const credential = "synthetic-login-password";
    const unsafeLoginUrl = `https://user:${credential}@example.test`;
    await prepareRepository(root);
    const assertRejected = async (
      arguments_: ReadonlyArray<string>,
      environment: NodeJS.ProcessEnv = {},
    ) => {
      const result = await runCandidate(arguments_, root, environment);
      expect(result.code).toBe(1);
      expect(`${result.stdout}${result.stderr}`).not.toContain(credential);
    };
    try {
      await assertRejected([
        "config",
        `--login=${unsafeLoginUrl}`,
        `--cwd=${root}`,
      ]);
      await assertRejected(["config", `--cwd=${root}`], {
        TURBO_LOGIN: unsafeLoginUrl,
      });
      const configurationPath = join(root, "turbo.json");
      const configuration = JSON.parse(
        await readFile(configurationPath, "utf8"),
      ) as Record<string, unknown>;
      configuration.remoteCache = { loginUrl: unsafeLoginUrl };
      await writeFile(configurationPath, JSON.stringify(configuration));
      await assertRejected(["config", `--cwd=${root}`]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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

  it("recovers telemetry opt-out from invalid persisted state", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "turbo-ts-telemetry-invalid-"),
    );
    const root = join(directory, "repository");
    const configurationHome = join(directory, "configuration");
    const environment = {
      XDG_CONFIG_HOME: configurationHome,
      TURBO_TELEMETRY_DISABLED: "0",
    };
    const path = join(configurationHome, "turborepo/telemetry.json");
    await prepareRepository(root);
    await mkdir(join(configurationHome, "turborepo"), { recursive: true });
    try {
      for (const [invalidState, strictCommand] of [
        ["{", "status"],
        [JSON.stringify({ telemetry_enabled: "invalid" }), "enable"],
      ] as const) {
        await writeFile(path, invalidState);
        const strict = await runCandidate(
          ["telemetry", strictCommand],
          root,
          environment,
        );
        expect(strict.code).toBe(1);
        const recovered = await runCandidate(
          ["telemetry", "disable"],
          root,
          environment,
        );
        expect(recovered.code).toBe(0);
        expect(recovered.stdout).toContain("Status: Disabled");
        expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
          telemetry_enabled: false,
          telemetry_id: expect.stringMatching(/^[0-9a-f]{64}$/),
          telemetry_salt: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          ),
        });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);
});

describe("terminal-safe text", () => {
  it("encodes C0 and C1 controls in remote display values", () => {
    expect(
      renderTerminalSafeText(
        "https://example.invalid/\u0000\u001b\u007f\u009bguide",
      ),
    ).toBe("https://example.invalid/\\u0000\\u001b\\u007f\\u009bguide");
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
            return statusAttempts < 3
              ? emptyResponse(429)
              : {
                  ...emptyResponse(),
                  body: new TextEncoder().encode('{"status":"enabled"}'),
                };
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
        const enabled = yield* verifyRemoteCacheStatus(options);
        const present = yield* headRemoteCache(options, "synthetic-hash");
        yield* headRemoteCache(
          { ...options, teamId: undefined, teamSlug: "other-synthetic" },
          "synthetic-hash",
        );
        yield* recordRemoteCacheEvent(options, "synthetic-hash", "MISS");
        yield* recordRemoteCacheEvent(options, "synthetic-hash", "HIT");
        return { enabled, present };
      }).pipe(Effect.provide(Layer.merge(httpLayer, deterministicRetryLayer))),
    );
    expect(result).toEqual({ enabled: true, present: false });
    expect(statusAttempts).toBe(3);
    expect(requests.some((request) => request.method === "OPTIONS")).toBe(true);
    expect(requests.some((request) => request.method === "HEAD")).toBe(true);
    expect(
      requests.some((request) => request.url.endsWith("?slug=other-synthetic")),
    ).toBe(true);
    const events = requests.filter((request) => request.method === "POST");
    expect(events).toHaveLength(2);
    for (const [index, event] of events.entries()) {
      expect(event.url).toBe(
        "https://cache.invalid/api/v8/artifacts/events?teamId=team_synthetic",
      );
      expect(JSON.parse(String(event.body))).toEqual([
        {
          duration: 0,
          event: index === 0 ? "MISS" : "HIT",
          hash: "synthetic-hash",
          sessionId: "01992345-6789-7abc-8def-0123456789ab",
          source: "REMOTE",
        },
      ]);
      expect(event.headers).toMatchObject({
        authorization: "Bearer synthetic-token",
        "content-type": "application/json",
        "user-agent": "turbo-ts/0.1.0",
      });
    }
  });

  it("disables remote artifact traffic unless status is exactly enabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-status-gate-"));
    const root = join(directory, "repository");
    await prepareRepository(root);
    try {
      for (const statusResponse of [
        [200, '{"status":"disabled"}'],
        [200, "malformed"],
        [401, '{"error":"unauthorized"}'],
      ] as const) {
        await withServer(
          (request) =>
            request.url?.startsWith("/v8/artifacts/status") === true
              ? [
                  statusResponse[0],
                  { "content-type": "application/json" },
                  statusResponse[1],
                ]
              : [500, {}, "unexpected remote artifact request"],
          async (baseUrl, requests) => {
            const result = await runCandidate(
              [
                "run",
                "build",
                "--filter=synthetic-app",
                "--cache=remote:rw",
                "--output-logs=none",
                "--token=synthetic-token",
                `--api=${baseUrl}`,
                `--cwd=${root}`,
              ],
              root,
            );
            expect(result.code, result.stderr).toBe(0);
            expect(
              requests.filter((request) =>
                request.path.startsWith("/v8/artifacts/"),
              ),
            ).toEqual([
              expect.objectContaining({
                method: "GET",
                path: "/v8/artifacts/status",
              }),
            ]);
          },
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("probes configured tokenless remotes before artifact traffic", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "turbo-ts-tokenless-status-gate-"),
    );
    const root = join(directory, "repository");
    await prepareRepository(root);
    try {
      await withServer(
        (request) =>
          request.url?.startsWith("/v8/artifacts/status") === true
            ? [
                200,
                { "content-type": "application/json" },
                '{"status":"disabled"}',
              ]
            : [500, {}, "unexpected remote artifact request"],
        async (baseUrl, requests) => {
          await writeFile(
            join(root, "turbo.json"),
            JSON.stringify({
              remoteCache: { apiUrl: baseUrl },
              tasks: { build: {} },
            }),
          );
          const result = await runCandidate(
            [
              "run",
              "build",
              "--filter=synthetic-app",
              "--cache=remote:rw",
              "--output-logs=none",
              `--cwd=${root}`,
            ],
            root,
            { TURBO_API: undefined, TURBO_TOKEN: undefined },
          );
          expect(result.code, result.stderr).toBe(0);
          expect(
            requests.filter((request) =>
              request.path.startsWith("/v8/artifacts/"),
            ),
          ).toEqual([
            expect.objectContaining({
              method: "GET",
              path: "/v8/artifacts/status",
            }),
          ]);
          expect(requests[0]?.headers.authorization).toBeUndefined();
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

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
      get: (name) =>
        Effect.succeed(
          name === "OTEL_EXPORTER_OTLP_HEADERS"
            ? "Content%2DType=text%2Fplain,Authorization=Basic%20environment,x%2Denvironment=Bearer%20credential%2Cwith%20comma,x-malformed=literal%ZZ"
            : undefined,
        ),
      entries: Effect.succeed({}),
    });
    const observationTimeMilliseconds = 1_700_000_000_123;
    const observationTimeUnixNano =
      BigInt(observationTimeMilliseconds) * 1_000_000n;
    const clockLayer = Layer.succeed(ClockService, {
      now: Effect.succeed(observationTimeMilliseconds),
      sleep: () => Effect.void,
    });
    const observabilityLayer = Layer.mergeAll(
      httpLayer,
      environmentLayer,
      clockLayer,
    );
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
            headers: [
              ["CONTENT-TYPE", "application/octet-stream"],
              ["AUTHORIZATION", "Basic cli"],
              ["x-synthetic", "yes"],
            ],
            resources: [["deployment.environment", "test"]],
            useRemoteCacheToken: true,
          },
          "synthetic-token",
          summary,
        ).pipe(Effect.provide(observabilityLayer)),
      );
    }
    expect(
      requests.map((request) => request.headers?.["content-type"]),
    ).toEqual(["application/json", "application/x-protobuf"]);
    for (const request of requests) {
      expect(
        Object.keys(request.headers ?? {}).filter(
          (name) => name.toLowerCase() === "content-type",
        ),
      ).toEqual(["content-type"]);
      expect(
        Object.keys(request.headers ?? {}).filter(
          (name) => name.toLowerCase() === "authorization",
        ),
      ).toEqual(["authorization"]);
    }
    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:4318/v1/metrics",
      "http://127.0.0.1:4318/v1/metrics",
    ]);
    for (const request of requests) {
      expect(request.headers).toMatchObject({
        authorization: "Bearer synthetic-token",
        "user-agent": "turbo-ts/0.1.0",
        "x-environment": "Bearer credential,with comma",
        "x-malformed": "literal%ZZ",
        "x-synthetic": "yes",
      });
    }
    const metricSelection = { runSummary: true, taskDetails: true };
    const json = makeOtlpJsonMetrics(
      summary,
      observationTimeUnixNano,
      [],
      metricSelection,
    );
    expect(JSON.stringify(json)).toContain('"service.name"');
    const resourceMetrics = json.resourceMetrics as ReadonlyArray<{
      readonly scopeMetrics: ReadonlyArray<{
        readonly metrics: ReadonlyArray<{
          readonly gauge: {
            readonly dataPoints: ReadonlyArray<{
              readonly timeUnixNano: string;
            }>;
          };
        }>;
      }>;
    }>;
    const jsonDataPoints = resourceMetrics[0]!.scopeMetrics[0]!.metrics.flatMap(
      (metric) => metric.gauge.dataPoints,
    );
    expect(jsonDataPoints).toHaveLength(2);
    expect(
      jsonDataPoints.every(
        (point) => point.timeUnixNano === observationTimeUnixNano.toString(),
      ),
    ).toBe(true);
    const protobuf = Buffer.from(
      encodeOtlpMetrics(summary, observationTimeUnixNano, [], metricSelection),
    );
    const protobufIntegerAttribute = (key: string, value: number): Buffer => {
      const keyBytes = Buffer.from(key);
      return Buffer.concat([
        Buffer.from([0x0a, keyBytes.length]),
        keyBytes,
        Buffer.from([0x12, 0x02, 0x18, value]),
      ]);
    };
    expect(
      protobuf.includes(protobufIntegerAttribute("turbo.task_count", 2)),
    ).toBe(true);
    expect(
      protobuf.includes(protobufIntegerAttribute("turbo.exit_code", 0)),
    ).toBe(true);
    expect(
      protobuf.includes(protobufIntegerAttribute("turbo.duration_ms", 12)),
    ).toBe(true);
    const protobufTimestamp = Buffer.alloc(9);
    protobufTimestamp[0] = 0x19;
    protobufTimestamp.writeBigUInt64LE(observationTimeUnixNano, 1);
    let protobufTimestampCount = 0;
    for (let offset = 0; offset <= protobuf.length - 9; offset += 1) {
      if (protobuf.subarray(offset, offset + 9).equals(protobufTimestamp)) {
        protobufTimestampCount += 1;
      }
    }
    expect(protobufTimestampCount).toBe(2);

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
      ).pipe(Effect.provide(observabilityLayer)),
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
      ).pipe(Effect.provide(observabilityLayer)),
    );
    expect(requests).toHaveLength(requestCount);

    await Effect.runPromise(
      exportRunMetrics(
        {
          enabled: true,
          protocol: "http-json",
          headers: [],
          resources: [],
        },
        undefined,
        summary,
      ).pipe(
        Effect.provide(
          Layer.succeed(EnvironmentService, {
            argv: Effect.succeed([]),
            cwd: Effect.succeed("/synthetic"),
            platform: Effect.succeed(process.platform),
            get: (name) =>
              Effect.succeed(
                name === "OTEL_EXPORTER_OTLP_ENDPOINT"
                  ? "https://collector.example.test/otel/"
                  : undefined,
              ),
            entries: Effect.succeed({}),
          }),
        ),
        Effect.provide(httpLayer),
        Effect.provide(clockLayer),
      ),
    );
    expect(requests.at(-1)?.url).toBe(
      "https://collector.example.test/otel/v1/metrics",
    );

    await Effect.runPromise(
      exportRunMetrics(
        {
          enabled: true,
          protocol: "http-json",
          endpoint: "https://collector.example.test/cli-prefix/",
          headers: [],
          resources: [],
        },
        undefined,
        summary,
      ).pipe(Effect.provide(observabilityLayer)),
    );
    expect(requests.at(-1)?.url).toBe(
      "https://collector.example.test/cli-prefix/v1/metrics",
    );

    for (const configuredTimeout of [
      { option: 0, environment: undefined, expected: 10_000 },
      { option: undefined, environment: "", expected: 10_000 },
      { option: undefined, environment: "0", expected: 10_000 },
      {
        option: undefined,
        environment: "2147483647",
        expected: 2_147_483_647,
      },
      { option: undefined, environment: "2147483648", expected: 10_000 },
    ] as const) {
      await Effect.runPromise(
        exportRunMetrics(
          {
            enabled: true,
            protocol: "http-json",
            endpoint: "http://127.0.0.1:4318",
            timeoutMilliseconds: configuredTimeout.option,
            headers: [],
            resources: [],
          },
          undefined,
          summary,
        ).pipe(
          Effect.provide(
            Layer.succeed(EnvironmentService, {
              argv: Effect.succeed([]),
              cwd: Effect.succeed("/synthetic"),
              platform: Effect.succeed(process.platform),
              get: (name) =>
                Effect.succeed(
                  name === "OTEL_EXPORTER_OTLP_TIMEOUT"
                    ? configuredTimeout.environment
                    : undefined,
                ),
              entries: Effect.succeed({}),
            }),
          ),
          Effect.provide(httpLayer),
          Effect.provide(clockLayer),
        ),
      );
      expect(requests.at(-1)?.timeoutMilliseconds).toBe(
        configuredTimeout.expected,
      );
    }
  });

  it("exports resolved non-executing metrics and honors periodic intervals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-otel-interval-"));
    const root = join(directory, "repository");
    await prepareRepository(root);
    const malformedEndpoint = await runCandidate(
      [
        "run",
        "build",
        "--filter=synthetic-app",
        "--no-cache",
        "--experimental-otel-enabled=true",
        "--experimental-otel-endpoint=not-a-url",
        `--cwd=${root}`,
      ],
      root,
    );
    expect(malformedEndpoint.code, malformedEndpoint.stderr).toBe(0);
    await mkdir(join(root, "packages/library"), { recursive: true });
    const delayedScript = 'node -e "setTimeout(() => {}, 250)"';
    await writeFile(
      join(root, "packages/app/package.json"),
      JSON.stringify({
        name: "synthetic-app",
        private: true,
        scripts: { build: delayedScript },
      }),
    );
    await writeFile(
      join(root, "packages/library/package.json"),
      JSON.stringify({
        name: "synthetic-library",
        private: true,
        scripts: { build: delayedScript },
      }),
    );
    try {
      await withServer(
        () => [200, { "content-type": "application/json" }, "{}"],
        async (baseUrl, requests) => {
          const otelArguments = [
            "--no-cache",
            "--experimental-otel-enabled=true",
            "--experimental-otel-protocol=http-json",
            `--experimental-otel-endpoint=${baseUrl}`,
            "--experimental-otel-metrics-task-details=true",
            `--cwd=${root}`,
          ];
          for (const mode of ["--dry-run=json", "--graph"] as const) {
            const result = await runCandidate(
              ["run", "build", mode, ...otelArguments],
              root,
            );
            expect(result.code, result.stderr).toBe(0);
            const document = JSON.parse(requests.at(-1)?.body ?? "{}");
            const metrics = document.resourceMetrics[0].scopeMetrics[0].metrics;
            const runMetric = metrics.find(
              (metric: { readonly name: string }) =>
                metric.name === "turbo.run",
            );
            const taskCount = runMetric.gauge.dataPoints[0].attributes.find(
              (attribute: { readonly key: string }) =>
                attribute.key === "turbo.task_count",
            );
            expect(taskCount.value.intValue).toBe("2");
            const taskMetric = metrics.find(
              (metric: { readonly name: string }) =>
                metric.name === "turbo.task",
            );
            expect(taskMetric.gauge.dataPoints).toHaveLength(2);
          }

          const requestCount = requests.length;
          const periodic = await runCandidate(
            [
              "run",
              "build",
              "--filter=synthetic-app",
              "--experimental-otel-interval-ms=25",
              ...otelArguments,
            ],
            root,
          );
          expect(periodic.code, periodic.stderr).toBe(0);
          const periodicRequests = requests.slice(requestCount);
          expect(periodicRequests.length).toBeGreaterThan(1);
          for (const request of periodicRequests) {
            const document = JSON.parse(request.body ?? "{}");
            const metrics = document.resourceMetrics[0].scopeMetrics[0].metrics;
            const runMetric = metrics.find(
              (metric: { readonly name: string }) =>
                metric.name === "turbo.run",
            );
            const taskCount = runMetric.gauge.dataPoints[0].attributes.find(
              (attribute: { readonly key: string }) =>
                attribute.key === "turbo.task_count",
            );
            expect(taskCount.value.intValue).toBe("1");
          }
          for (const request of periodicRequests.slice(0, -1)) {
            expect(request.body).not.toContain('"stringValue":"skipped"');
          }
          expect(periodicRequests.at(-1)?.body).toContain(
            "synthetic-app#build",
          );
          expect(periodicRequests.at(-1)?.body).toContain(
            '"stringValue":"succeeded"',
          );
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("sends OTLP gRPC over HTTP/2 and handles gRPC status", async () => {
    const requests: Array<{
      readonly body: Buffer;
      readonly headers: Readonly<Record<string, unknown>>;
    }> = [];
    let grpcStatus = "0";
    let grpcMessage = "permission%20denied";
    let statusInInitialHeaders = false;
    let responseBody = Buffer.alloc(5);
    const server = createHttp2Server();
    const activeSessions = new Set<ServerHttp2Session>();
    server.on("session", (session) => {
      activeSessions.add(session);
      session.once("close", () => activeSessions.delete(session));
    });
    server.on("stream", (stream, headers) => {
      const chunks: Array<Buffer> = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        requests.push({ body: Buffer.concat(chunks), headers });
        const responseHeaders = {
          [http2Constants.HTTP2_HEADER_STATUS]: 200,
          [http2Constants.HTTP2_HEADER_CONTENT_TYPE]: "application/grpc",
          ...(statusInInitialHeaders
            ? {
                "grpc-status": grpcStatus,
                ...(grpcStatus === "0" ? {} : { "grpc-message": grpcMessage }),
              }
            : {}),
        };
        if (statusInInitialHeaders) {
          stream.respond(responseHeaders);
        } else {
          stream.respond(responseHeaders, { waitForTrailers: true });
          stream.on("wantTrailers", () =>
            stream.sendTrailers({
              "grpc-status": grpcStatus,
              ...(grpcStatus === "0" ? {} : { "grpc-message": grpcMessage }),
            }),
          );
        }
        stream.end(responseBody);
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
      headers: [
        ["Content-Type", "text/plain"],
        ["TE", "identity"],
        ["x-synthetic", "yes"],
      ] as const,
      resources: [],
    };
    const summary = { exitCode: 0, taskCount: 0, tasks: [] };
    try {
      const invalidHeader = await Effect.runPromise(
        Effect.either(
          exportRunMetrics(
            { ...options, headers: [["bad header", "value"]] },
            undefined,
            summary,
          ).pipe(Effect.provide(nodeFoundationLayer)),
        ),
      );
      expect(invalidHeader._tag).toBe("Left");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(activeSessions.size).toBe(0);

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
      expect(
        requests[0]?.headers[http2Constants.HTTP2_HEADER_CONTENT_TYPE],
      ).toBe("application/grpc");
      expect(requests[0]?.headers.te).toBe("trailers");
      expect(requests[0]?.body[0]).toBe(0);

      grpcStatus = "7";
      grpcMessage = "permission%20denied%1B%5D0%3Bunsafe%07%C2%9B31m";
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
      expect(failed.left.message).toContain(
        "\\u001b]0;unsafe\\u0007\\u009b31m",
      );
      expect(failed.left.message).not.toContain("\u001b");
      expect(failed.left.message).not.toContain("\u0007");
      expect(failed.left.message).not.toContain("\u009b");

      grpcStatus = "0";
      statusInInitialHeaders = true;
      const missingTrailers = await Effect.runPromise(
        Effect.either(
          exportRunMetrics(options, undefined, summary).pipe(
            Effect.provide(nodeFoundationLayer),
          ),
        ),
      );
      expect(missingTrailers._tag).toBe("Left");
      if (missingTrailers._tag === "Right") {
        throw new Error("expected missing gRPC trailers to fail");
      }
      expect(missingTrailers.left.message).toContain("gRPC status is missing");

      responseBody = Buffer.alloc(0);
      await Effect.runPromise(
        exportRunMetrics(options, undefined, summary).pipe(
          Effect.provide(nodeFoundationLayer),
        ),
      );
    } finally {
      for (const session of activeSessions) session.destroy();
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
        (request) => [
          request.headers.authorization === undefined ? 401 : 200,
          { "content-type": "application/json" },
          "{}",
        ],
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
          await mkdir(join(root, ".turbo"), { recursive: true });
          await writeFile(
            join(root, ".turbo/config.json"),
            "invalid project credentials",
          );
          const storedToken = await runCandidate(
            [
              ...commonArguments,
              "--dry-run=json",
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

          await writeFile(userPath, "invalid user credentials");
          const invalidStoredToken = await runCandidate(commonArguments, root, {
            XDG_CONFIG_HOME: configurationHome,
          });
          expect(invalidStoredToken.code, invalidStoredToken.stderr).toBe(0);
          expect(requests[2]?.headers.authorization).toBeUndefined();
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("preserves HEAD requests across 303 redirects", async () => {
    await withServer(
      (request) =>
        request.method === "HEAD"
          ? [200, { "content-length": "128" }, ""]
          : [200, {}, "unexpected redirected response body"],
      async (destination, destinationRequests) => {
        await withServer(
          () => [303, { location: destination }, "redirect"],
          async (source, sourceRequests) => {
            const response = await Effect.runPromise(
              HttpService.pipe(
                Effect.flatMap((http) =>
                  http.request({
                    url: source,
                    method: "HEAD",
                    timeoutMilliseconds: 1_000,
                    maxResponseBodyBytes: 0,
                  }),
                ),
                Effect.provide(nodeFoundationLayer),
              ),
            );
            expect(response.status).toBe(200);
            expect(sourceRequests.map((request) => request.method)).toEqual([
              "HEAD",
            ]);
            expect(
              destinationRequests.map((request) => request.method),
            ).toEqual(["HEAD"]);
          },
        );
      },
    );
  });

  it("does not retry deterministic redirect policy failures", async () => {
    await withServer(
      () => [
        302,
        {
          location: "https://user:synthetic-redirect-secret@example.test/cache",
        },
        "redirect",
      ],
      async (baseUrl, requests) => {
        const outcome = await Effect.runPromise(
          Effect.either(
            verifyRemoteCacheStatus({
              apiUrl: baseUrl,
              timeoutMilliseconds: 1_000,
              uploadTimeoutMilliseconds: 1_000,
              preflight: false,
              requireSignature: false,
              token: "synthetic-token",
            }).pipe(Effect.provide(nodeFoundationLayer)),
          ),
        );
        expect(outcome._tag).toBe("Left");
        if (outcome._tag === "Right") {
          throw new Error("expected credential redirect rejection");
        }
        expect(outcome.left.retryable).toBe(false);
        expect(requests).toHaveLength(1);
      },
    );

    const directory = await mkdtemp(join(tmpdir(), "turbo-ts-redirect-"));
    try {
      await withServer(
        () => [302, { location: "ftp://example.test/cache" }, "redirect"],
        async (baseUrl, requests) => {
          const outcome = await Effect.runPromise(
            Effect.either(
              HttpService.pipe(
                Effect.flatMap((http) =>
                  http.downloadToFile(
                    { url: baseUrl, method: "GET" },
                    join(directory, "artifact.tgz"),
                  ),
                ),
                Effect.provide(nodeFoundationLayer),
              ),
            ),
          );
          expect(outcome._tag).toBe("Left");
          if (outcome._tag === "Right") {
            throw new Error("expected protocol redirect rejection");
          }
          expect(outcome.left.retryable).toBe(false);
          expect(requests).toHaveLength(1);
        },
      );

      await withServer(
        () => [302, { location: "/redirect-loop" }, "redirect"],
        async (baseUrl, requests) => {
          const outcome = await Effect.runPromise(
            Effect.either(
              HttpService.pipe(
                Effect.flatMap((http) =>
                  http.request({ url: baseUrl, method: "GET" }),
                ),
                Effect.provide(nodeFoundationLayer),
              ),
            ),
          );
          expect(outcome._tag).toBe("Left");
          if (outcome._tag === "Right") {
            throw new Error("expected redirect limit rejection");
          }
          expect(outcome.left.retryable).toBe(false);
          expect(requests).toHaveLength(6);
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("strips secrets on cross-origin redirects and enforces timeouts", async () => {
    for (const redirectStatus of [307, 308]) {
      await withServer(
        () => [200, {}, "ok"],
        async (destination, destinationRequests) => {
          await withServer(
            () => [redirectStatus, { location: destination }, "redirect"],
            async (source) => {
              const result = await Effect.runPromise(
                HttpService.pipe(
                  Effect.flatMap((http) =>
                    http.request({
                      url: source,
                      method: "PUT",
                      headers: {
                        authorization: "Bearer synthetic-token",
                        "content-type": "application/octet-stream",
                        "x-api-key": "synthetic-api-key",
                        "x-artifact-tag": "synthetic-artifact-tag",
                        "x-synthetic": "synthetic-custom-value",
                      },
                      body: "synthetic-body",
                      timeoutMilliseconds: 1_000,
                    }),
                  ),
                  Effect.provide(nodeFoundationLayer),
                ),
              );
              expect(result.status).toBe(200);
              expect(destinationRequests[0]).toMatchObject({
                body: "synthetic-body",
                method: "PUT",
              });
              expect(
                destinationRequests[0]?.headers.authorization,
              ).toBeUndefined();
              expect(
                destinationRequests[0]?.headers["x-artifact-tag"],
              ).toBeUndefined();
              expect(
                destinationRequests[0]?.headers["x-api-key"],
              ).toBeUndefined();
              expect(
                destinationRequests[0]?.headers["x-synthetic"],
              ).toBeUndefined();
              expect(destinationRequests[0]?.headers["content-type"]).toBe(
                "application/octet-stream",
              );
            },
          );
        },
      );
    }

    await withServer(
      (request) =>
        request.url === "/same-origin"
          ? [200, {}, "ok"]
          : [307, { location: "/same-origin" }, "redirect"],
      async (baseUrl, requests) => {
        await Effect.runPromise(
          HttpService.pipe(
            Effect.flatMap((http) =>
              http.request({
                url: baseUrl,
                method: "GET",
                headers: { "x-api-key": "same-origin-key" },
              }),
            ),
            Effect.provide(nodeFoundationLayer),
          ),
        );
        expect(requests[1]?.headers["x-api-key"]).toBe("same-origin-key");
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
