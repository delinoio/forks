import { Effect, Stream } from "effect";
import {
  buildSchema,
  type GraphQLSchema,
  graphql,
  introspectionFromSchema,
} from "graphql";
import {
  isAbsolutePath,
  isPathContained,
  joinPath,
  normalizePath,
} from "../core/path.js";
import { ConfigurationError } from "../effect/errors.js";
import {
  EnvironmentService,
  FileSystemService,
  LoopbackHttpService,
  ProcessService,
  SignalService,
  TerminalService,
} from "../effect/services.js";
import type {
  RepositoryModel,
  RepositoryPackage,
} from "../repository/model.js";
import { loadWorkflowRepository } from "./repository.js";

const schemaSource = `
  scalar JSON
  input FieldValuePair { field: String!, value: JSON! }
  input PackagePredicate {
    and: [PackagePredicate!]
    or: [PackagePredicate!]
    equal: FieldValuePair
    notEqual: FieldValuePair
    greaterThan: FieldValuePair
    lessThan: FieldValuePair
    not: PackagePredicate
    has: FieldValuePair
  }
  type Packages { items: [Package!]!, length: Int! }
  type RepositoryTasks { items: [RepositoryTask!]!, length: Int! }
  type ChangedPackages { items: [ChangedPackage!]!, length: Int! }
  type ChangedTasks { items: [ChangedTask!]!, length: Int! }
  type Edges { items: [Edge!]!, length: Int! }
  type Edge { source: String!, target: String!, kind: String! }
  type PackageGraph { nodes: Packages!, edges: Edges! }
  type Package {
    name: String!
    path: String!
    directDependents: Packages!
    directDependencies: Packages!
    allDependents: Packages!
    allDependencies: Packages!
    indirectDependents: Packages!
    indirectDependencies: Packages!
    tasks: RepositoryTasks!
  }
  type RepositoryTask {
    name: String!
    package: Package!
    fullName: String!
    script: String
    experimentalCI: JSON
    directDependents: RepositoryTasks!
    directDependencies: RepositoryTasks!
    indirectDependents: RepositoryTasks!
    indirectDependencies: RepositoryTasks!
    allDependents: RepositoryTasks!
    allDependencies: RepositoryTasks!
  }
  type ChangedPackage {
    reason: JSON!
    name: String!
    path: String!
    directDependents: Packages!
    directDependencies: Packages!
    allDependents: Packages!
    allDependencies: Packages!
    indirectDependents: Packages!
    indirectDependencies: Packages!
    tasks: RepositoryTasks!
  }
  type ChangedTask {
    reason: JSON!
    name: String!
    package: Package!
    fullName: String!
    script: String
    experimentalCI: JSON
    directDependents: RepositoryTasks!
    directDependencies: RepositoryTasks!
    indirectDependents: RepositoryTasks!
    indirectDependencies: RepositoryTasks!
    allDependents: RepositoryTasks!
    allDependencies: RepositoryTasks!
  }
  type Diagnostics { errors: [JSON!]!, warnings: [JSON!]! }
  type File { contents: String!, path: String!, absolutePath: String!, ast: JSON }
  type ExternalPackages { items: [JSON!]!, length: Int! }
  type RepositoryQuery {
    affectedPackages(base: String, head: String, filter: PackagePredicate): ChangedPackages!
    affectedTasks(base: String, head: String, tasks: [String!], filter: PackagePredicate): ChangedTasks!
    package(name: String!): Package!
    version: String!
    boundaries: Diagnostics!
    packageGraph(center: String, filter: PackagePredicate): PackageGraph!
    file(path: String!): File!
    packages(filter: PackagePredicate): Packages!
    externalDependencies: ExternalPackages!
  }
  schema { query: RepositoryQuery }
`;

export const repositoryQuerySchema: GraphQLSchema = buildSchema(schemaSource);

export interface QueryOptions {
  readonly cwd?: string;
  readonly query?: string;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly schema: boolean;
  readonly port: number;
}

const jsonObject = (
  source: string,
  option: string,
): Record<string, unknown> => {
  try {
    const value = JSON.parse(source) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("value is not an object");
    }
    return value as Record<string, unknown>;
  } catch (cause) {
    throw new ConfigurationError({
      path: "<arguments>",
      message: `${option} must be a JSON object: ${String(cause)}`,
    });
  }
};

