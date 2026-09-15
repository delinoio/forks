import { Effect, Exit } from "effect";
import validateNpmPackageName from "validate-npm-package-name";
import { parseCommonArguments } from "../cli/common-options.js";
import { parseJsonConfiguration } from "../config/runtime.js";
import {
  isAbsolutePath,
  isPathContained,
  joinPath,
  parentPath,
  relativePath,
} from "../core/path.js";
import { BoundaryError, ConfigurationError } from "../effect/errors.js";
import {
  EnvironmentService,
  FileSystemService,
  ProcessService,
  RandomnessService,
  TerminalService,
} from "../effect/services.js";
import { canonicalExistingAncestorPath } from "../run/engine.js";
import { resolveWorkflowRepositoryRoot } from "./repository.js";

interface GeneratorAction {
  readonly type?: string;
  readonly path?: string;
  readonly template?: string;
  readonly templateFile?: string;
  readonly skipIfExists?: boolean;
}

interface GeneratorPrompt {
  readonly message: string;
  readonly name: string;
}

type WorkspaceType = "app" | "package";

interface LoadedGeneratorReady {
  readonly kind: "ready";
  readonly description?: string;
  readonly actions: ReadonlyArray<GeneratorAction | string>;
  readonly answers: Readonly<Record<string, unknown>>;
}

interface LoadedGeneratorPrompts {
  readonly kind: "prompts";
  readonly answers: Readonly<Record<string, unknown>>;
  readonly prompts: ReadonlyArray<GeneratorPrompt>;
}

type LoadedGenerator = LoadedGeneratorReady | LoadedGeneratorPrompts;

interface DecodedGeneratorOutput {
  readonly generator: LoadedGenerator;
  readonly stdout: string;
}

interface GenerateOptions {
  readonly answers: Readonly<Record<string, string>>;
  readonly common: ReturnType<typeof parseCommonArguments>["options"];
  readonly config?: string;
  readonly copy?: string;
  readonly destination?: string;
  readonly empty: boolean;
  readonly examplePath?: string;
  readonly generatorName?: string;
  readonly name?: string;
  readonly root?: string;
  readonly showAllDependencies: boolean;
  readonly type?: WorkspaceType;
  readonly workspace: boolean;
}

const failure = (message: string): ConfigurationError =>
  new ConfigurationError({ path: "<arguments>", message });

const nextValue = (
  arguments_: ReadonlyArray<string>,
  index: number,
  name: string,
): readonly [string, number] => {
  const argument = arguments_[index]!;
  if (argument.includes("=")) {
    const value = argument.slice(argument.indexOf("=") + 1);
    if (value === "") throw failure(`${name} requires a value`);
    return [value, index];
  }
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw failure(`${name} requires a value`);
  }
  return [value, index + 1];
};

