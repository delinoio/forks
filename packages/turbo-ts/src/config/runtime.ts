import { Effect, Schema } from "effect";
import { joinPath } from "../core/path.js";
import {
  ConfigurationError,
  UnsupportedCompatibilityError,
} from "../effect/errors.js";
import { FileSystemService } from "../effect/services.js";
import type {
  BoundariesConfig,
  Pipeline,
  RootSchema,
  WorkspaceSchema,
} from "../generated/configuration.js";
import {
  InternalFutureFlagsSchema,
  RootSchemaSchema,
  WorkspaceSchemaSchema,
} from "./schema.js";

export interface LoadedRootConfiguration {
  readonly path: string;
  readonly value: RootSchema;
  readonly hiddenFutureFlags: Readonly<Record<string, boolean>>;
}

export interface LoadedPackageConfiguration {
  readonly path?: string;
  readonly tags?: ReadonlyArray<string> | null;
  readonly boundaries?: BoundariesConfig | null;
  readonly tasks: Readonly<Record<string, Pipeline>>;
  readonly excludedTasks: ReadonlySet<string>;
}

const stripTrailingCommas = (source: string): string => {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === ",") {
      let nextIndex = index + 1;
      while (/\s/.test(source[nextIndex] ?? "")) {
        nextIndex += 1;
      }
      if (source[nextIndex] === "}" || source[nextIndex] === "]") {
        continue;
      }
    }
    output += character;
  }
  return output;
};

const stripJsonComments = (source: string): string => {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      let closed = false;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        output += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index < source.length) {
        closed = true;
      }
      if (!closed) {
        throw new TypeError("unterminated block comment");
      }
      index += 1;
      continue;
    }
    output += character;
  }
  return stripTrailingCommas(output);
};

export const parseJsonConfiguration = (
  source: string,
  path: string,
): unknown => {
  try {
    return JSON.parse(stripJsonComments(source)) as unknown;
  } catch (cause) {
    throw new ConfigurationError({ path, message: String(cause) });
  }
};

const decodeConfiguration = <A, I>(
  schema: Schema.Schema<A, I>,
  value: unknown,
  path: string,
): A => {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch (cause) {
    throw new ConfigurationError({ path, message: String(cause) });
  }
};

const expectObject = (
  value: unknown,
  path: string,
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError({
      path,
      message: "configuration must be an object",
    });
  }
  return value as Record<string, unknown>;
};

const rootKeys = new Set([
  "$schema",
  "boundaries",
  "cacheDir",
  "cacheMaxAge",
  "cacheMaxSize",
  "concurrency",
  "daemon",
  "dangerouslyDisablePackageManagerCheck",
  "envMode",
  "futureFlags",
  "global",
  "globalDependencies",
  "globalEnv",
  "globalPassThroughEnv",
  "noUpdateNotifier",
  "remoteCache",
  "tasks",
  "ui",
]);

const workspaceKeys = new Set([
  "$schema",
  "boundaries",
  "extends",
  "tags",
  "tasks",
]);

const rootTaskKeys = new Set([
  "cache",
  "dependsOn",
  "description",
  "env",
  "inputs",
  "interactive",
  "interruptible",
  "outputLogs",
  "outputs",
  "passThroughEnv",
  "persistent",
  "with",
]);

const workspaceTaskKeys = new Set([...rootTaskKeys, "extends"]);

const structuredInputKeys = new Set(["from", "globs", "mode", "withDefaults"]);

const globalKeys = new Set([
  "cacheDir",
  "cacheMaxAge",
  "cacheMaxSize",
  "concurrency",
  "daemon",
  "dangerouslyDisablePackageManagerCheck",
  "env",
  "envMode",
  "inputs",
  "noUpdateNotifier",
  "passThroughEnv",
  "remoteCache",
  "ui",
]);

const remoteCacheKeys = new Set([
  "apiUrl",
  "enabled",
  "loginUrl",
  "preflight",
  "signature",
  "teamId",
  "teamSlug",
  "timeout",
  "uploadTimeout",
]);

const boundariesKeys = new Set([
  "dependencies",
  "dependents",
  "implicitDependencies",
  "tags",
]);
const permissionKeys = new Set(["allow", "deny"]);
const tagRuleKeys = new Set(["dependencies", "dependents"]);