export const parseQueryArguments = (
  arguments_: ReadonlyArray<string>,
): QueryOptions => {
  let cwd: string | undefined;
  let query: string | undefined;
  let variables: Record<string, unknown> | undefined;
  let schema = false;
  let port = 8000;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    const takeValue = (): string => {
      const equals = argument.indexOf("=");
      if (equals !== -1) return argument.slice(equals + 1);
      const value = arguments_[++index];
      if (value === undefined || value.startsWith("-")) {
        throw new ConfigurationError({
          path: "<arguments>",
          message: `${argument} requires a value`,
        });
      }
      return value;
    };
    if (!argument.startsWith("-")) {
      if (query !== undefined) {
        throw new ConfigurationError({
          path: "<arguments>",
          message: `unexpected argument: ${argument}`,
        });
      }
      query = argument;
      continue;
    }
    switch (argument.split("=", 1)[0]) {
      case "--cwd":
        cwd = takeValue();
        break;
      case "--variables":
      case "-V":
        variables = jsonObject(takeValue(), argument);
        break;
      case "--schema":
        schema = true;
        break;
      case "--port": {
        port = Number(takeValue());
        if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
          throw new ConfigurationError({
            path: "<arguments>",
            message: `invalid port: ${port}`,
          });
        }
        break;
      }
      case "--no-color":
      case "--no-update-notifier":
        break;
      default:
        throw new ConfigurationError({
          path: "<arguments>",
          message: `unknown option: ${argument}`,
        });
    }
  }
  return { cwd, query, variables, schema, port };
};

interface PackageView {
  readonly name: string;
  readonly path: string;
  readonly directDependents: {
    readonly items: ReadonlyArray<PackageView>;
    readonly length: number;
  };
  readonly directDependencies: {
    readonly items: ReadonlyArray<PackageView>;
    readonly length: number;
  };
  readonly allDependents: {
    readonly items: ReadonlyArray<PackageView>;
    readonly length: number;
  };
  readonly allDependencies: {
    readonly items: ReadonlyArray<PackageView>;
    readonly length: number;
  };
  readonly indirectDependents: {
    readonly items: ReadonlyArray<PackageView>;
    readonly length: number;
  };
  readonly indirectDependencies: {
    readonly items: ReadonlyArray<PackageView>;
    readonly length: number;
  };
  readonly tasks: {
    readonly items: ReadonlyArray<TaskView>;
    readonly length: number;
  };
}

interface TaskView {
  readonly name: string;
  readonly package: PackageView;
  readonly fullName: string;
  readonly script?: string;
  readonly experimentalCI?: unknown;
  readonly directDependents: {
    readonly items: ReadonlyArray<TaskView>;
    readonly length: number;
  };
  readonly directDependencies: {
    readonly items: ReadonlyArray<TaskView>;
    readonly length: number;
  };
  readonly indirectDependents: {
    readonly items: ReadonlyArray<TaskView>;
    readonly length: number;
  };
  readonly indirectDependencies: {
    readonly items: ReadonlyArray<TaskView>;
    readonly length: number;
  };
  readonly allDependents: {
    readonly items: ReadonlyArray<TaskView>;
    readonly length: number;
  };
  readonly allDependencies: {
    readonly items: ReadonlyArray<TaskView>;
    readonly length: number;
  };
}

const list = <A>(items: ReadonlyArray<A>) => ({ items, length: items.length });

