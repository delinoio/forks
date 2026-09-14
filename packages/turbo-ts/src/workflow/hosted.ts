import { Deferred, Effect, Schedule } from "effect";
import { parseCommonArguments } from "../cli/common-options.js";
import { joinPath } from "../core/path.js";
import { BoundaryError, ConfigurationError } from "../effect/errors.js";
import {
  CredentialService,
  EnvironmentService,
  FileSystemService,
  HttpService,
  LoopbackHttpService,
  ProcessService,
  RandomnessService,
  RetryScheduleService,
  TerminalService,
} from "../effect/services.js";
import { packageVersion } from "../version.js";
import { browserInvocation } from "./browser.js";
import { resolveWorkflowRepositoryRoot } from "./repository.js";

type HostedCommand = "link" | "login" | "logout" | "unlink";

interface HostedCommandOptions {
  readonly common: ReturnType<typeof parseCommonArguments>["options"];
  readonly invalidate: boolean;
  readonly manual: boolean;
  readonly noGitignore: boolean;
  readonly scope?: string;
  readonly ssoTeam?: string;
  readonly yes: boolean;
}

interface ResolvedHostedSettings {
  readonly api: URL;
  readonly login: URL;
  readonly teamId?: string;
  readonly teamSlug?: string;
  readonly timeoutMilliseconds: number;
  readonly token?: string;
}

interface HostedTeam {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

const fail = (message: string): ConfigurationError =>
  new ConfigurationError({ path: "<arguments>", message });

const valueAt = (
  arguments_: ReadonlyArray<string>,
  index: number,
  name: string,
): readonly [string, number] => {
  const argument = arguments_[index]!;
  const separator = argument.indexOf("=");
  if (separator !== -1) {
    const value = argument.slice(separator + 1);
    if (value === "") throw fail(`${name} requires a value`);
    return [value, index];
  }
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw fail(`${name} requires a value`);
  }
  return [value, index + 1];
};

const optionalBoolean = (
  arguments_: ReadonlyArray<string>,
  index: number,
  name: string,
): readonly [boolean, number] => {
  const argument = arguments_[index]!;
  const value = argument.includes("=")
    ? argument.slice(argument.indexOf("=") + 1)
    : arguments_[index + 1];
  if (value === "true") {
    return [true, argument.includes("=") ? index : index + 1];
  }
  if (value === "false") {
    return [false, argument.includes("=") ? index : index + 1];
  }
  if (argument.includes("=")) throw fail(`${name} must be true or false`);
  return [true, index];
};

export const parseHostedArguments = (
  command: HostedCommand,
  arguments_: ReadonlyArray<string>,
): HostedCommandOptions => {
  const parsed = parseCommonArguments(arguments_);
  let invalidate = true;
  let manual = false;
  let noGitignore = false;
  let scope: string | undefined;
  let ssoTeam: string | undefined;
  let yes = false;
  for (let index = 0; index < parsed.remaining.length; index += 1) {
    const argument = parsed.remaining[index]!;
    const name = argument.split("=", 1)[0]!;
    switch (name) {
      case "--invalidate":
        if (command !== "logout") throw fail(`unknown option: ${argument}`);
        [invalidate, index] = optionalBoolean(parsed.remaining, index, name);
        break;
      case "--manual":
        if (command !== "login") throw fail(`unknown option: ${argument}`);
        manual = true;
        break;
      case "--no-gitignore":
        if (command !== "link") throw fail(`unknown option: ${argument}`);
        noGitignore = true;
        break;
      case "--scope":
        if (command !== "link") throw fail(`unknown option: ${argument}`);
        [scope, index] = valueAt(parsed.remaining, index, name);
        break;
      case "--sso-team":
        if (command !== "login") throw fail(`unknown option: ${argument}`);
        [ssoTeam, index] = valueAt(parsed.remaining, index, name);
        break;
      case "--yes":
      case "-y":
        if (command !== "link") throw fail(`unknown option: ${argument}`);
        yes = true;
        break;
      default:
        throw fail(`unknown option: ${argument}`);
    }
  }
  return {
    common: parsed.options,
    invalidate,
    manual,
    noGitignore,
    scope,
    ssoTeam,
    yes,
  };
};

export const hostedUrl = (value: string, name: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fail(`invalid ${name} URL`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw fail(`invalid ${name} URL`);
  }
  return url;
};

