import { Effect, Stream } from "effect";
import {
  buildSchema,
  type DocumentNode,
  type ExecutionResult,
  execute,
  GraphQLError,
  type GraphQLSchema,
  introspectionFromSchema,
  Kind,
  parse,
  type SelectionSetNode,
  type TypeNode,
  validate,
} from "graphql";
import {
  isAbsolutePath,
  isPathContained,
  joinPath,
  normalizePath,
  relativePath,
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
  BoundariesConfig,
  Permissions,
} from "../generated/configuration.js";
import {
  buildTaskGraph,
  type TaskGraph,
  type TaskNode,
} from "../graph/task-graph.js";
import {
  decodeNullDelimitedGitOutput,
  owningPackageLockfile,
} from "../hash/task-hash.js";
import {
  type LockfilePackage,
  lockfilePackageIdentity,
  maximumLockfileBytes,
  prepareLockfilePackageClosure,
} from "../repository/lockfiles.js";
import type {
  RepositoryModel,
  RepositoryPackage,
} from "../repository/model.js";
import {
  loadWorkflowRepository,
  packagesOwningRepositoryPath,
  repositoryGlobalInputsChanged,
} from "./repository.js";

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

const maximumRepositoryFileBytes = 1024 * 1024;
const maximumRepositoryFileQueryBytes = 8 * 1024 * 1024;
const maximumAffectedRangesPerQuery = 64;
const maximumGraphqlTokens = 4_096;
const maximumGraphqlExpandedSelections = 512;
const maximumGraphqlFieldDepth = 16;
const maximumGraphqlPredicateNodes = 512;
const maximumGraphqlPredicateDepth = 16;

interface GraphqlSelectionFrame {
  readonly selectionSet: SelectionSetNode;
  readonly depth: number;
  readonly fragmentPath: ReadonlySet<string>;
}

const queryComplexityError = (
  document: DocumentNode,
): GraphQLError | undefined => {
  const fragments = new Map(
    document.definitions.flatMap((definition) =>
      definition.kind === Kind.FRAGMENT_DEFINITION
        ? [[definition.name.value, definition] as const]
        : [],
    ),
  );
  const stack: Array<GraphqlSelectionFrame> = document.definitions.flatMap(
    (definition) =>
      definition.kind === Kind.OPERATION_DEFINITION
        ? [
            {
              selectionSet: definition.selectionSet,
              depth: 0,
              fragmentPath: new Set<string>(),
            },
          ]
        : [],
  );
  let expandedSelections = 0;
  while (stack.length > 0) {
    const frame = stack.pop()!;
    for (const selection of frame.selectionSet.selections) {
      expandedSelections += 1;
      if (expandedSelections > maximumGraphqlExpandedSelections) {
        return new GraphQLError(
          `GraphQL operation exceeds the ${maximumGraphqlExpandedSelections} expanded selection limit`,
        );
      }
      if (selection.kind === Kind.FIELD) {
        const depth = frame.depth + 1;
        if (depth > maximumGraphqlFieldDepth) {
          return new GraphQLError(
            `GraphQL operation exceeds the ${maximumGraphqlFieldDepth} field depth limit`,
          );
        }
        if (selection.selectionSet !== undefined) {
          stack.push({
            selectionSet: selection.selectionSet,
            depth,
            fragmentPath: frame.fragmentPath,
          });
        }
        continue;
      }
      if (selection.kind === Kind.INLINE_FRAGMENT) {
        stack.push({
          selectionSet: selection.selectionSet,
          depth: frame.depth,
          fragmentPath: frame.fragmentPath,
        });
        continue;
      }
      const name = selection.name.value;
      const fragment = fragments.get(name);
      if (fragment === undefined || frame.fragmentPath.has(name)) continue;
      stack.push({
        selectionSet: fragment.selectionSet,
        depth: frame.depth,
        fragmentPath: new Set([...frame.fragmentPath, name]),
      });
    }
  }
  return undefined;
};

const graphqlTypeName = (type: TypeNode): string => {
  let current = type;
  while (current.kind !== Kind.NAMED_TYPE) current = current.type;
  return current.name.value;
};

interface GraphqlPredicateFrame {
  readonly value: Readonly<Record<string, unknown>>;
  readonly depth: number;
}