const futureFlagKeys = new Set([
  "affectedUsingTaskInputs",
  "errorsOnlyShowHash",
  "experimentalCargoSccache",
  "experimentalCargoWorkspaces",
  "experimentalObservability",
  "experimentalPythonWorkspaces",
  "filterUsingTasks",
  "githubActionsRemoteBaseRefFallback",
  "globalConfiguration",
  "longerSignatureKey",
  "pruneIncludesGlobalFiles",
  "strictTaskEntrypointSelection",
  "watchUsingTaskInputs",
]);

const assertKnownKeys = (
  object: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void => {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new ConfigurationError({ path, message: `unknown key: ${key}` });
    }
  }
};

const validateTaskStructure = (
  value: unknown,
  path: string,
  allowedKeys: ReadonlySet<string> = rootTaskKeys,
): void => {
  if (value === undefined || value === null) {
    return;
  }
  const tasks = expectObject(value, path);
  for (const [name, definition] of Object.entries(tasks)) {
    const taskPath = `${path}:tasks.${name}`;
    const task = expectObject(definition, taskPath);
    assertKnownKeys(task, allowedKeys, taskPath);
    if (Array.isArray(task.inputs)) {
      for (const [index, input] of task.inputs.entries()) {
        if (typeof input === "object" && input !== null) {
          const inputPath = `${taskPath}.inputs[${index}]`;
          const structuredInput = expectObject(input, inputPath);
          assertKnownKeys(structuredInput, structuredInputKeys, inputPath);
          if (structuredInput.mode === "dependencyOutputs") {
            throw new ConfigurationError({
              path: inputPath,
              message:
                "dependencyOutputs inputs are not implemented in compatibility gate 2",
            });
          }
        }
      }
    }
  }
};

const validateTaskInvariants = (value: unknown, path: string): void => {
  if (value === undefined || value === null) {
    return;
  }
  const tasks = expectObject(value, path);
  for (const [name, definition] of Object.entries(tasks)) {
    const taskPath = `${path}:tasks.${name}`;
    const task = expectObject(definition, taskPath);
    if (task.interactive === true && task.cache !== false) {
      throw new ConfigurationError({
        path: taskPath,
        message: "interactive tasks must disable caching",
      });
    }
    if (task.interruptible === true && task.persistent !== true) {
      throw new ConfigurationError({
        path: taskPath,
        message: "interruptible tasks must be persistent",
      });
    }
  }
};

const validatePermissions = (value: unknown, path: string): void => {
  if (value === undefined || value === null) return;
  assertKnownKeys(expectObject(value, path), permissionKeys, path);
};

const validateBoundaries = (
  value: unknown,
  path: string,
  root: boolean,
): void => {
  if (value === undefined || value === null) return;
  const boundaries = expectObject(value, path);
  assertKnownKeys(
    boundaries,
    root
      ? boundariesKeys
      : new Set([...boundariesKeys].filter((key) => key !== "tags")),
    path,
  );
  validatePermissions(boundaries.dependencies, `${path}.dependencies`);
  validatePermissions(boundaries.dependents, `${path}.dependents`);
  if (boundaries.tags !== undefined && boundaries.tags !== null) {
    const tags = expectObject(boundaries.tags, `${path}.tags`);
    for (const [tag, value] of Object.entries(tags)) {
      const tagPath = `${path}.tags.${tag}`;
      const rules = expectObject(value, tagPath);
      assertKnownKeys(rules, tagRuleKeys, tagPath);
      validatePermissions(rules.dependencies, `${tagPath}.dependencies`);
      validatePermissions(rules.dependents, `${tagPath}.dependents`);
    }
  }
};

const validateRemoteCache = (value: unknown, path: string): void => {
  if (value === undefined || value === null) return;
  assertKnownKeys(expectObject(value, path), remoteCacheKeys, path);
};

const validateRootNestedKeys = (
  document: Record<string, unknown>,
  path: string,
): void => {
  validateRemoteCache(document.remoteCache, `${path}:remoteCache`);
  validateBoundaries(document.boundaries, `${path}:boundaries`, true);
  if (document.global !== undefined && document.global !== null) {
    const global = expectObject(document.global, `${path}:global`);
    assertKnownKeys(global, globalKeys, `${path}:global`);
    validateRemoteCache(global.remoteCache, `${path}:global.remoteCache`);
  }
};