const repositoryQueryRoot = (
  repository: RepositoryModel,
  readFile: (path: string) => Promise<string>,
) => {
  const models = [repository.rootPackage, ...repository.packages];
  const byIdentity = new Map(models.map((model) => [model.identity, model]));
  const dependents = new Map<string, Array<RepositoryPackage>>();
  for (const model of models) {
    for (const dependency of model.internalDependencies) {
      const entries = dependents.get(dependency) ?? [];
      entries.push(model);
      dependents.set(dependency, entries);
    }
  }
  const dependencyClosure = (
    start: RepositoryPackage,
    next: (model: RepositoryPackage) => ReadonlyArray<RepositoryPackage>,
  ): ReadonlyArray<RepositoryPackage> => {
    const result = new Map<string, RepositoryPackage>();
    const pending = [...next(start)];
    while (pending.length > 0) {
      const model = pending.shift()!;
      if (result.has(model.identity)) continue;
      result.set(model.identity, model);
      pending.push(...next(model));
    }
    return [...result.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  };
  const views = new Map<string, PackageView>();
  const packageView = (model: RepositoryPackage): PackageView => {
    const existing = views.get(model.identity);
    if (existing !== undefined) return existing;
    const mutable = {
      name: model.name,
      path: model === repository.rootPackage ? "" : model.relativeDirectory,
    } as PackageView;
    views.set(model.identity, mutable);
    const dependencies = model.internalDependencies.flatMap((identity) => {
      const dependency = byIdentity.get(identity);
      return dependency === undefined ? [] : [dependency];
    });
    const directDependents = dependents.get(model.identity) ?? [];
    const allDependencies = dependencyClosure(model, (entry) =>
      entry.internalDependencies.flatMap((identity) => {
        const dependency = byIdentity.get(identity);
        return dependency === undefined ? [] : [dependency];
      }),
    );
    const allDependents = dependencyClosure(
      model,
      (entry) => dependents.get(entry.identity) ?? [],
    );
    const tasks = Object.keys(model.scripts)
      .sort()
      .map((name): TaskView => {
        const emptyTasks = list<TaskView>([]);
        return {
          name,
          package: mutable,
          fullName: `${model.name}#${name}`,
          script: model.scripts[name],
          directDependents: emptyTasks,
          directDependencies: emptyTasks,
          indirectDependents: emptyTasks,
          indirectDependencies: emptyTasks,
          allDependents: emptyTasks,
          allDependencies: emptyTasks,
        };
      });
    Object.assign(mutable, {
      directDependencies: list(dependencies.map(packageView)),
      directDependents: list(directDependents.map(packageView)),
      allDependencies: list(allDependencies.map(packageView)),
      allDependents: list(allDependents.map(packageView)),
      indirectDependencies: list(
        allDependencies
          .filter((entry) => !dependencies.includes(entry))
          .map(packageView),
      ),
      indirectDependents: list(
        allDependents
          .filter((entry) => !directDependents.includes(entry))
          .map(packageView),
      ),
      tasks: list(tasks),
    });
    return mutable;
  };
  const packageViews = models.map(packageView);
  const graphEdges = models.flatMap((model) =>
    model.internalDependencies.map((target) => ({
      source: model.name,
      target: byIdentity.get(target)?.name ?? target,
      kind: "dependency",
    })),
  );
  return {
    version: () => "2.10.12",
    packages: () => list(packageViews),
    package: ({ name }: { readonly name: string }) => {
      const model = models.find(
        (entry) => entry.name === name || entry.identity === name,
      );
      if (model === undefined) throw new Error(`package not found: ${name}`);
      return packageView(model);
    },
    packageGraph: () => ({
      nodes: list(packageViews),
      edges: list(graphEdges),
    }),
    affectedPackages: () =>
      list(
        packageViews.map((view) => ({ ...view, reason: { type: "unknown" } })),
      ),
    affectedTasks: ({ tasks }: { readonly tasks?: ReadonlyArray<string> }) => {
      const requested = new Set(tasks ?? []);
      const allTasks = packageViews.flatMap((view) => view.tasks.items);
      const selected =
        requested.size === 0
          ? allTasks
          : allTasks.filter((task) => requested.has(task.name));
      return list(
        selected.map((task) => ({ ...task, reason: { type: "unknown" } })),
      );
    },
    boundaries: () => ({ errors: [], warnings: [] }),
    externalDependencies: () => list([]),
    file: async ({ path }: { readonly path: string }) => {
      const normalized = normalizePath(path);
      const absolutePath = joinPath(repository.root, normalized);
      if (
        isAbsolutePath(path) ||
        normalized === ".." ||
        normalized.startsWith("../") ||
        !isPathContained(repository.root, absolutePath)
      ) {
        throw new Error("file path must stay within the repository");
      }
      const contents = await readFile(absolutePath);
      return { contents, path: normalized, absolutePath, ast: null };
    },
  };
};

const executeGraphql = (
  repository: RepositoryModel,
  source: string,
  variables?: Readonly<Record<string, unknown>>,
): Effect.Effect<
  Awaited<ReturnType<typeof graphql>>,
  ConfigurationError,
  FileSystemService
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    return yield* Effect.tryPromise({
      try: () =>
        graphql({
          schema: repositoryQuerySchema,
          source,
          rootValue: repositoryQueryRoot(repository, (path) =>
            Effect.runPromise(fileSystem.readText(path)),
          ),
          variableValues: variables,
        }),
      catch: (cause) =>
        new ConfigurationError({ path: "<query>", message: String(cause) }),
    });
  });