const predicateVariablesComplexityError = (
  document: DocumentNode,
  variables: Readonly<Record<string, unknown>> | undefined,
): GraphQLError | undefined => {
  if (variables === undefined) return undefined;
  const variableNames = new Set(
    document.definitions.flatMap((definition) =>
      definition.kind === Kind.OPERATION_DEFINITION
        ? (definition.variableDefinitions ?? []).flatMap((variable) =>
            graphqlTypeName(variable.type) === "PackagePredicate"
              ? [variable.variable.name.value]
              : [],
          )
        : [],
    ),
  );
  const stack: Array<GraphqlPredicateFrame> = [];
  let predicateNodes = 0;
  const enqueue = (value: unknown, depth: number): GraphQLError | undefined => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    predicateNodes += 1;
    if (predicateNodes > maximumGraphqlPredicateNodes) {
      return new GraphQLError(
        `GraphQL variables exceed the ${maximumGraphqlPredicateNodes} package predicate node limit`,
      );
    }
    if (depth > maximumGraphqlPredicateDepth) {
      return new GraphQLError(
        `GraphQL variables exceed the ${maximumGraphqlPredicateDepth} package predicate depth limit`,
      );
    }
    stack.push({
      value: value as Readonly<Record<string, unknown>>,
      depth,
    });
    return undefined;
  };
  for (const name of variableNames) {
    const error = enqueue(variables[name], 1);
    if (error !== undefined) return error;
  }
  while (stack.length > 0) {
    const frame = stack.pop()!;
    for (const field of ["and", "or"] as const) {
      const entries = frame.value[field];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const error = enqueue(entry, frame.depth + 1);
        if (error !== undefined) return error;
      }
    }
    const error = enqueue(frame.value.not, frame.depth + 1);
    if (error !== undefined) return error;
  }
  return undefined;
};

interface RepositoryFileContents {
  readonly contents: string;
  readonly byteLength: number;
}

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

interface TaskQueryViews {
  readonly graph: TaskGraph;
  readonly nodesByView: ReadonlyMap<TaskView, TaskNode>;
  readonly tasksByPackage: ReadonlyMap<
    string,
    { readonly items: ReadonlyArray<TaskView>; readonly length: number }
  >;
}

const list = <A>(items: ReadonlyArray<A>) => ({ items, length: items.length });

interface AffectedRepository {
  readonly affected: ReadonlyMap<string, RepositoryPackage>;
  readonly directlyAffected: ReadonlySet<string>;
}

const repositoryModels = (
  repository: RepositoryModel,
): ReadonlyArray<RepositoryPackage> => [
  repository.rootPackage,
  ...repository.packages.filter(
    (packageModel) => packageModel.identity !== repository.rootPackage.identity,
  ),
];

const repositoryTaskGraph = (
  repository: RepositoryModel,
  requestedTaskNames?: ReadonlyArray<string>,
) => {
  const models = repositoryModels(repository);
  const taskNames =
    requestedTaskNames ??
    [
      ...new Set(
        models.flatMap((model) => [
          ...Object.keys(model.scripts),
          ...Object.keys(model.tasks).map((name) =>
            name.slice(name.lastIndexOf("#") + 1),
          ),
        ]),
      ),
    ].sort();
  return buildTaskGraph(repository, models, taskNames, false);
};

type AffectedTaskReason =
  | "TaskAllChanged"
  | "TaskDependencyTaskChanged"
  | "TaskFileChanged";

const affectedTaskReason = (
  graph: TaskGraph,
  node: TaskNode,
  affected: ReadonlyMap<string, RepositoryPackage>,
  directlyAffected: ReadonlySet<string>,
): AffectedTaskReason => {
  if (directlyAffected.has(node.package.identity)) return "TaskFileChanged";
  const visited = new Set([node.id]);
  const pending = [...node.dependencies];
  while (pending.length > 0) {
    const dependencyId = pending.shift()!;
    if (visited.has(dependencyId)) continue;
    visited.add(dependencyId);
    const dependency = graph.nodes.get(dependencyId);
    if (dependency === undefined) continue;
    if (
      dependency.package.identity !== node.package.identity &&
      affected.has(dependency.package.identity)
    ) {
      return "TaskDependencyTaskChanged";
    }
    pending.push(...dependency.dependencies);
  }
  return "TaskAllChanged";
};