const legacyGlobalKeys = [
  "cacheDir",
  "cacheMaxAge",
  "cacheMaxSize",
  "concurrency",
  "daemon",
  "dangerouslyDisablePackageManagerCheck",
  "envMode",
  "globalDependencies",
  "globalEnv",
  "globalPassThroughEnv",
  "noUpdateNotifier",
  "remoteCache",
  "ui",
] as const;

const validateConfigurationEffect = <A>(
  path: string,
  evaluate: () => A,
): Effect.Effect<A, ConfigurationError> =>
  Effect.try({
    try: evaluate,
    catch: (cause) =>
      cause instanceof ConfigurationError
        ? cause
        : new ConfigurationError({ path, message: String(cause) }),
  });

export const loadRootConfiguration = (
  root: string,
  overridePath?: string,
): Effect.Effect<
  LoadedRootConfiguration,
  ConfigurationError | UnsupportedCompatibilityError,
  FileSystemService
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const jsonPath = overridePath ?? joinPath(root, "turbo.json");
    const jsoncPath = overridePath ?? joinPath(root, "turbo.jsonc");
    const hasJson = yield* fileSystem
      .exists(jsonPath)
      .pipe(
        Effect.mapError(
          (error) =>
            new ConfigurationError({ path: jsonPath, message: error.message }),
        ),
      );
    const hasJsonc =
      overridePath === undefined
        ? yield* fileSystem.exists(jsoncPath).pipe(
            Effect.mapError(
              (error) =>
                new ConfigurationError({
                  path: jsoncPath,
                  message: error.message,
                }),
            ),
          )
        : false;
    if (hasJson && hasJsonc) {
      return yield* Effect.fail(
        new ConfigurationError({
          path: root,
          message: "both turbo.json and turbo.jsonc are present",
        }),
      );
    }
    const path = hasJson ? jsonPath : hasJsonc ? jsoncPath : jsonPath;
    if (!hasJson && !hasJsonc) {
      if (overridePath !== undefined) {
        return yield* Effect.fail(
          new ConfigurationError({
            path: overridePath,
            message: `explicit root configuration does not exist: ${overridePath}`,
          }),
        );
      }
      return { path, value: {}, hiddenFutureFlags: {} };
    }
    const source = yield* fileSystem
      .readText(path)
      .pipe(
        Effect.mapError(
          (error) => new ConfigurationError({ path, message: error.message }),
        ),
      );
    const validated = yield* validateConfigurationEffect(path, () => {
      const document = expectObject(parseJsonConfiguration(source, path), path);
      assertKnownKeys(document, rootKeys, path);
      validateRootNestedKeys(document, path);
      validateTaskStructure(document.tasks, path);
      validateTaskInvariants(document.tasks, path);
      const futureFlags =
        document.futureFlags === null || document.futureFlags === undefined
          ? {}
          : decodeConfiguration(
              InternalFutureFlagsSchema,
              (() => {
                const flags = expectObject(document.futureFlags, path);
                assertKnownKeys(flags, futureFlagKeys, `${path}:futureFlags`);
                return flags;
              })(),
              path,
            );
      if (
        document.global !== undefined &&
        document.global !== null &&
        futureFlags.globalConfiguration !== true
      ) {
        throw new ConfigurationError({
          path: `${path}:global`,
          message: 'the "global" key requires futureFlags.globalConfiguration',
        });
      }
      if (futureFlags.globalConfiguration === true) {
        for (const key of legacyGlobalKeys) {
          if (document[key] !== undefined && document[key] !== null) {
            throw new ConfigurationError({
              path: `${path}:${key}`,
              message: `${key} must be moved inside the "global" key when futureFlags.globalConfiguration is enabled`,
            });
          }
        }
      }
      const publicDocument: Record<string, unknown> = {
        ...document,
        futureFlags:
          document.futureFlags === null || document.futureFlags === undefined
            ? document.futureFlags
            : Object.fromEntries(
                Object.entries(futureFlags).filter(
                  ([name]) => name !== "experimentalCargoSccache",
                ),
              ),
      };
      return {
        path,
        value: decodeConfiguration(RootSchemaSchema, publicDocument, path),
        hiddenFutureFlags: futureFlags,
      } satisfies LoadedRootConfiguration;
    });
    if (validated.hiddenFutureFlags.experimentalCargoSccache === true) {
      return yield* Effect.fail(
        new UnsupportedCompatibilityError({
          surface: "futureFlags.experimentalCargoSccache",
          targetGate: 2,
        }),
      );
    }
    return validated;
  });