export const parseGenerateArguments = (
  arguments_: ReadonlyArray<string>,
): GenerateOptions => {
  const parsed = parseCommonArguments(arguments_);
  const answerValues: Array<string> = [];
  const positionals: Array<string> = [];
  let config: string | undefined;
  let copy: string | undefined;
  let destination: string | undefined;
  let empty = false;
  let examplePath: string | undefined;
  let name: string | undefined;
  let root: string | undefined;
  let showAllDependencies = false;
  let type: WorkspaceType | undefined;
  let collectingAnswers = false;
  for (let index = 0; index < parsed.remaining.length; index += 1) {
    const argument = parsed.remaining[index]!;
    const option = argument.split("=", 1)[0]!;
    if (collectingAnswers && !argument.startsWith("-")) {
      answerValues.push(argument);
      continue;
    }
    collectingAnswers = false;
    switch (option) {
      case "--args":
      case "-a": {
        const inline = argument.includes("=")
          ? argument.slice(argument.indexOf("=") + 1)
          : undefined;
        if (inline !== undefined && inline !== "") answerValues.push(inline);
        collectingAnswers = true;
        break;
      }
      case "--config":
        [config, index] = nextValue(parsed.remaining, index, option);
        break;
      case "--copy":
        [copy, index] = nextValue(parsed.remaining, index, option);
        break;
      case "-c":
        if (positionals[0] === "workspace") {
          [copy, index] = nextValue(parsed.remaining, index, option);
        } else {
          [config, index] = nextValue(parsed.remaining, index, option);
        }
        break;
      case "--destination":
      case "-d":
        [destination, index] = nextValue(parsed.remaining, index, option);
        break;
      case "--empty":
      case "-b":
        if (argument !== option) {
          throw failure(`${option} does not accept a value`);
        }
        empty = true;
        break;
      case "--example-path":
      case "-p":
        [examplePath, index] = nextValue(parsed.remaining, index, option);
        break;
      case "--name":
      case "-n":
        [name, index] = nextValue(parsed.remaining, index, option);
        break;
      case "--root":
      case "-r":
        [root, index] = nextValue(parsed.remaining, index, option);
        break;
      case "--show-all-dependencies":
        showAllDependencies = true;
        break;
      case "--type":
      case "-t": {
        let value: string;
        [value, index] = nextValue(parsed.remaining, index, option);
        if (value !== "app" && value !== "package") {
          throw failure(`invalid workspace type: ${value}`);
        }
        type = value;
        break;
      }
      default:
        if (argument.startsWith("-")) {
          throw failure(`unknown option: ${argument}`);
        }
        positionals.push(argument);
    }
  }
  const workspace = positionals[0] === "workspace";
  const generatorName = workspace
    ? undefined
    : positionals[0] === "run"
      ? positionals[1]
      : positionals[0];
  if (positionals.length > (workspace ? 1 : positionals[0] === "run" ? 2 : 1)) {
    throw failure(`unexpected argument: ${positionals.at(-1)}`);
  }
  const answers = Object.fromEntries(
    answerValues.map((value, index) => {
      const separator = value.indexOf("=");
      return separator === -1
        ? [String(index), value]
        : [value.slice(0, separator), value.slice(separator + 1)];
    }),
  );
  return {
    answers,
    common: parsed.options,
    config,
    copy,
    destination,
    empty,
    examplePath,
    generatorName,
    name,
    root,
    showAllDependencies,
    type,
    workspace,
  };
};

const renderTemplate = (
  template: string,
  answers: Readonly<Record<string, unknown>>,
): string =>
  template.replace(/{{{?\s*([A-Za-z0-9_.-]+)\s*}?}}/g, (_match, name: string) =>
    String(answers[name] ?? ""),
  );

const decodeGeneratorOutput = (
  stdout: string,
  marker: string,
): DecodedGeneratorOutput | undefined => {
  const markerIndex = stdout.lastIndexOf(marker);
  if (markerIndex === -1) return undefined;
  const lengthStart = markerIndex + marker.length;
  const lengthEnd = stdout.indexOf(":", lengthStart);
  if (lengthEnd === -1) return undefined;
  const lengthSource = stdout.slice(lengthStart, lengthEnd);
  if (!/^\d+$/.test(lengthSource)) return undefined;
  const length = Number(lengthSource);
  if (!Number.isSafeInteger(length)) return undefined;
  const payloadStart = lengthEnd + 1;
  const payloadEnd = payloadStart + length;
  if (payloadEnd > stdout.length) return undefined;
  try {
    return {
      generator: JSON.parse(
        stdout.slice(payloadStart, payloadEnd),
      ) as LoadedGenerator,
      stdout: `${stdout.slice(0, markerIndex)}${stdout.slice(payloadEnd)}`,
    };
  } catch {
    return undefined;
  }
};