const calculateAffectedRepository = (
  repository: RepositoryModel,
  base: string,
  head: string,
  windowsPathSeparators: boolean,
): Effect.Effect<AffectedRepository, ConfigurationError, ProcessService> =>
  Effect.gen(function* () {
    const processService = yield* ProcessService;
    const git = yield* Effect.scoped(
      processService.runBytes({
        command: "git",
        args: [
          "diff",
          "--no-renames",
          "--name-only",
          "-z",
          "--end-of-options",
          `${base}...${head}`,
          "--",
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
      return yield* Effect.fail(
        new ConfigurationError({
          path: "<query>",
          message: `Failed to calculate affected packages: ${message}`,
        }),
      );
    }
    const changedPaths = yield* Effect.try({
      try: () =>
        decodeNullDelimitedGitOutput(git.right.stdout, repository.root).map(
          (path) => normalizePath(path),
        ),
      catch: (cause) =>
        new ConfigurationError({
          path: "<query>",
          message: String(cause),
        }),
    });
    const models = repositoryModels(repository);
    const childPackages = models.filter(
      (packageModel) =>
        packageModel.identity !== repository.rootPackage.identity,
    );
    const directlyAffected = new Map<string, RepositoryPackage>();
    let globalChange = repositoryGlobalInputsChanged(
      repository,
      changedPaths,
      windowsPathSeparators,
    );
    for (const path of changedPaths) {
      const owners = packagesOwningRepositoryPath(
        childPackages,
        path,
        windowsPathSeparators,
      );
      if (owners.length === 0) globalChange = true;
      for (const owner of owners) directlyAffected.set(owner.identity, owner);
    }
    if (globalChange) {
      for (const packageModel of models) {
        directlyAffected.set(packageModel.identity, packageModel);
      }
    }
    const affected = new Map(directlyAffected);
    let changed = true;
    while (changed) {
      changed = false;
      for (const packageModel of models) {
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
    return {
      affected,
      directlyAffected: new Set(directlyAffected.keys()),
    };
  });

interface PackagePredicate {
  readonly and?: ReadonlyArray<PackagePredicate>;
  readonly or?: ReadonlyArray<PackagePredicate>;
  readonly not?: PackagePredicate;
  readonly equal?: { readonly field: string; readonly value: unknown };
  readonly notEqual?: { readonly field: string; readonly value: unknown };
  readonly greaterThan?: { readonly field: string; readonly value: unknown };
  readonly lessThan?: { readonly field: string; readonly value: unknown };
  readonly has?: { readonly field: string; readonly value: unknown };
}

const packageField = (view: PackageView, field: string): unknown => {
  const normalizedField = field
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replaceAll("-", "_")
    .toUpperCase();
  switch (normalizedField) {
    case "NAME":
    case "PACKAGE_NAME":
      return view.name;
    case "PATH":
    case "PACKAGE_PATH":
      return view.path;
    case "TASK_NAME":
    case "TASKS":
      return view.tasks.items.map((task) => task.name);
    case "DIRECT_DEPENDENT_COUNT":
      return view.directDependents.length;
    case "DIRECT_DEPENDENCY_COUNT":
      return view.directDependencies.length;
    default:
      return undefined;
  }
};

const packageMatchesPredicate = (
  view: PackageView,
  predicate: PackagePredicate | undefined,
): boolean => {
  if (predicate === undefined) return true;
  if (predicate.and !== undefined) {
    return predicate.and.every((entry) => packageMatchesPredicate(view, entry));
  }
  if (predicate.or !== undefined) {
    return predicate.or.some((entry) => packageMatchesPredicate(view, entry));
  }
  if (predicate.not !== undefined) {
    return !packageMatchesPredicate(view, predicate.not);
  }
  const comparison =
    predicate.equal ??
    predicate.notEqual ??
    predicate.greaterThan ??
    predicate.lessThan ??
    predicate.has;
  if (comparison === undefined) return true;
  const value = packageField(view, comparison.field);
  if (predicate.has !== undefined) {
    return Array.isArray(value) && value.includes(comparison.value);
  }
  if (predicate.equal !== undefined) return value === comparison.value;
  if (predicate.notEqual !== undefined) return value !== comparison.value;
  if (predicate.greaterThan !== undefined) {
    return (
      typeof value === "number" &&
      typeof comparison.value === "number" &&
      value > comparison.value
    );
  }
  return (
    typeof value === "number" &&
    typeof comparison.value === "number" &&
    value < comparison.value
  );
};

interface BoundaryDiagnostic {
  readonly message: string;
  readonly reason: string | null;
  readonly path: string;
  readonly import: string;
}

const activePermissions = (
  permissions: Permissions | null | undefined,
): permissions is Permissions =>
  permissions !== null && permissions !== undefined;

const boundaryRuleDiagnostics = (
  repository: RepositoryModel,
  ruleOwner: RepositoryPackage,
  subject: RepositoryPackage,
  subjectTags: ReadonlyArray<string>,
  permissions: Permissions,
): ReadonlyArray<BoundaryDiagnostic> => {
  const manifestName =
    subject.manager === "cargo"
      ? "Cargo.toml"
      : subject.manager === "uv"
        ? "pyproject.toml"
        : "package.json";
  const path = relativePath(
    repository.root,
    subject === repository.rootPackage
      ? repository.rootConfiguration.path
      : (subject.configurationPath ??
          joinPath(subject.directory, manifestName)),
  );
  const deniedTags = subjectTags.filter((tag) =>
    permissions.deny?.includes(tag),
  );
  if (deniedTags.length > 0) {
    return deniedTags.map((tag) => ({
      message: `Package \`${subject.name}\` found with tag listed in denylist for \`${ruleOwner.name}\`: \`${tag}\``,
      reason: tag,
      path,
      import: subject.name,
    }));
  }
  if (
    permissions.allow !== null &&
    permissions.allow !== undefined &&
    !subjectTags.some((tag) => permissions.allow?.includes(tag))
  ) {
    return [
      {
        message: `Package \`${subject.name}\` found without any tag listed in allowlist for \`${ruleOwner.name}\``,
        reason: null,
        path,
        import: subject.name,
      },
    ];
  }
  return [];
};

const boundaryDiagnostics = (
  repository: RepositoryModel,
): ReadonlyArray<BoundaryDiagnostic> => {
  const models = [repository.rootPackage, ...repository.packages];
  const byIdentity = new Map(models.map((model) => [model.identity, model]));
  const rootBoundaries = repository.rootConfiguration.value.boundaries;
  const diagnostics = new Map<string, BoundaryDiagnostic>();
  const record = (entries: ReadonlyArray<BoundaryDiagnostic>): void => {
    for (const entry of entries) {
      diagnostics.set(
        `${entry.path}\0${entry.import}\0${entry.message}`,
        entry,
      );
    }
  };
  const configurationFor = (
    model: RepositoryPackage,
  ): BoundariesConfig | null | undefined =>
    model === repository.rootPackage ? rootBoundaries : model.boundaries;
  const implicitDependenciesFor = (
    model: RepositoryPackage,
  ): ReadonlyArray<RepositoryPackage> =>
    (configurationFor(model)?.implicitDependencies ?? []).flatMap(
      (reference) => {
        const exact = byIdentity.get(reference);
        if (exact !== undefined) return [exact];
        return models.filter((candidate) => candidate.name === reference);
      },
    );
  for (const source of models) {
    const sourceTags = source.tags ?? [];
    const dependencyIdentities = new Set([
      ...source.internalDependencies,
      ...implicitDependenciesFor(source)
        .filter((target) => target !== source)
        .map((target) => target.identity),
    ]);
    for (const dependencyIdentity of dependencyIdentities) {
      const target = byIdentity.get(dependencyIdentity);
      if (target === undefined) continue;
      const targetTags = target.tags ?? [];
      const dependencyRules = [
        configurationFor(source)?.dependencies,
        ...sourceTags.map((tag) => rootBoundaries?.tags?.[tag]?.dependencies),
      ].filter(activePermissions);
      for (const permissions of dependencyRules) {
        record(
          boundaryRuleDiagnostics(
            repository,
            source,
            target,
            targetTags,
            permissions,
          ),
        );
      }
      const dependentRules = [
        configurationFor(target)?.dependents,
        ...targetTags.map((tag) => rootBoundaries?.tags?.[tag]?.dependents),
      ].filter(activePermissions);
      for (const permissions of dependentRules) {
        record(
          boundaryRuleDiagnostics(
            repository,
            target,
            source,
            sourceTags,
            permissions,
          ),
        );
      }
    }
  }
  return [...diagnostics.values()].sort((left, right) =>
    `${left.path}\0${left.import}\0${left.message}`.localeCompare(
      `${right.path}\0${right.import}\0${right.message}`,
    ),
  );
};

const repositoryQueryRoot = (
  repository: RepositoryModel,
  readFile: (path: string) => Promise<RepositoryFileContents>,
  loadExternalDependencies: () => Promise<ReadonlyArray<LockfilePackage>>,
  affectedRepository: (
    base: string,
    head: string,
  ) => Promise<AffectedRepository>,
) => {
  let returnedFileBytes = 0;
  const models = repositoryModels(repository);
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
    const visited = new Set([start.identity]);
    const pending = [...next(start)];
    while (pending.length > 0) {
      const model = pending.shift()!;
      if (visited.has(model.identity)) continue;
      visited.add(model.identity);
      result.set(model.identity, model);
      pending.push(...next(model));
    }
    return [...result.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  };
  const views = new Map(
    models.map((model) => [
      model.identity,
      {
        name: model.name,
        path: model === repository.rootPackage ? "" : model.relativeDirectory,
      } as PackageView,
    ]),
  );
  const packageView = (model: RepositoryPackage): PackageView =>
    views.get(model.identity)!;
  for (const model of models) {
    const mutable = packageView(model);
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
      tasks: list<TaskView>([]),
    });
  }
  let loadedTaskQueryViews: TaskQueryViews | undefined;
  const taskQueryViews = (): TaskQueryViews => {
    if (loadedTaskQueryViews !== undefined) return loadedTaskQueryViews;
    const graph = repositoryTaskGraph(repository);
    const taskDependents = new Map<string, Array<string>>();
    for (const node of graph.nodes.values()) {
      for (const dependency of node.dependencies) {
        const entries = taskDependents.get(dependency) ?? [];
        entries.push(node.id);
        taskDependents.set(dependency, entries);
      }
    }
    const taskClosure = (
      start: string,
      next: (id: string) => ReadonlyArray<string>,
    ): ReadonlyArray<string> => {
      const result = new Set<string>();
      const pending = [...next(start)];
      while (pending.length > 0) {
        const id = pending.shift()!;
        if (result.has(id)) continue;
        result.add(id);
        pending.push(...next(id));
      }
      return [...result].sort();
    };
    const taskViews = new Map(
      [...graph.nodes.values()].map((node) => [
        node.id,
        {
          name: node.task,
          package: packageView(node.package),
          fullName: `${node.package.name}#${node.task}`,
          script: node.command,
        } as TaskView,
      ]),
    );
    const nodesByView = new Map(
      [...graph.nodes.values()].map((node) => [taskViews.get(node.id)!, node]),
    );
    for (const node of graph.nodes.values()) {
      const mutable = taskViews.get(node.id)!;
      const directDependencies = node.dependencies;
      const directDependents = taskDependents.get(node.id) ?? [];
      const allDependencies = taskClosure(
        node.id,
        (id) => graph.nodes.get(id)?.dependencies ?? [],
      );
      const allDependents = taskClosure(
        node.id,
        (id) => taskDependents.get(id) ?? [],
      );
      Object.assign(mutable, {
        directDependencies: list(
          directDependencies.map((id) => taskViews.get(id)!),
        ),
        directDependents: list(
          directDependents.map((id) => taskViews.get(id)!),
        ),
        allDependencies: list(allDependencies.map((id) => taskViews.get(id)!)),
        allDependents: list(allDependents.map((id) => taskViews.get(id)!)),
        indirectDependencies: list(
          allDependencies
            .filter((id) => !directDependencies.includes(id))
            .map((id) => taskViews.get(id)!),
        ),
        indirectDependents: list(
          allDependents
            .filter((id) => !directDependents.includes(id))
            .map((id) => taskViews.get(id)!),
        ),
      });
    }
    const tasksByPackage = new Map(
      models.map((model) => [
        model.identity,
        list(
          [...graph.nodes.values()]
            .filter((node) => node.package.identity === model.identity)
            .sort((left, right) => left.task.localeCompare(right.task))
            .map((node) => taskViews.get(node.id)!),
        ),
      ]),
    );
    loadedTaskQueryViews = { graph, nodesByView, tasksByPackage };
    return loadedTaskQueryViews;
  };
  for (const model of models) {
    Object.defineProperty(packageView(model), "tasks", {
      enumerable: true,
      get: () => taskQueryViews().tasksByPackage.get(model.identity)!,
    });
  }
  const packageViews = models.map(packageView);
  const resolvePackage = (name: string): RepositoryPackage => {
    const identityMatch = byIdentity.get(name);
    if (identityMatch !== undefined) return identityMatch;
    const matches = models.filter((entry) => entry.name === name);
    if (matches.length === 0) throw new Error(`package not found: ${name}`);
    if (matches.length > 1) {
      throw new Error(
        `package name is ambiguous: ${name}; use one of ${matches
          .map((entry) => entry.identity)
          .sort()
          .join(", ")}`,
      );
    }
    return matches[0]!;
  };
  const graphEdges = models.flatMap((model) =>
    model.internalDependencies.map((target) => ({
      source: model.identity,
      target,
      kind: "dependency",
    })),
  );
  const graphEndpoint = (identity: string): string => {
    const model = byIdentity.get(identity);
    if (model === undefined) return identity;
    return models.some(
      (candidate) =>
        candidate.identity !== model.identity && candidate.name === model.name,
    )
      ? model.identity
      : model.name;
  };
  return {
    version: () => "2.10.12",
    packages: ({ filter }: { readonly filter?: PackagePredicate }) =>
      list(
        packageViews.filter((view) => packageMatchesPredicate(view, filter)),
      ),
    package: ({ name }: { readonly name: string }) =>
      packageView(resolvePackage(name)),
    packageGraph: ({
      center,
      filter,
    }: {
      readonly center?: string;
      readonly filter?: PackagePredicate;
    }) => {
      const centerModel =
        center === undefined ? undefined : resolvePackage(center);
      const centeredIdentities =
        centerModel === undefined
          ? undefined
          : new Set([
              centerModel.identity,
              ...centerModel.internalDependencies,
            ]);
      const selectedModels = models
        .filter(
          (model) =>
            centeredIdentities === undefined ||
            centeredIdentities.has(model.identity),
        )
        .filter((model) => packageMatchesPredicate(packageView(model), filter));
      const nodes = selectedModels.map(packageView);
      const selectedIdentities = new Set(
        selectedModels.map((model) => model.identity),
      );
      const edges = graphEdges
        .filter((edge) => {
          const centered =
            centerModel === undefined ||
            edge.source === centerModel.identity ||
            edge.target === centerModel.identity;
          return (
            centered &&
            (selectedIdentities.has(edge.source) ||
              selectedIdentities.has(edge.target))
          );
        })
        .map((edge) => ({
          ...edge,
          source: graphEndpoint(edge.source),
          target: graphEndpoint(edge.target),
        }));
      return { nodes: list(nodes), edges: list(edges) };
    },
    affectedPackages: async ({
      base = "main",
      head = "HEAD",
      filter,
    }: {
      readonly base?: string;
      readonly head?: string;
      readonly filter?: PackagePredicate;
    }) => {
      const result = await affectedRepository(base, head);
      return list(
        [...result.affected.values()]
          .map(packageView)
          .filter((view) => packageMatchesPredicate(view, filter))
          .map((view) =>
            Object.assign(Object.create(view) as PackageView, {
              reason: {
                __typename: result.directlyAffected.has(
                  models.find((model) => packageView(model) === view)!.identity,
                )
                  ? "FileChanged"
                  : "DependencyChanged",
              },
            }),
          ),
      );
    },
    affectedTasks: async ({
      base = "main",
      head = "HEAD",
      tasks,
      filter,
    }: {
      readonly base?: string;
      readonly head?: string;
      readonly tasks?: ReadonlyArray<string>;
      readonly filter?: PackagePredicate;
    }) => {
      const result = await affectedRepository(base, head);
      const taskData = taskQueryViews();
      const requested = new Set(tasks ?? []);
      const allTasks = [...result.affected.values()]
        .map(packageView)
        .filter((view) => packageMatchesPredicate(view, filter))
        .flatMap((view) => view.tasks.items);
      const selected =
        requested.size === 0
          ? allTasks
          : allTasks.filter((task) => {
              const node = taskData.nodesByView.get(task)!;
              return (
                requested.has(task.name) ||
                requested.has(task.fullName) ||
                requested.has(`${node.package.identity}#${task.name}`)
              );
            });
      return list(
        selected.map((task) => {
          const node = taskData.nodesByView.get(task)!;
          return {
            ...task,
            reason: {
              __typename: affectedTaskReason(
                taskData.graph,
                node,
                result.affected,
                result.directlyAffected,
              ),
            },
          };
        }),
      );
    },
    boundaries: () => ({
      errors: boundaryDiagnostics(repository),
      warnings: [],
    }),
    externalDependencies: async () =>
      list(
        (await loadExternalDependencies()).map(({ name, version, source }) => ({
          name,
          version,
          ...(source === undefined ? {} : { source }),
        })),
      ),
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
      const file = await readFile(absolutePath);
      if (
        returnedFileBytes + file.byteLength >
        maximumRepositoryFileQueryBytes
      ) {
        throw new Error("file query results exceed the 8 MiB safety limit");
      }
      returnedFileBytes += file.byteLength;
      return {
        contents: file.contents,
        path: normalized,
        absolutePath,
        ast: null,
      };
    },
  };
};

const executeGraphql = (
  repository: RepositoryModel,
  windowsPathSeparators: boolean,
  source: string,
  variables?: Readonly<Record<string, unknown>>,
): Effect.Effect<
  ExecutionResult,
  ConfigurationError,
  FileSystemService | ProcessService
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const processService = yield* ProcessService;
    return yield* Effect.tryPromise({
      try: async (signal) => {
        let document: DocumentNode;
        try {
          document = parse(source, { maxTokens: maximumGraphqlTokens });
        } catch (cause) {
          return {
            errors: [
              cause instanceof GraphQLError
                ? cause
                : new GraphQLError(String(cause)),
            ],
          };
        }
        const complexityError = queryComplexityError(document);
        if (complexityError !== undefined) {
          return { errors: [complexityError] };
        }
        const validationErrors = validate(repositoryQuerySchema, document);
        if (validationErrors.length > 0) {
          return { errors: validationErrors };
        }
        const predicateVariablesError = predicateVariablesComplexityError(
          document,
          variables,
        );
        if (predicateVariablesError !== undefined) {
          return { errors: [predicateVariablesError] };
        }
        const runResolverEffect = <A, E>(effect: Effect.Effect<A, E, never>) =>
          Effect.runPromise(effect, { signal });
        let externalDependenciesPromise:
          | Promise<ReadonlyArray<LockfilePackage>>
          | undefined;
        const repositoryFilePromises = new Map<
          string,
          Promise<RepositoryFileContents>
        >();
        const affectedRepositoryPromises = new Map<
          string,
          Promise<AffectedRepository>
        >();
        const loadExternalDependencies = () => {
          externalDependenciesPromise ??= runResolverEffect(
            Effect.gen(function* () {
              const models = repositoryModels(repository);
              const owningLockfiles = new Map(
                yield* Effect.forEach(
                  models,
                  (model) =>
                    owningPackageLockfile(repository, model).pipe(
                      Effect.mapError(
                        (error) =>
                          new ConfigurationError({
                            path: error.path,
                            message: error.message,
                          }),
                      ),
                      Effect.map(
                        (lockfile) => [model.identity, lockfile] as const,
                      ),
                    ),
                  { concurrency: 8 },
                ),
              );
              const lockfilePaths = [
                ...new Set(
                  [...owningLockfiles.values()].filter(
                    (path): path is string => path !== undefined,
                  ),
                ),
              ];
              const preparedLockfiles = new Map(
                yield* Effect.forEach(
                  lockfilePaths,
                  (lockfile) =>
                    fileSystem
                      .readBytesRange(lockfile, 0, maximumLockfileBytes + 1)
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new ConfigurationError({
                              path: lockfile,
                              message: error.message,
                            }),
                        ),
                        Effect.flatMap((contents) =>
                          Effect.try({
                            try: () =>
                              prepareLockfilePackageClosure(lockfile, contents),
                            catch: (cause) =>
                              new ConfigurationError({
                                path: lockfile,
                                message: String(cause),
                              }),
                          }),
                        ),
                        Effect.map((resolver) => [lockfile, resolver] as const),
                      ),
                  { concurrency: 8 },
                ),
              );
              const dependencies = new Map<string, LockfilePackage>();
              const workspacePackages = repository.packages.flatMap(
                (packageModel) =>
                  packageModel.manifest.version === undefined
                    ? []
                    : [
                        {
                          name: packageModel.name,
                          version: packageModel.manifest.version,
                        },
                      ],
              );
              for (const model of models) {
                const lockfile = owningLockfiles.get(model.identity);
                if (lockfile === undefined) continue;
                const manifestReferences = new Map(
                  [
                    model.manifest.dependencies,
                    model.manifest.devDependencies,
                    model.manifest.optionalDependencies,
                    model.manifest.peerDependencies,
                  ].flatMap((entries) => Object.entries(entries ?? {})),
                );
                const directDependencies = model.dependencyNames.map(
                  (name) => [name, manifestReferences.get(name)] as const,
                );
                const resolved = yield* Effect.try({
                  try: () =>
                    preparedLockfiles.get(lockfile)!.resolve({
                      workspacePath: model.relativeDirectory,
                      packageName: model.name,
                      packageVersion: model.manifest.version,
                      directDependencies,
                      workspacePackages,
                    }),
                  catch: (cause) =>
                    new ConfigurationError({
                      path: lockfile,
                      message: String(cause),
                    }),
                });
                for (const dependency of resolved) {
                  dependencies.set(
                    lockfilePackageIdentity(dependency),
                    dependency,
                  );
                }
              }
              return [...dependencies.values()].sort((left, right) =>
                lockfilePackageIdentity(left).localeCompare(
                  lockfilePackageIdentity(right),
                ),
              );
            }).pipe(Effect.provideService(FileSystemService, fileSystem)),
          );
          return externalDependenciesPromise;
        };
        const loadAffectedRepository = (base: string, head: string) => {
          const key = JSON.stringify([base, head]);
          const cached = affectedRepositoryPromises.get(key);
          if (cached !== undefined) return cached;
          if (
            affectedRepositoryPromises.size >= maximumAffectedRangesPerQuery
          ) {
            return Promise.reject(
              new ConfigurationError({
                path: "<query>",
                message: `affected collections support at most ${maximumAffectedRangesPerQuery} distinct ranges per query`,
              }),
            );
          }
          const loaded = runResolverEffect(
            calculateAffectedRepository(
              repository,
              base,
              head,
              windowsPathSeparators,
            ).pipe(Effect.provideService(ProcessService, processService)),
          );
          affectedRepositoryPromises.set(key, loaded);
          return loaded;
        };
        return await execute({
          schema: repositoryQuerySchema,
          document,
          rootValue: repositoryQueryRoot(
            repository,
            async (path) => {
              const resolved = normalizePath(
                await runResolverEffect(
                  fileSystem.realPath(path).pipe(
                    Effect.mapError(
                      (error) =>
                        new ConfigurationError({
                          path,
                          message: error.message,
                        }),
                    ),
                  ),
                ),
              );
              if (!isPathContained(repository.root, resolved)) {
                throw new ConfigurationError({
                  path,
                  message: "file path must stay within the repository",
                });
              }
              const cached = repositoryFilePromises.get(resolved);
              if (cached !== undefined) return cached;
              const loaded = runResolverEffect(
                Effect.gen(function* () {
                  const metadata = yield* fileSystem.metadata(resolved).pipe(
                    Effect.mapError(
                      (error) =>
                        new ConfigurationError({
                          path,
                          message: error.message,
                        }),
                    ),
                  );
                  if (metadata.kind !== "file") {
                    return yield* Effect.fail(
                      new ConfigurationError({
                        path,
                        message: "file path is not a regular file",
                      }),
                    );
                  }
                  if (metadata.size > maximumRepositoryFileBytes) {
                    return yield* Effect.fail(
                      new ConfigurationError({
                        path,
                        message: "file exceeds the 1 MiB safety limit",
                      }),
                    );
                  }
                  const contents = yield* fileSystem
                    .readBytesRange(resolved, 0, maximumRepositoryFileBytes + 1)
                    .pipe(
                      Effect.mapError(
                        (error) =>
                          new ConfigurationError({
                            path,
                            message: error.message,
                          }),
                      ),
                    );
                  if (contents.length > maximumRepositoryFileBytes) {
                    return yield* Effect.fail(
                      new ConfigurationError({
                        path,
                        message: "file exceeds the 1 MiB safety limit",
                      }),
                    );
                  }
                  return {
                    contents: new TextDecoder().decode(contents),
                    byteLength: contents.length,
                  };
                }),
              );
              repositoryFilePromises.set(resolved, loaded);
              return loaded;
            },
            loadExternalDependencies,
            loadAffectedRepository,
          ),
          variableValues: variables,
        });
      },
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
    const processService = yield* ProcessService;
    const environment = yield* EnvironmentService;
    const windowsPathSeparators = (yield* environment.platform) === "win32";
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
        windowsPathSeparators,
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
              windowsPathSeparators,
              input.query,
              typeof input.variables === "object" &&
                input.variables !== null &&
                !Array.isArray(input.variables)
                ? (input.variables as Record<string, unknown>)
                : undefined,
            ).pipe(
              Effect.provideService(FileSystemService, fileSystem),
              Effect.provideService(ProcessService, processService),
            );
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
          `GraphQL endpoint: http://127.0.0.1:${server.port}\n`,
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
    const environment = yield* EnvironmentService;
    const windowsPathSeparators = (yield* environment.platform) === "win32";
    const repository = yield* loadWorkflowRepository(options);
    const calculation = yield* calculateAffectedRepository(
      repository,
      options.base,
      options.head,
      windowsPathSeparators,
    ).pipe(Effect.either);
    if (calculation._tag === "Left") {
      yield* terminal.writeStdout(
        `${JSON.stringify(
          {
            data: null,
            errors: [
              {
                message: calculation.left.message,
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
    const { affected, directlyAffected } = calculation.right;
    const requested = new Set(options.fields);
    const packageItems = [...affected.values()]
      .filter(
        (packageModel) =>
          requested.size === 0 ||
          requested.has(packageModel.name) ||
          requested.has(packageModel.identity),
      )
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
    const taskReason = (
      packageModel: RepositoryPackage,
      name: string,
      dependsOn: ReadonlyArray<string>,
      node?: TaskNode,
      graph?: TaskGraph,
    ) => {
      if (node !== undefined && graph !== undefined) {
        return {
          __typename: affectedTaskReason(
            graph,
            node,
            affected,
            directlyAffected,
          ),
        };
      }
      if (directlyAffected.has(packageModel.identity)) {
        return { __typename: "TaskFileChanged" };
      }
      const changedDependency = packageModel.internalDependencies.some(
        (dependency) => affected.has(dependency),
      );
      const changedDependencyTask =
        changedDependency && dependsOn.includes(`^${name}`);
      return {
        __typename: changedDependencyTask
          ? "TaskDependencyTaskChanged"
          : "TaskAllChanged",
      };
    };
    const taskItem = (
      packageModel: RepositoryPackage,
      name: string,
      dependsOn: ReadonlyArray<string>,
      node?: TaskNode,
      graph?: TaskGraph,
    ) => ({
      name,
      fullName: `${packageModel.name}#${name}`,
      package: { name: packageModel.name },
      reason: taskReason(packageModel, name, dependsOn, node, graph),
    });
    const taskItems = (
      options.packages
        ? []
        : (() => {
            const requestedTaskGraph = repositoryTaskGraph(
              repository,
              requested.size === 0 ? undefined : [...requested],
            );
            const requestedTaskIds = new Set(requestedTaskGraph.entrypoints);
            return requested.size === 0
              ? [...affected.values()].flatMap((packageModel) =>
                  Object.keys(packageModel.scripts).map((name) => {
                    const node = requestedTaskGraph.nodes.get(
                      `${packageModel.identity}#${name}`,
                    );
                    return taskItem(
                      packageModel,
                      name,
                      node?.definition.dependsOn ?? [],
                      node,
                      requestedTaskGraph,
                    );
                  }),
                )
              : [...requestedTaskGraph.nodes.values()]
                  .filter(
                    (node) =>
                      affected.has(node.package.identity) &&
                      requestedTaskIds.has(node.id),
                  )
                  .map((node) =>
                    taskItem(
                      node.package,
                      node.task,
                      node.definition.dependsOn ?? [],
                      node,
                      requestedTaskGraph,
                    ),
                  );
          })()
    ).sort((left, right) => left.fullName.localeCompare(right.fullName));
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
