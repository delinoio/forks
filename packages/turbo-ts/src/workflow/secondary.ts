import { Effect } from "effect";
import { parseCommonArguments } from "../cli/common-options.js";
import { parseJsonConfiguration } from "../config/runtime.js";
import { isPathContained, joinPath, normalizePath } from "../core/path.js";
import { BoundaryError, ConfigurationError } from "../effect/errors.js";
import {
  CredentialService,
  EnvironmentService,
  FileSystemService,
  HttpService,
  ProcessService,
  TerminalService,
} from "../effect/services.js";
import { packageVersion } from "../version.js";
import { boundaryDiagnostics } from "./query.js";
import {
  loadWorkflowRepository,
  repositoryPackageManagerLabel,
  resolveWorkflowRepositoryRoot,
} from "./repository.js";

type SecondaryCommand =
  | "bin"
  | "boundaries"
  | "config"
  | "docs"
  | "get-mfe-port"
  | "scan";

const argumentError = (message: string): ConfigurationError =>
  new ConfigurationError({ path: "<arguments>", message });

const readValue = (
  arguments_: ReadonlyArray<string>,
  index: number,
  name: string,
): readonly [string, number] => {
  const argument = arguments_[index]!;
  if (argument.includes("=")) {
    const value = argument.slice(argument.indexOf("=") + 1);
    if (value === "") throw argumentError(`${name} requires a value`);
    return [value, index];
  }
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw argumentError(`${name} requires a value`);
  }
  return [value, index + 1];
};

const requireNoSecondaryArguments = (
  arguments_: ReadonlyArray<string>,
): void => {
  const parsed = parseCommonArguments(arguments_);
  if (parsed.remaining.length > 0) {
    throw argumentError(`unexpected argument: ${parsed.remaining[0]}`);
  }
};

const executeBin = (
  arguments_: ReadonlyArray<string>,
): Effect.Effect<number, unknown, EnvironmentService | TerminalService> =>
  Effect.gen(function* () {
    requireNoSecondaryArguments(arguments_);
    const environment = yield* EnvironmentService;
    const terminal = yield* TerminalService;
    const argv = yield* environment.argv;
    yield* terminal.writeStdout(`${argv[1] ?? "turbo-ts"}\n`);
    return 0;
  });

const executeScan = (
  arguments_: ReadonlyArray<string>,
): Effect.Effect<number, unknown, TerminalService> =>
  Effect.gen(function* () {
    requireNoSecondaryArguments(arguments_);
    const terminal = yield* TerminalService;
    yield* terminal.writeStderr(
      "[DEPRECATED] `turbo-ts scan` has been removed. This command will be fully removed in a future major version\n",
    );
    return 1;
  });

const executeConfig = (
  arguments_: ReadonlyArray<string>,
): Effect.Effect<
  number,
  unknown,
  | CredentialService
  | EnvironmentService
  | FileSystemService
  | ProcessService
  | TerminalService