const withPath = (base: URL, path: string): URL => {
  const result = new URL(base);
  result.pathname = `${result.pathname.replace(/\/+$/, "")}${path}`;
  result.search = "";
  result.hash = "";
  return result;
};

const transientStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

const requestHosted = (
  url: URL,
  method: "DELETE" | "GET" | "OPTIONS",
  token: string,
  timeoutMilliseconds: number,
): Effect.Effect<
  { readonly status: number; readonly body: Uint8Array },
  BoundaryError,
  HttpService | RetryScheduleService
> =>
  Effect.gen(function* () {
    const http = yield* HttpService;
    const schedules = yield* RetryScheduleService;
    return yield* http
      .request({
        url: url.toString(),
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": `turbo-ts/${packageVersion}`,
        },
        timeoutMilliseconds,
        maxResponseBodyBytes: 64 * 1024,
      })
      .pipe(
        Effect.flatMap((response) =>
          transientStatus(response.status)
            ? Effect.fail(
                new BoundaryError({
                  boundary: "hosted",
                  message: `hosted request returned ${response.status}`,
                  retryable: true,
                }),
              )
            : Effect.succeed(response),
        ),
        Effect.retry(
          schedules.transient.pipe(
            Schedule.whileInput(
              (error: unknown) =>
                error instanceof BoundaryError && error.retryable,
            ),
          ),
        ),
      );
  });

const configuredValue = (
  name: string,
): Effect.Effect<string | undefined, never, EnvironmentService> =>
  Effect.gen(function* () {
    const environment = yield* EnvironmentService;
    const value = yield* environment.get(name);
    return value === "" ? undefined : value;
  });

const resolveHostedSettings = (
  options: HostedCommandOptions,
): Effect.Effect<
  ResolvedHostedSettings,
  ConfigurationError | BoundaryError,
  CredentialService | EnvironmentService
> =>
  Effect.gen(function* () {
    const credentials = yield* CredentialService;
    const stored = yield* credentials.readUserConfiguration;
    const token =
      options.common.token ??
      (yield* configuredValue("TURBO_TOKEN")) ??
      stored?.token;
    const environmentTeamId = yield* configuredValue("TURBO_TEAMID");
    const teamId =
      options.common.team === undefined ? environmentTeamId : undefined;
    const teamSlug =
      options.common.team ?? (yield* configuredValue("TURBO_TEAM"));
    const apiValue =
      options.common.apiUrl ??
      (yield* configuredValue("TURBO_API")) ??
      "https://vercel.com/api";
    const loginValue =
      options.common.loginUrl ??
      (yield* configuredValue("TURBO_LOGIN")) ??
      "https://vercel.com";
    return {
      api: hostedUrl(apiValue, "API"),
      login: hostedUrl(loginValue, "login"),
      teamId,
      teamSlug,
      timeoutMilliseconds: Math.round(
        (options.common.remoteCacheTimeoutSeconds ?? 30) * 1_000,
      ),
      token,
    };
  });

const requestInteractiveLoginToken = (
  settings: ResolvedHostedSettings,
  ssoTeam: string | undefined,
): Effect.Effect<
  string,
  unknown,
  | EnvironmentService
  | LoopbackHttpService
  | ProcessService
  | RandomnessService
  | TerminalService
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const environment = yield* EnvironmentService;
      const loopback = yield* LoopbackHttpService;
      const processes = yield* ProcessService;
      const randomness = yield* RandomnessService;
      const terminal = yield* TerminalService;
      if (processes.spawnDetached === undefined) {
        return yield* Effect.fail(
          fail(
            "interactive login cannot open a browser; use --manual with --token or TURBO_TOKEN",
          ),
        );
      }
      const state = yield* randomness.uuidV7;
      const token = yield* Deferred.make<string>();
      const server = yield* loopback.serve(0, (request) => {
        const callback = new URL(request.path, "http://127.0.0.1");
        if (request.method !== "GET" || callback.pathname !== "/") {
          return Effect.succeed({ status: 404, body: "Not Found" });
        }
        if (callback.searchParams.get("state") !== state) {
          return Effect.succeed({ status: 403, body: "Forbidden" });
        }
        const received = callback.searchParams.get("token");
        if (received === null || received === "") {
          return Effect.succeed({ status: 400, body: "Missing token" });
        }
        return Effect.succeed({
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: "Authorization complete. You may close this window.",
          afterSent: Deferred.succeed(token, received).pipe(Effect.asVoid),
        });
      });
      const callback = new URL(`http://127.0.0.1:${server.port}/`);
      const authorization = withPath(settings.login, "/turborepo/token");
      authorization.searchParams.set("redirect_uri", callback.toString());
      authorization.searchParams.set("state", state);
      if (ssoTeam !== undefined) {
        authorization.searchParams.set("ssoTeam", ssoTeam);
      }
      const platform = yield* environment.platform;
      const cwd = yield* environment.cwd;
      yield* terminal.writeStdout("Opening browser for turbo-ts login.\n");
      yield* processes.spawnDetached({
        ...browserInvocation(platform, authorization.toString()),
        cwd,
        inheritEnvironment: true,
      });
      return yield* Deferred.await(token);
    }),
  );