export const executeQuery = (
  options: QueryOptions,
): Effect.Effect<
  number,
  unknown,
  | EnvironmentService
  | FileSystemService
  | LoopbackHttpService
  | ProcessService
  | SignalService
  | TerminalService
> =>
  Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const fileSystem = yield* FileSystemService;
    const repository = yield* loadWorkflowRepository(options);
    if (options.schema) {
      yield* terminal.writeStdout(
        `${JSON.stringify({ data: { __schema: introspectionFromSchema(repositoryQuerySchema).__schema } }, undefined, 2)}\n`,
      );
      return 0;
    }
    if (options.query !== undefined) {
      const result = yield* executeGraphql(
        repository,
        options.query,
        options.variables,
      );
      yield* terminal.writeStdout(`${JSON.stringify(result, undefined, 2)}\n`);
      return result.errors === undefined ? 0 : 1;
    }
    const http = yield* LoopbackHttpService;
    const signals = yield* SignalService;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const server = yield* http.serve(options.port, (request) => {
          if (request.method === "GET") {
            return Effect.succeed({
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
              body: "<!doctype html><title>turbo-ts GraphQL</title><h1>GraphQL endpoint</h1>",
            });
          }
          return Effect.gen(function* () {
            let input: {
              readonly query?: unknown;
              readonly variables?: unknown;
            };
            try {
              input = JSON.parse(
                new TextDecoder().decode(request.body),
              ) as typeof input;
            } catch {
              return {
                status: 400,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  errors: [{ message: "invalid JSON request" }],
                }),
              };
            }
            if (typeof input.query !== "string") {
              return {
                status: 400,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  errors: [{ message: "query is required" }],
                }),
              };
            }
            const result = yield* executeGraphql(
              repository,
              input.query,
              typeof input.variables === "object" &&
                input.variables !== null &&
                !Array.isArray(input.variables)
                ? (input.variables as Record<string, unknown>)
                : undefined,
            ).pipe(Effect.provideService(FileSystemService, fileSystem));
            return {
              status: result.errors === undefined ? 200 : 400,
              headers: { "content-type": "application/json" },
              body: JSON.stringify(result),
            };
          }).pipe(
            Effect.catchAll(() =>
              Effect.succeed({
                status: 500,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  errors: [{ message: "internal query error" }],
                }),
              }),
            ),
          );
        });
        yield* terminal.writeStdout(
          `GraphiQL IDE: http://localhost:${server.port}\n`,
        );
        yield* Stream.runHead(signals.signals);
        return 0;
      }),
    );
  });

interface AffectedOptions {
  readonly cwd?: string;
  readonly base: string;
  readonly head: string;
  readonly packages: boolean;
  readonly fields: ReadonlyArray<string>;
  readonly exitCode: boolean;
}

const parseAffectedArguments = (
  arguments_: ReadonlyArray<string>,
): AffectedOptions => {
  let cwd: string | undefined;
  let base = "main";
  let head = "HEAD";
  let packages = false;
  let exitCode = false;
  const fields: Array<string> = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    const takeValue = (): string => {
      const equals = argument.indexOf("=");
      if (equals !== -1) return argument.slice(equals + 1);
      const value = arguments_[++index];
      if (value === undefined || value.startsWith("-")) {
        throw new ConfigurationError({
          path: "<arguments>",
          message: `${argument} requires a value`,
        });
      }
      return value;
    };
    switch (argument.split("=", 1)[0]) {
      case "--cwd":
        cwd = takeValue();
        break;
      case "--base":
        base = takeValue();
        break;
      case "--head":
        head = takeValue();
        break;
      case "--packages":
        packages = true;
        break;
      case "--tasks":
        packages = false;
        break;
      case "--exit-code":
        exitCode = true;
        break;
      case "--no-color":
      case "--no-update-notifier":
        break;
      default:
        if (!argument.startsWith("-")) fields.push(argument);
        else {
          throw new ConfigurationError({
            path: "<arguments>",
            message: `unknown option: ${argument}`,
          });
        }
    }
  }
  return { cwd, base, head, packages, fields, exitCode };
};