> =>
  Effect.gen(function* () {
    const parsed = parseCommonArguments(arguments_);
    if (parsed.remaining.length > 0) {
      return yield* Effect.fail(
        argumentError(`unknown option: ${parsed.remaining[0]}`),
      );
    }
    const environment = yield* EnvironmentService;
    const credentials = yield* CredentialService;
    const terminal = yield* TerminalService;
    const repository = yield* loadWorkflowRepository({
      cwd: parsed.options.cwd,
      rootTurboJson: parsed.options.rootTurboJson,
    });
    const root = repository.rootConfiguration.value;
    const global =
      root.futureFlags?.globalConfiguration === true ? root.global : root;
    const project = yield* credentials.readProjectConfiguration(
      repository.root,
    );
    const environmentValue = (name: string) => environment.get(name);
    const apiUrl =
      parsed.options.apiUrl ??
      (yield* environmentValue("TURBO_API")) ??
      project?.apiUrl ??
      global?.remoteCache?.apiUrl ??
      "https://vercel.com/api";
    const output = {
      apiUrl,
      loginUrl:
        parsed.options.loginUrl ??
        (yield* environmentValue("TURBO_LOGIN")) ??
        global?.remoteCache?.loginUrl ??
        "https://vercel.com",
      teamSlug:
        parsed.options.team ??
        (yield* environmentValue("TURBO_TEAM")) ??
        project?.teamSlug ??
        global?.remoteCache?.teamSlug ??
        null,
      teamId:
        (yield* environmentValue("TURBO_TEAMID")) ??
        project?.teamId ??
        global?.remoteCache?.teamId ??
        null,
      signature: global?.remoteCache?.signature ?? false,
      preflight:
        parsed.options.preflight || (global?.remoteCache?.preflight ?? false),
      timeout:
        parsed.options.remoteCacheTimeoutSeconds ??
        global?.remoteCache?.timeout ??
        30,
      uploadTimeout: global?.remoteCache?.uploadTimeout ?? 60,
      enabled: global?.remoteCache?.enabled ?? true,
      ui: parsed.options.ui ?? global?.ui ?? "stream",
      packageManager: repositoryPackageManagerLabel(repository),
      daemon: global?.daemon ?? null,
      envMode: global?.envMode ?? "strict",
      scmBase: (yield* environmentValue("TURBO_SCM_BASE")) ?? null,
      scmHead: (yield* environmentValue("TURBO_SCM_HEAD")) ?? null,
      cacheDir: global?.cacheDir ?? ".turbo/cache",
      concurrency: global?.concurrency ?? null,
    };
    yield* terminal.writeStdout(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  });

const executeBoundaries = (
  arguments_: ReadonlyArray<string>,
): Effect.Effect<
  number,
  unknown,
  EnvironmentService | FileSystemService | ProcessService | TerminalService
> =>
  Effect.gen(function* () {
    const parsed = parseCommonArguments(arguments_);
    const filters: Array<string> = [];
    let ignore: "all" | "prompt" | undefined;
    let reason: string | undefined;
    for (let index = 0; index < parsed.remaining.length; index += 1) {
      const argument = parsed.remaining[index]!;
      const name = argument.split("=", 1)[0]!;
      if (name === "--filter" || name === "-F") {
        let value: string;
        [value, index] = readValue(parsed.remaining, index, name);
        filters.push(value);
      } else if (name === "--reason") {
        [reason, index] = readValue(parsed.remaining, index, name);
      } else if (name === "--ignore") {
        const value = argument.includes("=")
          ? argument.slice(argument.indexOf("=") + 1)
          : "prompt";
        if (value !== "all" && value !== "prompt") {
          return yield* Effect.fail(
            argumentError(`invalid ignore mode: ${value}`),
          );
        }
        ignore = value;
      } else {
        return yield* Effect.fail(argumentError(`unknown option: ${argument}`));
      }
    }
    if (ignore !== undefined && reason === undefined) {
      return yield* Effect.fail(argumentError("--ignore requires --reason"));
    }
    const terminal = yield* TerminalService;
    const repository = yield* loadWorkflowRepository({
      cwd: parsed.options.cwd,
      rootTurboJson: parsed.options.rootTurboJson,
    });
    const diagnostics = boundaryDiagnostics(repository).filter(
      (diagnostic) =>
        filters.length === 0 ||
        filters.some(
          (filter) =>
            diagnostic.import === filter || diagnostic.path.includes(filter),
        ),
    );
    for (const diagnostic of diagnostics) {
      yield* terminal.writeStderr(
        `${diagnostic.message}\n  at ${diagnostic.path}: ${diagnostic.import}${
          reason === undefined ? "" : ` (${reason})`
        }\n`,
      );
    }
    return diagnostics.length === 0 || ignore === "all" ? 0 : 1;
  });

const compareVersions = (left: string, right: string): number => {
  const parse = (value: string) =>
    value
      .replace(/^v/, "")
      .split(".")
      .map((part) => Number(part));
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

export const executeForcedUpdateCheck = (
  endpoint?: string,
): Effect.Effect<number, unknown, HttpService | TerminalService> =>
  Effect.gen(function* () {
    const http = yield* HttpService;
    const terminal = yield* TerminalService;
    const response = yield* http.request({
      url:
        endpoint ??
        "https://api.github.com/repos/vercel/turborepo/tags?per_page=100",
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": `turbo-ts/${packageVersion}`,
      },
      timeoutMilliseconds: 10_000,
      maxResponseBodyBytes: 1024 * 1024,
    });
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new BoundaryError({
          boundary: "update",
          message: `update check returned ${response.status}`,
          retryable: response.status === 429 || response.status >= 500,
        }),
      );
    }
    let tags: unknown;
    try {
      tags = JSON.parse(new TextDecoder().decode(response.body));
    } catch {
      return yield* Effect.fail(argumentError("update response is invalid"));
    }
    const stable = Array.isArray(tags)
      ? tags
          .flatMap((tag) =>
            typeof tag === "object" &&
            tag !== null &&
            "name" in tag &&
            typeof tag.name === "string" &&
            /^v?\d+\.\d+\.\d+$/.test(tag.name)
              ? [tag.name.replace(/^v/, "")]
              : [],
          )
          .sort((left, right) => compareVersions(right, left))[0]
      : undefined;
    if (stable === undefined) {
      return yield* Effect.fail(
        argumentError("update response has no stable tag"),
      );
    }
    yield* terminal.writeStdout(
      compareVersions(stable, "2.10.12") > 0
        ? `A newer stable Turbo baseline is available: ${stable} (turbo-ts targets 2.10.12).\n`
        : "turbo-ts targets the latest stable Turbo baseline (2.10.12).\n",
    );
    return 0;
  });

