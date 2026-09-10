import { Effect, Schedule } from "effect";
import { parseCommonArguments } from "../cli/common-options.js";
import { parseJsonConfiguration } from "../config/runtime.js";
import { joinPath } from "../core/path.js";
import { BoundaryError, ConfigurationError } from "../effect/errors.js";
import {
  CredentialService,
  EnvironmentService,
  FileSystemService,
  HttpService,
  RetryScheduleService,
  TerminalService,
} from "../effect/services.js";
import { packageVersion } from "../version.js";
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

const hostedUrl = (value: string, name: string): URL => {
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
    const teamId = yield* configuredValue("TURBO_TEAMID");
    const teamSlug =
      options.common.team ?? (yield* configuredValue("TURBO_TEAM"));
    const apiValue =
      options.common.apiUrl ??
      (yield* configuredValue("TURBO_API")) ??
      "https://vercel.com/api";
    return {
      api: hostedUrl(apiValue, "API"),
      teamId,
      teamSlug,
      timeoutMilliseconds: Math.round(
        (options.common.remoteCacheTimeoutSeconds ?? 30) * 1_000,
      ),
      token,
    };
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
      typeof status.status !== "string"
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
    return teams.flatMap((team) => {
      if (typeof team !== "object" || team === null) return [];
      const id = "id" in team ? team.id : undefined;
      const slug = "slug" in team ? team.slug : undefined;
      const name = "name" in team ? team.name : undefined;
      return typeof id === "string" &&
        typeof slug === "string" &&
        typeof name === "string"
        ? [{ id, slug, name }]
        : [];
    });
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

const updateRootRemoteCache = (
  root: string,
  options: HostedCommandOptions,
  settings: ResolvedHostedSettings,
): Effect.Effect<void, BoundaryError | ConfigurationError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const override = options.common.rootTurboJson;
    const path =
      override === undefined
        ? (yield* fileSystem.exists(joinPath(root, "turbo.json")))
          ? joinPath(root, "turbo.json")
          : joinPath(root, "turbo.jsonc")
        : override.startsWith("/")
          ? override
          : joinPath(root, override);
    if (!(yield* fileSystem.exists(path))) return;
    const document = parseJsonConfiguration(
      yield* fileSystem.readText(path),
      path,
    );
    if (
      typeof document !== "object" ||
      document === null ||
      Array.isArray(document)
    ) {
      return yield* Effect.fail(
        new ConfigurationError({
          path,
          message: "configuration must be an object",
        }),
      );
    }
    const existing = document as Record<string, unknown>;
    const remote =
      typeof existing.remoteCache === "object" &&
      existing.remoteCache !== null &&
      !Array.isArray(existing.remoteCache)
        ? (existing.remoteCache as Record<string, unknown>)
        : {};
    yield* fileSystem.writeTextAtomic(
      path,
      JSON.stringify({
        ...existing,
        remoteCache: {
          ...remote,
          ...(settings.teamId === undefined ? {} : { teamId: settings.teamId }),
          ...(settings.teamSlug === undefined
            ? {}
            : { teamSlug: settings.teamSlug }),
          apiUrl: settings.api.toString().replace(/\/$/, ""),
        },
      }),
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
  | RetryScheduleService
  | TerminalService
> =>
  Effect.gen(function* () {
    const options = parseHostedArguments(command, arguments_);
    const credentials = yield* CredentialService;
    const terminal = yield* TerminalService;
    const settings = yield* resolveHostedSettings(options);

    if (command === "login") {
      const token = settings.token;
      if (token === undefined) {
        return yield* Effect.fail(
          fail(
            options.manual
              ? "manual login requires a token from --token or TURBO_TOKEN"
              : "login requires a token from --token or TURBO_TOKEN in non-interactive mode",
          ),
        );
      }
      const selected = {
        ...settings,
        teamSlug: options.ssoTeam ?? settings.teamSlug,
      };
      yield* validateRemoteCaching(selected, token);
      const existing = (yield* credentials.readUserConfiguration) ?? {};
      yield* credentials.writeUserConfiguration({ ...existing, token });
      const repositoryRoot = yield* Effect.either(
        resolveWorkflowRepositoryRoot({ cwd: options.common.cwd }),
      );
      if (repositoryRoot._tag === "Right") {
        yield* updateRootRemoteCache(repositoryRoot.right, options, selected);
      } else if (options.common.cwd !== undefined) {
        return yield* Effect.fail(repositoryRoot.left);
      }
      yield* terminal.writeStdout("Successfully logged in to turbo-ts.\n");
      return 0;
    }

    if (command === "logout") {
      const existing = (yield* credentials.readUserConfiguration) ?? {};
      const token = settings.token;
      if (options.invalidate && token !== undefined) {
        const response = yield* requestHosted(
          withPath(settings.api, "/v3/user/tokens/current"),
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
      const { token: _removed, ...retained } = existing;
      yield* credentials.writeUserConfiguration(retained);
      yield* terminal.writeStdout(">>> Logged out\n");
      return 0;
    }

    const root = yield* resolveWorkflowRepositoryRoot({
      cwd: options.common.cwd,
    });
    if (command === "unlink") {
      yield* credentials.writeProjectConfiguration(root, {});
      yield* terminal.writeStdout(">>> Disabled Remote Caching\n");
      return 0;
    }

    const token = settings.token;
    if (token === undefined) {
      return yield* Effect.fail(
        fail("not logged in; run `turbo-ts login` first"),
      );
    }
    const scope = options.scope ?? settings.teamId ?? settings.teamSlug;
    if (scope === undefined) {
      return yield* Effect.fail(
        fail("link requires --scope, --team, TURBO_TEAM, or TURBO_TEAMID"),
      );
    }
    const teams = yield* availableHostedTeams(settings, token);
    const team = teams.find(
      (candidate) => candidate.id === scope || candidate.slug === scope,
    );
    if (team === undefined) {
      return yield* Effect.fail(fail(`unknown remote caching scope: ${scope}`));
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
      teamId: team.id,
    });
    if (!options.noGitignore) yield* updateGitIgnore(root);
    yield* terminal.writeStdout(
      `>>> Enabled Remote Caching for ${team.name}\n`,
    );
    return 0;
  });