const generatorLoader = `
const { pathToFileURL } = await import("node:url");
const [configurationPath, requestedName, encodedAnswers, resultMarker] = process.argv.slice(1);
const supplied = JSON.parse(encodedAnswers);
const generators = new Map();
const api = { setGenerator(name, definition) { generators.set(name, definition); } };
const writeResult = (result) => {
  const payload = JSON.stringify(result);
  process.stdout.write(resultMarker + payload.length + ":" + payload);
};
const module = await import(pathToFileURL(configurationPath).href + "?turbo_ts=" + Date.now());
if (typeof module.default !== "function") throw new TypeError("generator configuration must default-export a function");
await module.default(api);
const definition = generators.get(requestedName);
if (definition === undefined) throw new TypeError("unknown generator: " + requestedName);
const answers = { ...Object.fromEntries((definition.prompts ?? []).flatMap((prompt) => prompt && typeof prompt === "object" && typeof prompt.name === "string" && prompt.default !== undefined ? [[prompt.name, prompt.default]] : [])), ...supplied };
const unresolved = (definition.prompts ?? []).flatMap((prompt) => prompt && typeof prompt === "object" && typeof prompt.name === "string" && !Object.hasOwn(answers, prompt.name) ? [{ name: prompt.name, message: typeof prompt.message === "string" ? prompt.message : prompt.name }] : []);
if (unresolved.length > 0) {
  writeResult({ kind: "prompts", prompts: unresolved, answers });
} else {
  const actions = typeof definition.actions === "function" ? await definition.actions(answers) : (definition.actions ?? []);
  const resolved = [];
  for (const action of actions) resolved.push(typeof action === "function" ? await action(answers) : action);
  writeResult({ kind: "ready", description: definition.description, actions: resolved, answers });
}
`;

const locateGeneratorConfiguration = (
  root: string,
  configured: string | undefined,
): Effect.Effect<
  string,
  BoundaryError | ConfigurationError,
  FileSystemService
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    if (configured !== undefined) {
      const path = isAbsolutePath(configured)
        ? configured
        : joinPath(root, configured);
      if (!(yield* fileSystem.exists(path))) {
        return yield* Effect.fail(
          failure(`generator configuration does not exist: ${configured}`),
        );
      }
      return path;
    }
    for (const name of [
      "config.ts",
      "config.mts",
      "config.js",
      "config.mjs",
      "config.cjs",
    ]) {
      const path = joinPath(root, "turbo", "generators", name);
      if (yield* fileSystem.exists(path)) return path;
    }
    return yield* Effect.fail(failure("generator configuration was not found"));
  });

const copyTree = (
  source: string,
  destination: string,
): Effect.Effect<void, BoundaryError, FileSystemService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    yield* fileSystem.makeDirectory(destination);
    for (const entry of yield* fileSystem.list(source)) {
      const from = joinPath(source, entry.name);
      const to = joinPath(destination, entry.name);
      if (entry.kind === "directory") {
        yield* copyTree(from, to);
      } else if (entry.kind === "file") {
        yield* fileSystem.copyFile(from, to);
      } else {
        return yield* Effect.fail(
          new BoundaryError({
            boundary: "generator",
            message: `template contains unsupported entry: ${entry.name}`,
            retryable: false,
          }),
        );
      }
    }
  });

const validWorkspaceName = (name: string): boolean =>
  validateNpmPackageName(name).validForNewPackages;