const executeDocs = (
  arguments_: ReadonlyArray<string>,
): Effect.Effect<
  number,
  unknown,
  EnvironmentService | HttpService | TerminalService
> =>
  Effect.gen(function* () {
    const parsed = parseCommonArguments(arguments_);
    let docsVersion = "2.10.12";
    const query: Array<string> = [];
    for (let index = 0; index < parsed.remaining.length; index += 1) {
      const argument = parsed.remaining[index]!;
      const name = argument.split("=", 1)[0]!;
      if (name === "--docs-version") {
        [docsVersion, index] = readValue(parsed.remaining, index, name);
      } else if (argument.startsWith("-")) {
        return yield* Effect.fail(argumentError(`unknown option: ${argument}`));
      } else {
        query.push(argument);
      }
    }
    if (query.length === 0) {
      return yield* Effect.fail(argumentError("docs requires a search query"));
    }
    if (
      !/^\d+\.\d+\.\d+$/.test(docsVersion) ||
      compareVersions(docsVersion, "2.7.5") < 0
    ) {
      return yield* Effect.fail(
        argumentError("docs version must be at least 2.7.5"),
      );
    }
    const http = yield* HttpService;
    const environment = yield* EnvironmentService;
    const terminal = yield* TerminalService;
    const endpoint = new URL(
      (yield* environment.get("TURBO_TS_DOCS_ENDPOINT")) ??
        `https://v${docsVersion.replaceAll(".", "-")}.turborepo.dev/api/search`,
    );
    endpoint.searchParams.set("query", query.join(" "));
    const response = yield* http.request({
      url: endpoint.toString(),
      method: "GET",
      headers: { "user-agent": `turbo-ts/${packageVersion}` },
      timeoutMilliseconds: Math.round(
        (parsed.options.remoteCacheTimeoutSeconds ?? 30) * 1_000,
      ),
      maxResponseBodyBytes: 1024 * 1024,
    });
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new BoundaryError({
          boundary: "docs",
          message: `documentation search returned ${response.status}`,
          retryable: response.status === 429 || response.status >= 500,
        }),
      );
    }
    let document: unknown;
    try {
      document = JSON.parse(new TextDecoder().decode(response.body));
    } catch {
      return yield* Effect.fail(
        argumentError("documentation response is invalid"),
      );
    }
    const unfilteredResults = Array.isArray(document)
      ? document
      : typeof document === "object" &&
          document !== null &&
          "results" in document &&
          Array.isArray(document.results)
        ? document.results
        : [];
    const results = unfilteredResults.filter(
      (result) =>
        typeof result === "object" &&
        result !== null &&
        (!("type" in result) || result.type === "page"),
    );
    yield* terminal.writeStdout(
      `Found ${results.length} results for '${query.join(" ")}':\n`,
    );
    let renderedIndex = 0;
    for (const result of results) {
      if (typeof result !== "object" || result === null) continue;
      renderedIndex += 1;
      const title =
        "title" in result
          ? String(result.title)
          : "content" in result
            ? String(result.content)
            : "Turborepo documentation";
      const url =
        "url" in result
          ? new URL(String(result.url), endpoint.origin).toString()
          : "href" in result
            ? new URL(String(result.href), endpoint.origin).toString()
            : "";
      yield* terminal.writeStdout(`\n${renderedIndex}. ${title}: ${url}\n`);
    }
    const colorEnabled =
      parsed.options.color !== false && (yield* terminal.stdoutColorEnabled);
    const note =
      'If you are an AI agent or LLM, retrieve a markdown version of the docs with ".md" appended.';
    yield* terminal.writeStdout(
      colorEnabled ? `\n\u001B[8m${note}\u001B[0m\n` : `\n${note}\n`,
    );
    return 0;
  });

export const selectCurrentPackage = <A extends { readonly directory: string }>(
  packages: ReadonlyArray<A>,
  cwd: string,
  windowsPathSeparators: boolean,
): A | undefined => {
  const normalizedCwd = normalizePath(cwd, windowsPathSeparators);
  return packages
    .filter((packageModel) =>
      isPathContained(
        packageModel.directory,
        normalizedCwd,
        windowsPathSeparators,
      ),
    )
    .sort((left, right) => right.directory.length - left.directory.length)[0];
};