export const executeQueryAffected = (
  arguments_: ReadonlyArray<string>,
): Effect.Effect<
  number,
  unknown,
  EnvironmentService | FileSystemService | ProcessService | TerminalService
> =>
  Effect.gen(function* () {
    const options = parseAffectedArguments(arguments_);
    const terminal = yield* TerminalService;
    const processService = yield* ProcessService;
    const repository = yield* loadWorkflowRepository(options);
    const git = yield* Effect.scoped(
      processService.runBytes({
        command: "git",
        args: [
          "diff",
          "--name-only",
          "-z",
          `${options.base}...${options.head}`,
        ],
        cwd: repository.root,
        inheritEnvironment: true,
      }),
    ).pipe(Effect.either);
    if (git._tag === "Left" || git.right.exitCode !== 0) {
      const message =
        git._tag === "Left"
          ? git.left.message
          : new TextDecoder().decode(git.right.stderr).trim();
      yield* terminal.writeStdout(
        `${JSON.stringify(
          {
            data: null,
            errors: [
              {
                message: `Failed to calculate affected packages: ${message}`,
                path: [options.packages ? "affectedPackages" : "affectedTasks"],
              },
            ],
          },
          undefined,
          2,
        )}\n`,
      );
      return 2;
    }
    const changedPaths = new TextDecoder("utf-8", { fatal: true })
      .decode(git.right.stdout)
      .split("\0")
      .filter(Boolean)
      .map((path) => normalizePath(path));
    const directlyAffected = new Map<string, RepositoryPackage>();
    let globalChange = false;
    for (const path of changedPaths) {
      const owners = repository.packages.filter((packageModel) => {
        const directory = packageModel.relativeDirectory.replace(/^\.\/?/, "");
        return (
          directory !== "" &&
          (path === directory || path.startsWith(`${directory}/`))
        );
      });
      if (owners.length === 0) globalChange = true;
      for (const owner of owners) directlyAffected.set(owner.identity, owner);
    }
    if (globalChange) {
      for (const packageModel of repository.packages) {
        directlyAffected.set(packageModel.identity, packageModel);
      }
    }
    const affected = new Map(directlyAffected);
    let changed = true;
    while (changed) {
      changed = false;
      for (const packageModel of repository.packages) {
        if (
          !affected.has(packageModel.identity) &&
          packageModel.internalDependencies.some((dependency) =>
            affected.has(dependency),
          )
        ) {
          affected.set(packageModel.identity, packageModel);
          changed = true;
        }
      }
    }
    const packageItems = [...affected.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((packageModel) => ({
        name: packageModel.name,
        path: packageModel.relativeDirectory,
        reason: {
          __typename: directlyAffected.has(packageModel.identity)
            ? "FileChanged"
            : "DependencyChanged",
        },
      }));
    const taskReason = (packageModel: RepositoryPackage, name: string) => {
      if (directlyAffected.has(packageModel.identity)) {
        return { __typename: "TaskFileChanged" };
      }
      const dependsOn = packageModel.tasks[name]?.dependsOn ?? [];
      const changedDependency = packageModel.internalDependencies.some(
        (dependency) => directlyAffected.has(dependency),
      );
      return {
        __typename:
          changedDependency && dependsOn.includes(`^${name}`)
            ? "TaskDependencyTaskChanged"
            : "TaskAllChanged",
      };
    };
    const taskItems = [...affected.values()]
      .flatMap((packageModel) =>
        Object.keys(packageModel.scripts).map((name) => ({
          name,
          fullName: `${packageModel.name}#${name}`,
          package: { name: packageModel.name },
          reason: taskReason(packageModel, name),
        })),
      )
      .sort((left, right) => left.fullName.localeCompare(right.fullName));
    const items = options.packages ? packageItems : taskItems;
    const key = options.packages ? "affectedPackages" : "affectedTasks";
    yield* terminal.writeStdout(
      `${JSON.stringify(
        { data: { [key]: { items, length: items.length } } },
        undefined,
        2,
      )}\n`,
    );
    return options.exitCode && items.length > 0 ? 1 : 0;
  });