const executeWorkspaceGenerator = (
  root: string,
  options: GenerateOptions,
): Effect.Effect<number, unknown, FileSystemService | TerminalService> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const terminal = yield* TerminalService;
    const name = options.name;
    if (name === undefined || !validWorkspaceName(name)) {
      return yield* Effect.fail(
        failure("workspace generation requires a valid --name"),
      );
    }
    const defaultParent = options.type === "app" ? "apps" : "packages";
    const requestedDestination =
      options.destination ??
      joinPath(defaultParent, name.replace(/^@[^/]+\//, ""));
    const destination = isAbsolutePath(requestedDestination)
      ? requestedDestination
      : joinPath(root, requestedDestination);
    const [canonicalRoot, canonicalDestination] = yield* Effect.all([
      canonicalExistingAncestorPath(root, "generator repository"),
      canonicalExistingAncestorPath(destination, "workspace destination"),
    ]);
    if (
      !isPathContained(canonicalRoot, canonicalDestination) ||
      canonicalDestination === canonicalRoot
    ) {
      return yield* Effect.fail(
        failure("workspace destination must remain inside the repository"),
      );
    }
    if (yield* fileSystem.exists(destination)) {
      return yield* Effect.fail(
        failure("workspace destination already exists"),
      );
    }
    const materialize = Effect.gen(function* () {
      if (options.copy === undefined || options.empty) {
        yield* fileSystem.writeTextAtomic(
          joinPath(destination, "package.json"),
          `${JSON.stringify({ name, version: "0.0.0", private: true }, null, 2)}\n`,
          0o644,
        );
        return;
      }
      if (/^https?:\/\//.test(options.copy)) {
        return yield* Effect.fail(
          failure(
            "remote workspace templates are unavailable in offline generation",
          ),
        );
      }
      const source = isAbsolutePath(options.copy)
        ? options.copy
        : joinPath(root, options.copy);
      if (!(yield* fileSystem.exists(source))) {
        return yield* Effect.fail(failure("workspace template does not exist"));
      }
      const canonicalSource = yield* fileSystem.realPath(source);
      if (!isPathContained(canonicalRoot, canonicalSource)) {
        return yield* Effect.fail(failure("workspace template does not exist"));
      }
      if (isPathContained(canonicalSource, canonicalDestination)) {
        return yield* Effect.fail(
          failure("workspace template must not contain its destination"),
        );
      }
      const manifestPath = joinPath(source, "package.json");
      if (!(yield* fileSystem.exists(manifestPath))) {
        return yield* Effect.fail(
          failure("workspace template must contain a package.json object"),
        );
      }
      const manifestSource = yield* fileSystem.readText(manifestPath);
      const manifest = yield* Effect.try({
        try: () => parseJsonConfiguration(manifestSource, manifestPath),
        catch: (cause) => cause,
      });
      if (
        typeof manifest !== "object" ||
        manifest === null ||
        Array.isArray(manifest)
      ) {
        return yield* Effect.fail(
          failure("workspace template must contain a package.json object"),
        );
      }
      yield* copyTree(source, destination);
      yield* fileSystem.writeTextAtomic(
        joinPath(destination, "package.json"),
        `${JSON.stringify({ ...manifest, name }, null, 2)}\n`,
        0o644,
      );
    });
    yield* fileSystem.makeDirectory(parentPath(destination));
    yield* Effect.acquireUseRelease(
      fileSystem.createExclusiveDirectory(destination),
      (ownsDestination) =>
        ownsDestination
          ? materialize
          : Effect.fail(failure("workspace destination already exists")),
      (ownsDestination, exit) =>
        ownsDestination && Exit.isFailure(exit)
          ? fileSystem.remove(destination).pipe(Effect.orDie)
          : Effect.void,
    );
    yield* terminal.writeStdout(
      `Generated workspace ${name} at ${destination}\n`,
    );
    return 0;
  });

