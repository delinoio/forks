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
import { decodeNullDelimitedGitOutput } from "../hash/task-hash.js";
import {
  type LockfilePackage,
  resolveLockfilePackageClosure,
} from "../repository/lockfiles.js";
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
    let globalChange = false;
    for (const path of changedPaths) {
      const owners = childPackages.filter((packageModel) => {
        const directories = new Set(
          [
            packageModel.relativeDirectory,
            packageModel.canonicalRelativeDirectory,
          ].map((directory) => directory.replace(/^\.\/?/, "")),
        );
        return [...directories].some(
          (directory) =>
            directory !== "" &&
            (path === directory || path.startsWith(`${directory}/`)),
        );
      });
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
  const path = relativePath(
    repository.root,
    subject === repository.rootPackage
      ? repository.rootConfiguration.path
      : (subject.configurationPath ??
          joinPath(subject.directory, "package.json")),
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
  readFile: (path: string) => Promise<string>,
  loadExternalDependencies: () => Promise<ReadonlyArray<LockfilePackage>>,
  affectedRepository: (
    base: string,
    head: string,
  ) => Promise<AffectedRepository>,
) => {
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
  const taskGraph = repositoryTaskGraph(repository);
  const taskDependents = new Map<string, Array<string>>();
  for (const node of taskGraph.nodes.values()) {
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
    [...taskGraph.nodes.values()].map((node) => [
      node.id,
      {
        name: node.task,
        package: packageView(node.package),
        fullName: `${node.package.name}#${node.task}`,
        script: node.command,
      } as TaskView,
    ]),
  );
  const taskNodesByView = new Map(
    [...taskGraph.nodes.values()].map((node) => [
      taskViews.get(node.id)!,
      node,
    ]),
  );
  for (const node of taskGraph.nodes.values()) {
    const mutable = taskViews.get(node.id)!;
    const directDependencies = node.dependencies;
    const directDependents = taskDependents.get(node.id) ?? [];
    const allDependencies = taskClosure(
      node.id,
      (id) => taskGraph.nodes.get(id)?.dependencies ?? [],
    );
    const allDependents = taskClosure(
      node.id,
      (id) => taskDependents.get(id) ?? [],
    );
    Object.assign(mutable, {
      directDependencies: list(
        directDependencies.map((id) => taskViews.get(id)!),
      ),
      directDependents: list(directDependents.map((id) => taskViews.get(id)!)),
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
  for (const model of models) {
    Object.assign(packageView(model), {
      tasks: list(
        [...taskGraph.nodes.values()]
          .filter((node) => node.package.identity === model.identity)
          .sort((left, right) => left.task.localeCompare(right.task))
          .map((node) => taskViews.get(node.id)!),
      ),
    });
  }
  const packageViews = models.map(packageView);
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
    package: ({ name }: { readonly name: string }) => {
      const model = models.find(
        (entry) => entry.name === name || entry.identity === name,
      );
      if (model === undefined) throw new Error(`package not found: ${name}`);
      return packageView(model);
    },
    packageGraph: ({
      center,
      filter,
    }: {
      readonly center?: string;
      readonly filter?: PackagePredicate;
    }) => {
      const centerModel = models.find(
        (model) => model.name === center || model.identity === center,
      );
      const centeredIdentities =
        center === undefined || centerModel === undefined
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
          .map((view) => ({
            ...view,
            reason: {
              __typename: result.directlyAffected.has(
                models.find((model) => packageView(model) === view)!.identity,
              )
                ? "FileChanged"
                : "DependencyChanged",
            },
          })),
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
      const requested = new Set(tasks ?? []);
      const allTasks = [...result.affected.values()]
        .map(packageView)
        .filter((view) => packageMatchesPredicate(view, filter))
        .flatMap((view) => view.tasks.items);
      const selected =
        requested.size === 0
          ? allTasks
          : allTasks.filter((task) => requested.has(task.name));
      return list(
        selected.map((task) => {
          const node = taskNodesByView.get(task)!;
          return {
            ...task,
            reason: {
              __typename: affectedTaskReason(
                taskGraph,
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
    externalDependencies: async () => list(await loadExternalDependencies()),
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
  FileSystemService | ProcessService
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const processService = yield* ProcessService;
    return yield* Effect.tryPromise({
      try: (signal) => {
        const runResolverEffect = <A, E>(effect: Effect.Effect<A, E, never>) =>
          Effect.runPromise(effect, { signal });
        let externalDependenciesPromise:
          | Promise<ReadonlyArray<LockfilePackage>>
          | undefined;
        const loadExternalDependencies = () => {
          externalDependenciesPromise ??= runResolverEffect(
            Effect.gen(function* () {
              if (repository.lockfile === undefined) return [];
              const lockfileContents = yield* fileSystem
                .readBytes(repository.lockfile)
                .pipe(
                  Effect.mapError(
                    (error) =>
                      new ConfigurationError({
                        path: repository.lockfile!,
                        message: error.message,
                      }),
                  ),
                );
              const models = repositoryModels(repository);
              return yield* Effect.try({
                try: () => {
                  const dependencies = new Map<string, LockfilePackage>();
                  for (const model of models) {
                    const internalNames = new Set([
                      model.name,
                      ...model.internalDependencies.flatMap((identity) => {
                        const dependency =
                          repository.packagesByIdentity.get(identity);
                        return dependency === undefined
                          ? []
                          : [dependency.name];
                      }),
                    ]);
                    const manifestReferences = new Map(
                      [
                        model.manifest.dependencies,
                        model.manifest.devDependencies,
                        model.manifest.optionalDependencies,
                        model.manifest.peerDependencies,
                      ].flatMap((entries) => Object.entries(entries ?? {})),
                    );
                    const directDependencies = model.dependencyNames
                      .filter((name) => !internalNames.has(name))
                      .map(
                        (name) => [name, manifestReferences.get(name)] as const,
                      );
                    for (const dependency of resolveLockfilePackageClosure(
                      repository.lockfile!,
                      lockfileContents,
                      {
                        workspacePath: model.relativeDirectory,
                        packageName: model.name,
                        packageVersion: model.manifest.version,
                        directDependencies,
                      },
                    )) {
                      if (!internalNames.has(dependency.name)) {
                        dependencies.set(
                          `${dependency.name}@${dependency.version}`,
                          dependency,
                        );
                      }
                    }
                  }
                  return [...dependencies.values()].sort((left, right) =>
                    `${left.name}@${left.version}`.localeCompare(
                      `${right.name}@${right.version}`,
                    ),
                  );
                },
                catch: (cause) =>
                  new ConfigurationError({
                    path: repository.lockfile!,
                    message: String(cause),
                  }),
              });
            }),
          );
          return externalDependenciesPromise;
        };
        return graphql({
          schema: repositoryQuerySchema,
          source,
          rootValue: repositoryQueryRoot(
            repository,
            (path) =>
              runResolverEffect(
                fileSystem.realPath(path).pipe(
                  Effect.mapError(
                    (error) =>
                      new ConfigurationError({
                        path,
                        message: error.message,
                      }),
                  ),
                  Effect.flatMap((resolved) =>
                    isPathContained(repository.root, normalizePath(resolved))
                      ? fileSystem.readText(resolved).pipe(
                          Effect.mapError(
                            (error) =>
                              new ConfigurationError({
                                path,
                                message: error.message,
                              }),
                          ),
                        )
                      : Effect.fail(
                          new ConfigurationError({
                            path,
                            message:
                              "file path must stay within the repository",
                          }),
                        ),
                  ),
                ),
              ),
            loadExternalDependencies,
            (base, head) =>
              runResolverEffect(
                calculateAffectedRepository(repository, base, head).pipe(
                  Effect.provideService(ProcessService, processService),
                ),
              ),
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
          `GraphQL endpoint: http://localhost:${server.port}\n`,
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
    const repository = yield* loadWorkflowRepository(options);
    const calculation = yield* calculateAffectedRepository(
      repository,
      options.base,
      options.head,
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
          requested.size === 0 || requested.has(packageModel.name),
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
    const requestedTaskGraph =
      requested.size === 0
        ? undefined
        : repositoryTaskGraph(repository, [...requested]);
    const requestedTaskIds = new Set(requestedTaskGraph?.entrypoints ?? []);
    const taskItems = (
      options.packages
        ? []
        : requested.size === 0
          ? [...affected.values()].flatMap((packageModel) =>
              Object.keys(packageModel.scripts).map((name) =>
                taskItem(
                  packageModel,
                  name,
                  packageModel.tasks[name]?.dependsOn ?? [],
                ),
              ),
            )
          : [...requestedTaskGraph!.nodes.values()]
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
              )
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