const mergeArray = <A>(
  parent: ReadonlyArray<A> | null | undefined,
  child: ReadonlyArray<A> | null | undefined,
): ReadonlyArray<A> | null | undefined => {
  if (child === undefined) {
    return parent;
  }
  if (child === null) {
    return null;
  }
  const marker = child.indexOf("$TURBO_EXTENDS$" as A);
  return marker === -1
    ? child
    : [
        ...child.slice(0, marker),
        ...(parent ?? []),
        ...child.slice(marker + 1),
      ];
};

export const mergePipeline = (
  parent: Pipeline | undefined,
  child: Pipeline,
): Pipeline => ({
  ...parent,
  ...child,
  dependsOn: mergeArray(parent?.dependsOn, child.dependsOn),
  env: mergeArray(parent?.env, child.env),
  inputs: mergeArray(parent?.inputs, child.inputs),
  outputs: mergeArray(parent?.outputs, child.outputs),
  passThroughEnv: mergeArray(parent?.passThroughEnv, child.passThroughEnv),
  with: mergeArray(parent?.with, child.with),
});

export const loadPackageConfiguration = (
  packageDirectory: string,
  packageName: string,
  root: LoadedRootConfiguration,
): Effect.Effect<
  LoadedPackageConfiguration,
  ConfigurationError,
  FileSystemService
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const jsonPath = joinPath(packageDirectory, "turbo.json");
    const jsoncPath = joinPath(packageDirectory, "turbo.jsonc");
    const hasJson = yield* fileSystem
      .exists(jsonPath)
      .pipe(
        Effect.mapError(
          (error) =>
            new ConfigurationError({ path: jsonPath, message: error.message }),
        ),
      );
    const hasJsonc = yield* fileSystem
      .exists(jsoncPath)
      .pipe(
        Effect.mapError(
          (error) =>
            new ConfigurationError({ path: jsoncPath, message: error.message }),
        ),
      );
    const rootTasks = (root.value.tasks ?? {}) as Readonly<
      Record<string, Pipeline>
    >;
    if (!hasJson && !hasJsonc) {
      return { tasks: rootTasks, excludedTasks: new Set<string>() };
    }
    if (hasJson && hasJsonc) {
      return yield* Effect.fail(
        new ConfigurationError({
          path: packageDirectory,
          message: "both turbo.json and turbo.jsonc are present",
        }),
      );
    }
    const path = hasJson ? jsonPath : jsoncPath;
    const source = yield* fileSystem
      .readText(path)
      .pipe(
        Effect.mapError(
          (error) => new ConfigurationError({ path, message: error.message }),
        ),
      );
    const workspace = yield* validateConfigurationEffect(path, () => {
      const workspaceDocument = expectObject(
        parseJsonConfiguration(source, path),
        path,
      );
      assertKnownKeys(workspaceDocument, workspaceKeys, path);
      validateBoundaries(
        workspaceDocument.boundaries,
        `${path}:boundaries`,
        false,
      );
      validateTaskStructure(workspaceDocument.tasks, path, workspaceTaskKeys);
      return decodeConfiguration(
        WorkspaceSchemaSchema,
        workspaceDocument,
        path,
      ) as WorkspaceSchema;
    });
    if (
      workspace.extends === null ||
      workspace.extends.length !== 1 ||
      workspace.extends[0] !== "//"
    ) {
      return yield* Effect.fail(
        new ConfigurationError({
          path,
          message: 'package configuration must extend "//"',
        }),
      );
    }
    const tasks = { ...rootTasks };
    const excludedTasks = new Set<string>();
    for (const [name, pipeline] of Object.entries(workspace.tasks ?? {})) {
      const qualifiedName = `${packageName}#${name}`;
      const targetName =
        rootTasks[qualifiedName] === undefined ? name : qualifiedName;
      const { extends: taskExtends, ...definition } = pipeline;
      if (taskExtends === false) {
        delete tasks[targetName];
        if (Object.keys(definition).length === 0) {
          excludedTasks.add(name);
        } else {
          tasks[targetName] = definition;
        }
        continue;
      }
      tasks[targetName] = mergePipeline(rootTasks[targetName], definition);
    }
    return yield* validateConfigurationEffect(path, () => {
      validateTaskStructure(tasks, path);
      validateTaskInvariants(tasks, path);
      return {
        path,
        tags: workspace.tags,
        boundaries: workspace.boundaries,
        tasks,
        excludedTasks,
      };
    });
  });