const readMicrofrontendPort = (
  arguments_: ReadonlyArray<string>,
): Effect.Effect<
  number,
  unknown,
  EnvironmentService | FileSystemService | ProcessService | TerminalService
> =>
  Effect.gen(function* () {
    const parsed = parseCommonArguments(arguments_);
    if (parsed.remaining.length > 0) {
      return yield* Effect.fail(
        argumentError(`unknown option: ${parsed.remaining[0]}`),
      );
    }
    const environment = yield* EnvironmentService;
    const fileSystem = yield* FileSystemService;
    const terminal = yield* TerminalService;
    const processCwd = yield* environment.cwd;
    const platform = yield* environment.platform;
    const windowsPathSeparators = platform === "win32";
    const repository = yield* loadWorkflowRepository({
      cwd: parsed.options.cwd,
      rootTurboJson: parsed.options.rootTurboJson,
    });
    const packages = [repository.rootPackage, ...repository.packages];
    const currentPackage = selectCurrentPackage(
      packages,
      processCwd,
      windowsPathSeparators,
    );
    if (
      currentPackage === undefined ||
      currentPackage === repository.rootPackage
    ) {
      return yield* Effect.fail(
        argumentError(
          "current directory does not belong to a named JavaScript package",
        ),
      );
    }
    let configurationPath: string | undefined;
    const configurationOwners = packages
      .filter((packageModel) =>
        isPathContained(
          packageModel.directory,
          currentPackage.directory,
          windowsPathSeparators,
        ),
      )
      .sort((left, right) => right.directory.length - left.directory.length);
    for (const packageModel of configurationOwners) {
      const candidate = joinPath(packageModel.directory, "microfrontends.json");
      if (yield* fileSystem.exists(candidate)) {
        configurationPath = candidate;
        break;
      }
    }
    if (configurationPath === undefined) {
      return yield* Effect.fail(
        argumentError("no microfrontends configuration found"),
      );
    }
    const raw = parseJsonConfiguration(
      yield* fileSystem.readText(configurationPath),
      configurationPath,
    ) as Record<string, unknown>;
    const applications =
      typeof raw.applications === "object" && raw.applications !== null
        ? (raw.applications as Record<string, unknown>)
        : {};
    const match = Object.entries(applications).find(([name, value]) => {
      if (typeof value !== "object" || value === null) return false;
      const packageName =
        "packageName" in value && typeof value.packageName === "string"
          ? value.packageName
          : name;
      return packageName === currentPackage.name;
    });
    const development =
      match !== undefined &&
      typeof match[1] === "object" &&
      match[1] !== null &&
      "development" in match[1] &&
      typeof match[1].development === "object" &&
      match[1].development !== null
        ? match[1].development
        : undefined;
    const local =
      development !== undefined && "local" in development
        ? development.local
        : undefined;
    const configuredPort =
      typeof local === "number"
        ? local
        : typeof local === "object" &&
            local !== null &&
            "port" in local &&
            typeof local.port === "number"
          ? local.port
          : undefined;
    let hash = 0;
    for (const character of currentPackage.name) {
      hash = (Math.imul(hash, 31) + (character.codePointAt(0) ?? 0)) | 0;
    }
    const port = configuredPort ?? 3_000 + (Math.abs(hash) % 5_000);
    if (
      !Number.isSafeInteger(port) ||
      (port ?? 0) <= 0 ||
      (port ?? 0) > 65_535
    ) {
      return yield* Effect.fail(
        argumentError("no microfrontend port is configured for this workspace"),
      );
    }
    yield* terminal.writeStdout(`${port}\n`);
    return 0;
  });

export const executeSecondaryCommand = (
  command: SecondaryCommand,
  arguments_: ReadonlyArray<string>,
): Effect.Effect<number, unknown, never> => {
  switch (command) {
    case "bin":
      return executeBin(arguments_) as Effect.Effect<number, unknown, never>;
    case "boundaries":
      return executeBoundaries(arguments_) as Effect.Effect<
        number,
        unknown,
        never
      >;
    case "config":
      return executeConfig(arguments_) as Effect.Effect<number, unknown, never>;
    case "docs":
      return executeDocs(arguments_) as Effect.Effect<number, unknown, never>;
    case "get-mfe-port":
      return readMicrofrontendPort(arguments_) as Effect.Effect<
        number,
        unknown,
        never
      >;
    case "scan":
      return executeScan(arguments_) as Effect.Effect<number, unknown, never>;
  }
};