const resolveLogoutInvalidationApi = (
  options: HostedCommandOptions,
  configuredApi: URL,
): Effect.Effect<
  URL | undefined,
  never,
  CredentialService | EnvironmentService | FileSystemService
> =>
  Effect.gen(function* () {
    if (
      options.common.apiUrl !== undefined ||
      (yield* configuredValue("TURBO_API")) !== undefined
    ) {
      return configuredApi;
    }
    const credentials = yield* CredentialService;
    const projectApiUrl = yield* resolveWorkflowRepositoryRoot({
      cwd: options.common.cwd,
    }).pipe(
      Effect.flatMap((root) => credentials.readProjectConfiguration(root)),
      Effect.map((configuration) => configuration?.apiUrl),
      Effect.catchAll(() => Effect.succeed(undefined)),
    );
    if (projectApiUrl === undefined) return undefined;
    try {
      return hostedUrl(projectApiUrl, "project API");
    } catch {
      return undefined;
    }
  });

const validateRemoteCaching = (
  settings: ResolvedHostedSettings,
  token: string,
): Effect.Effect<void, BoundaryError, HttpService | RetryScheduleService> =>
  Effect.gen(function* () {
    const url = withPath(settings.api, "/v8/artifacts/status");
    if (settings.teamId !== undefined) {
      url.searchParams.set("teamId", settings.teamId);
    }
    if (settings.teamSlug !== undefined) {
      url.searchParams.set("slug", settings.teamSlug);
    }
    const response = yield* requestHosted(
      url,
      "GET",
      token,
      settings.timeoutMilliseconds,
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new BoundaryError({
          boundary: "hosted",
          message: `remote caching authorization failed with status ${response.status}`,
          retryable: false,
        }),
      );
    }
    let status: unknown;
    try {
      status = JSON.parse(new TextDecoder().decode(response.body));
    } catch {
      status = undefined;
    }
    if (
      typeof status !== "object" ||
      status === null ||
      !("status" in status) ||
      status.status !== "enabled"
    ) {
      return yield* Effect.fail(
        new BoundaryError({
          boundary: "hosted",
          message: "remote caching status response is invalid",
          retryable: false,
        }),
      );
    }
  });

const availableHostedTeams = (
  settings: ResolvedHostedSettings,
  token: string,
): Effect.Effect<
  ReadonlyArray<HostedTeam>,
  BoundaryError,
  HttpService | RetryScheduleService