export const executeGenerate = (
  arguments_: ReadonlyArray<string>,
): Effect.Effect<
  number,
  unknown,
  | EnvironmentService
  | FileSystemService
  | ProcessService
  | RandomnessService
  | TerminalService
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const options = parseGenerateArguments(arguments_);
      const environment = yield* EnvironmentService;
      const fileSystem = yield* FileSystemService;
      const processService = yield* ProcessService;
      const randomness = yield* RandomnessService;
      const terminal = yield* TerminalService;
      const root = yield* resolveWorkflowRepositoryRoot({
        cwd: options.root ?? options.common.cwd,
      });
      if (options.workspace)
        return yield* executeWorkspaceGenerator(root, options);
      const generatorName = options.generatorName;
      if (generatorName === undefined) {
        return yield* Effect.fail(failure("a generator name is required"));
      }
      const configuration = yield* locateGeneratorConfiguration(
        root,
        options.config,
      );
      const executable =
        environment.executablePath === undefined
          ? "node"
          : yield* environment.executablePath;
      const loadGenerator = (answers: Readonly<Record<string, unknown>>) =>
        Effect.gen(function* () {
          const resultMarker = `\u001eturbo-ts-generator-result:${yield* randomness.uuidV7}\u001e`;
          const loadedResult = yield* processService.run({
            command: executable,
            args: [
              "--input-type=module",
              "--eval",
              generatorLoader,
              configuration,
              generatorName,
              JSON.stringify(answers),
              resultMarker,
            ],
            cwd: root,
            inheritEnvironment: true,
            maxCapturedOutputCharacters: 1024 * 1024,
          });
          if (loadedResult.exitCode !== 0) {
            if (loadedResult.stdout !== "") {
              yield* terminal.writeStdout(loadedResult.stdout);
            }
            if (loadedResult.stderr !== "") {
              yield* terminal.writeStderr(loadedResult.stderr);
            }
            return yield* Effect.fail(
              new BoundaryError({
                boundary: "generator",
                message: "generator configuration failed",
                retryable: false,
              }),
            );
          }
          const decoded = decodeGeneratorOutput(
            loadedResult.stdout,
            resultMarker,
          );
          if (decoded === undefined) {
            if (loadedResult.stdout !== "") {
              yield* terminal.writeStdout(loadedResult.stdout);
            }
            if (loadedResult.stderr !== "") {
              yield* terminal.writeStderr(loadedResult.stderr);
            }
            return yield* Effect.fail(
              failure("generator returned invalid output"),
            );
          }
          if (decoded.stdout !== "") {
            yield* terminal.writeStdout(decoded.stdout);
          }
          if (loadedResult.stderr !== "") {
            yield* terminal.writeStderr(loadedResult.stderr);
          }
          return decoded.generator;
        });
      let loaded = yield* loadGenerator(options.answers);
      if (loaded.kind === "prompts") {
        const interactive =
          terminal.stdinIsTerminal === undefined
            ? false
            : yield* terminal.stdinIsTerminal;
        if (!interactive || terminal.readLine === undefined) {
          return yield* Effect.fail(
            failure(
              "generator prompts require an interactive terminal or supplied --args",
            ),
          );
        }
        const answers: Record<string, unknown> = { ...loaded.answers };
        for (const prompt of loaded.prompts) {
          answers[prompt.name] = yield* terminal.readLine(
            `${prompt.message}: `,
          );
        }
        loaded = yield* loadGenerator(answers);
        if (loaded.kind === "prompts") {
          return yield* Effect.fail(
            failure("generator prompts remain unresolved"),
          );
        }
      }
      const configurationDirectory = parentPath(configuration);
      const canonicalRoot = yield* canonicalExistingAncestorPath(
        root,
        "generator repository",
      );
      for (const action of loaded.actions) {
        if (typeof action === "string") {
          yield* terminal.writeStdout(`${action}\n`);
          continue;
        }
        if (action.type !== undefined && action.type !== "add") {
          return yield* Effect.fail(
            failure(`unsupported generator action: ${action.type}`),
          );
        }
        if (action.path === undefined) {
          return yield* Effect.fail(
            failure("generator add action requires a path"),
          );
        }
        const destination = joinPath(
          root,
          renderTemplate(action.path, loaded.answers),
        );
        const canonicalDestination = yield* canonicalExistingAncestorPath(
          destination,
          "generator action destination",
        );
        if (
          !isPathContained(canonicalRoot, canonicalDestination) ||
          canonicalDestination === canonicalRoot
        ) {
          return yield* Effect.fail(
            failure("generator action escapes the repository"),
          );
        }
        if (
          action.skipIfExists === true &&
          (yield* fileSystem.exists(destination))
        )
          continue;
        let template = action.template;
        if (template === undefined && action.templateFile !== undefined) {
          const templatePath = joinPath(
            configurationDirectory,
            action.templateFile,
          );
          if (!isPathContained(root, templatePath)) {
            return yield* Effect.fail(
              failure("generator template escapes the repository"),
            );
          }
          template = yield* fileSystem.readText(templatePath);
        }
        if (template === undefined) {
          return yield* Effect.fail(
            failure("generator add action requires a template"),
          );
        }
        yield* fileSystem.makeDirectory(parentPath(destination));
        yield* fileSystem.writeTextAtomic(
          destination,
          renderTemplate(template, loaded.answers),
          0o644,
        );
        yield* terminal.writeStdout(
          `created ${relativePath(root, destination)}\n`,
        );
      }
      return 0;
    }),
  );