> =>
  Effect.gen(function* () {
    const userResponse = yield* requestHosted(
      withPath(settings.api, "/v2/user"),
      "GET",
      token,
      settings.timeoutMilliseconds,
    );
    if (userResponse.status < 200 || userResponse.status >= 300) {
      return yield* Effect.fail(
        new BoundaryError({
          boundary: "hosted",
          message: `user lookup failed with status ${userResponse.status}`,
          retryable: false,
        }),
      );
    }
    let userDocument: unknown;
    try {
      userDocument = JSON.parse(new TextDecoder().decode(userResponse.body));
    } catch {
      userDocument = undefined;
    }
    const user =
      typeof userDocument === "object" &&
      userDocument !== null &&
      "user" in userDocument &&
      typeof userDocument.user === "object" &&
      userDocument.user !== null
        ? userDocument.user
        : undefined;
    const userId =
      user !== undefined && "id" in user && typeof user.id === "string"
        ? user.id
        : undefined;
    const userSlug =
      user !== undefined &&
      "username" in user &&
      typeof user.username === "string"
        ? user.username
        : user !== undefined && "slug" in user && typeof user.slug === "string"
          ? user.slug
          : userId;
    const userName =
      user !== undefined && "name" in user && typeof user.name === "string"
        ? user.name
        : userSlug;
    const personalScope =
      userId === undefined || userSlug === undefined || userName === undefined
        ? []
        : [{ id: userId, slug: userSlug, name: userName }];
    const teamsUrl = withPath(settings.api, "/v2/teams");
    teamsUrl.searchParams.set("limit", "100");
    const teamsResponse = yield* requestHosted(
      teamsUrl,
      "GET",
      token,
      settings.timeoutMilliseconds,
    );
    if (teamsResponse.status < 200 || teamsResponse.status >= 300) {
      return yield* Effect.fail(
        new BoundaryError({
          boundary: "hosted",
          message: `team lookup failed with status ${teamsResponse.status}`,
          retryable: false,
        }),
      );
    }
    let document: unknown;
    try {
      document = JSON.parse(new TextDecoder().decode(teamsResponse.body));
    } catch {
      document = undefined;
    }
    const teams =
      typeof document === "object" &&
      document !== null &&
      "teams" in document &&
      Array.isArray(document.teams)
        ? document.teams
        : [];
    return [
      ...personalScope,
      ...teams.flatMap((team) => {
        if (typeof team !== "object" || team === null) return [];
        const id = "id" in team ? team.id : undefined;
        const slug = "slug" in team ? team.slug : undefined;
        const name = "name" in team ? team.name : undefined;
        return typeof id === "string" &&
          typeof slug === "string" &&
          typeof name === "string"
          ? [{ id, slug, name }]
          : [];
      }),
    ];
  });

const updateGitIgnore = (
  root: string,
): Effect.Effect<void, BoundaryError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const path = joinPath(root, ".gitignore");
    const exists = yield* fileSystem.exists(path);
    const current = exists ? yield* fileSystem.readText(path) : "";
    const alreadyIgnored = current
      .split(/\r?\n/)
      .some((line) => /^\/?\.turbo\/?$/.test(line.trim()));
    if (alreadyIgnored) return;
    const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
    yield* fileSystem.writeTextAtomic(
      path,
      `${current}${prefix}.turbo\n`,
      0o644,
    );
  });

export const executeHostedCommand = (
  command: HostedCommand,
  arguments_: ReadonlyArray<string>,
): Effect.Effect<
  number,
  unknown,
  | CredentialService
  | EnvironmentService
  | FileSystemService
  | HttpService
  | LoopbackHttpService
  | ProcessService
  | RandomnessService
  | RetryScheduleService
  | TerminalService
> =>
  Effect.gen(function* () {
    const options = parseHostedArguments(command, arguments_);
    const credentials = yield* CredentialService;
    const terminal = yield* TerminalService;

    if (command === "unlink") {
      const root = yield* resolveWorkflowRepositoryRoot({
        cwd: options.common.cwd,
      });
      yield* credentials.writeProjectConfiguration(root, {});
      yield* terminal.writeStdout(">>> Disabled Remote Caching\n");
      return 0;
    }

    if (command === "logout" && !options.invalidate) {
      const existing = (yield* credentials.readUserConfiguration) ?? {};
      const { token: _removed, ...retained } = existing;
      yield* credentials.writeUserConfiguration(retained);
      yield* terminal.writeStdout(">>> Logged out\n");
      return 0;
    }

    const settings = yield* resolveHostedSettings(options);

    if (command === "login") {
      const selected =
        options.ssoTeam === undefined
          ? settings
          : {
              ...settings,
              teamId: undefined,
              teamSlug: options.ssoTeam,
            };
      let token = settings.token;
      if (token === undefined) {
        if (options.manual) {
          return yield* Effect.fail(
            fail("manual login requires a token from --token or TURBO_TOKEN"),
          );
        }
        const stdinIsTerminal =
          terminal.stdinIsTerminal === undefined
            ? false
            : yield* terminal.stdinIsTerminal;
        if (!stdinIsTerminal) {
          return yield* Effect.fail(
            fail(
              "login requires a token from --token or TURBO_TOKEN in non-interactive mode",
            ),
          );
        }
        token = yield* requestInteractiveLoginToken(settings, options.ssoTeam);
      }
      yield* validateRemoteCaching(selected, token);
      const existing = (yield* credentials.readUserConfiguration) ?? {};
      yield* credentials.writeUserConfiguration({ ...existing, token });
      yield* terminal.writeStdout("Successfully logged in to turbo-ts.\n");
      return 0;
    }

    if (command === "logout") {
      const existing = (yield* credentials.readUserConfiguration) ?? {};
      const token = settings.token;
      if (options.invalidate && token !== undefined) {
        const invalidationApi = yield* resolveLogoutInvalidationApi(
          options,
          settings.api,
        );
        if (invalidationApi !== undefined) {
          const response = yield* requestHosted(
            withPath(invalidationApi, "/v3/user/tokens/current"),
            "DELETE",
            token,
            settings.timeoutMilliseconds,
          );
          if (response.status < 200 || response.status >= 300) {
            return yield* Effect.fail(
              new BoundaryError({
                boundary: "hosted",
                message: `token invalidation failed with status ${response.status}`,
                retryable: false,
              }),
            );
          }
        }
      }
      const { token: _removed, ...retained } = existing;
      yield* credentials.writeUserConfiguration(retained);
      yield* terminal.writeStdout(">>> Logged out\n");
      return 0;
    }

    const root = yield* resolveWorkflowRepositoryRoot({
      cwd: options.common.cwd,
    });
    const token = settings.token;
    if (token === undefined) {
      return yield* Effect.fail(
        fail("not logged in; run `turbo-ts login` first"),
      );
    }
    const teams = yield* availableHostedTeams(settings, token);
    const configuredScope =
      options.scope ?? settings.teamId ?? settings.teamSlug;
    let team: HostedTeam | undefined;
    if (configuredScope === undefined) {
      if (teams.length === 0) {
        return yield* Effect.fail(
          fail("no remote caching scopes are available"),
        );
      }
      const stdinIsTerminal =
        terminal.stdinIsTerminal === undefined
          ? false
          : yield* terminal.stdinIsTerminal;
      const readLine = terminal.readLine;
      if (!stdinIsTerminal || readLine === undefined) {
        return yield* Effect.fail(
          fail(
            "link requires --scope, --team, TURBO_TEAM, or TURBO_TEAMID in non-interactive mode",
          ),
        );
      }
      yield* terminal.writeStdout(
        `Select a Remote Caching scope:\n${teams
          .map(
            (candidate, index) =>
              `  ${index + 1}. ${candidate.name} (${candidate.slug})`,
          )
          .join("\n")}\n`,
      );
      const answer = yield* readLine(`Enter a scope [1-${teams.length}]: `);
      const selectedIndex = Number(answer.trim()) - 1;
      if (!Number.isSafeInteger(selectedIndex) || selectedIndex < 0) {
        return yield* Effect.fail(
          fail("invalid remote caching scope selection"),
        );
      }
      team = teams[selectedIndex];
      if (team === undefined) {
        return yield* Effect.fail(
          fail("invalid remote caching scope selection"),
        );
      }
    } else {
      team = teams.find(
        (candidate) =>
          candidate.id === configuredScope ||
          candidate.slug === configuredScope,
      );
      if (team === undefined) {
        return yield* Effect.fail(
          fail(`unknown remote caching scope: ${configuredScope}`),
        );
      }
    }
    if (!options.yes) {
      const stdinIsTerminal =
        terminal.stdinIsTerminal === undefined
          ? false
          : yield* terminal.stdinIsTerminal;
      const readLine = terminal.readLine;
      if (!stdinIsTerminal || readLine === undefined) {
        return yield* Effect.fail(
          fail("link confirmation requires an interactive terminal or --yes"),
        );
      }
      const answer = yield* readLine(
        `Enable Remote Caching for ${team.name}? [y/N] `,
      );
      if (!new Set(["y", "yes"]).has(answer.trim().toLowerCase())) {
        yield* terminal.writeStdout("Remote Caching link cancelled.\n");
        return 0;
      }
    }
    const selected = {
      ...settings,
      teamId: team.id,
      teamSlug: team.slug,
    };
    yield* validateRemoteCaching(selected, token);
    const existing = (yield* credentials.readProjectConfiguration(root)) ?? {};
    yield* credentials.writeProjectConfiguration(root, {
      ...existing,
      apiUrl: settings.api.toString(),
      teamId: team.id,
    });
    if (!options.noGitignore) yield* updateGitIgnore(root);
    yield* terminal.writeStdout(
      `>>> Enabled Remote Caching for ${team.name}\n`,
    );
    return 0;
  });
