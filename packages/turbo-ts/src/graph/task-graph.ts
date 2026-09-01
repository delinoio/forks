import { matchesGlob } from "../core/glob.js";
import { GraphError } from "../effect/errors.js";
import type { Pipeline } from "../generated/configuration.js";
import type {
  RepositoryModel,
  RepositoryPackage,
} from "../repository/model.js";

export interface TaskNode {
  readonly id: string;
  readonly package: RepositoryPackage;
  readonly task: string;
  readonly command?: string;
  readonly definition: Pipeline;
  readonly dependencies: ReadonlyArray<string>;
  readonly with: ReadonlyArray<string>;
}

export interface TaskGraph {
  readonly nodes: ReadonlyMap<string, TaskNode>;
  readonly entrypoints: ReadonlyArray<string>;
}

const packageDependents = (
  repository: RepositoryModel,
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const dependents = new Map<string, Array<string>>();
  for (const packageModel of repository.packages) {
    for (const dependency of packageModel.internalDependencies) {
      const entries = dependents.get(dependency) ?? [];
      entries.push(packageModel.name);
      dependents.set(dependency, entries);
    }
  }
  return new Map(
    [...dependents].map(([name, entries]) => [name, entries.sort()] as const),
  );
};

const expandPackageClosure = (
  initial: ReadonlySet<string>,
  edges: (name: string) => ReadonlyArray<string>,
): ReadonlySet<string> => {
  const selected = new Set(initial);
  const pending = [...initial];
  while (pending.length > 0) {
    for (const adjacent of edges(pending.pop()!)) {
      if (!selected.has(adjacent)) {
        selected.add(adjacent);
        pending.push(adjacent);
      }
    }
  }
  return selected;
};

const selectFilterBase = (
  repository: RepositoryModel,
  selector: string,
  gitRangePackages: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string> => {
  if (selector.startsWith("[") && selector.endsWith("]")) {
    return gitRangePackages.get(selector.slice(1, -1)) ?? new Set();
  }
  const directoryMatch = /^\{(.+)\}$/.exec(selector);
  const pattern = directoryMatch?.[1] ?? selector;
  return new Set(
    repository.packages
      .filter(
        (packageModel) =>
          packageModel.name === pattern ||
          matchesGlob(packageModel.name, pattern) ||
          matchesGlob(
            packageModel.relativeDirectory,
            pattern.replace(/^\.\//, ""),
          ),
      )
      .map((packageModel) => packageModel.name),
  );
};

export const selectPackages = (
  repository: RepositoryModel,
  filters: ReadonlyArray<string>,
  gitRangePackages: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): ReadonlyArray<RepositoryPackage> => {
  if (filters.length === 0) {
    return repository.packages;
  }
  const dependents = packageDependents(repository);
  const selected = new Set<string>(
    filters.some((filter) => !filter.startsWith("!"))
      ? []
      : repository.packages.map((packageModel) => packageModel.name),
  );
  const applyFilter = (rawFilter: string): void => {
    const negative = rawFilter.startsWith("!");
    let filter = negative ? rawFilter.slice(1) : rawFilter;
    const includeDependents = filter.startsWith("...");
    const includeDependencies = filter.endsWith("...");
    if (includeDependents) {
      filter = filter.slice(3);
    }
    if (includeDependencies) {
      filter = filter.slice(0, -3);
    }
    let matches = selectFilterBase(repository, filter, gitRangePackages);
    if (includeDependencies) {
      matches = expandPackageClosure(
        matches,
        (name) =>
          repository.packagesByName.get(name)?.internalDependencies ?? [],
      );
    }
    if (includeDependents) {
      matches = expandPackageClosure(
        matches,
        (name) => dependents.get(name) ?? [],
      );
    }
    for (const name of matches) {
      if (negative) selected.delete(name);
      else selected.add(name);
    }
  };
  for (const filter of filters.filter((entry) => !entry.startsWith("!"))) {
    applyFilter(filter);
  }
  for (const filter of filters.filter((entry) => entry.startsWith("!"))) {
    applyFilter(filter);
  }
  return repository.packages.filter((packageModel) =>
    selected.has(packageModel.name),
  );
};

const taskId = (packageName: string, task: string): string =>
  `${packageName}#${task}`;

const taskDefinition = (
  packageModel: RepositoryPackage,
  task: string,
): Pipeline | undefined =>
  packageModel.tasks[`${packageModel.name}#${task}`] ??
  packageModel.tasks[task];

const resolveTaskReference = (
  repository: RepositoryModel,
  packageModel: RepositoryPackage,
  reference: string,
): ReadonlyArray<readonly [RepositoryPackage, string]> => {
  if (reference.startsWith("^")) {
    const task = reference.slice(1);
    return packageModel.internalDependencies.flatMap((name) => {
      const dependency = repository.packagesByName.get(name);
      return dependency === undefined ? [] : [[dependency, task] as const];
    });
  }
  const separator = reference.indexOf("#");
  if (separator !== -1) {
    const packageName = reference.slice(0, separator);
    const task = reference.slice(separator + 1);
    const dependency = repository.packagesByName.get(packageName);
    return dependency === undefined ? [] : [[dependency, task]];
  }
  return [[packageModel, reference]];
};

export const buildTaskGraph = (
  repository: RepositoryModel,
  packages: ReadonlyArray<RepositoryPackage>,
  tasks: ReadonlyArray<string>,
  only: boolean,
  strictEntrypoints = false,
): TaskGraph => {
  const nodes = new Map<string, TaskNode>();
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const addNode = (
    packageModel: RepositoryPackage,
    task: string,
  ): string | undefined => {
    if (packageModel.excludedTasks.has(task)) {
      return undefined;
    }
    const id = taskId(packageModel.name, task);
    const configuredDefinition = taskDefinition(packageModel, task);
    const definition = configuredDefinition ?? {};
    const command = packageModel.scripts[task];
    if (command === undefined && configuredDefinition === undefined) {
      return undefined;
    }
    if (visiting.has(id)) {
      throw new GraphError({ task: id, message: `cycle detected at ${id}` });
    }
    if (visited.has(id)) {
      return id;
    }
    visiting.add(id);
    const dependencyIds: Array<string> = [];
    if (!only) {
      for (const reference of definition.dependsOn ?? []) {
        for (const [dependencyPackage, dependencyTask] of resolveTaskReference(
          repository,
          packageModel,
          reference,
        )) {
          const dependencyId = addNode(dependencyPackage, dependencyTask);
          if (dependencyId === undefined) {
            continue;
          }
          const dependencyDefinition =
            taskDefinition(dependencyPackage, dependencyTask) ?? {};
          if (dependencyDefinition.persistent === true) {
            throw new GraphError({
              task: id,
              message: `${id} cannot depend on persistent task ${dependencyId}`,
            });
          }
          dependencyIds.push(dependencyId);
        }
      }
    }
    const withIds: Array<string> = [];
    for (const reference of definition.with ?? []) {
      const companions = resolveTaskReference(
        repository,
        packageModel,
        reference,
      );
      if (companions.length === 0) {
        throw new GraphError({
          task: id,
          message: `${id} cannot resolve with task ${reference}`,
        });
      }
      for (const [withPackage, withTask] of companions) {
        const withId = addNode(withPackage, withTask);
        if (withId === undefined) {
          throw new GraphError({
            task: id,
            message: `${id} cannot resolve with task ${reference}`,
          });
        }
        withIds.push(withId);
      }
    }
    nodes.set(id, {
      id,
      package: packageModel,
      task,
      command,
      definition,
      dependencies: [...new Set(dependencyIds)].sort(),
      with: [...new Set(withIds)].sort(),
    });
    visiting.delete(id);
    visited.add(id);
    return id;
  };

  const selectedPackageNames = new Set(
    packages.map((packageModel) => packageModel.name),
  );
  const entrypoints = tasks.flatMap((task) => {
    if (task.startsWith("//#")) {
      const id = addNode(repository.rootPackage, task.slice(3));
      return id === undefined ? [] : [id];
    }
    const explicitSeparator = task.indexOf("#");
    if (explicitSeparator !== -1) {
      const explicitPackage = repository.packagesByName.get(
        task.slice(0, explicitSeparator),
      );
      if (
        explicitPackage === undefined ||
        !selectedPackageNames.has(explicitPackage.name)
      ) {
        return [];
      }
      const id = addNode(explicitPackage, task.slice(explicitSeparator + 1));
      return id === undefined ? [] : [id];
    }
    return packages.flatMap((packageModel) => {
      const id = addNode(packageModel, task);
      return id === undefined ? [] : [id];
    });
  });
  let selectedEntrypoints = [...new Set(entrypoints)].sort();
  if (strictEntrypoints) {
    selectedEntrypoints = selectedEntrypoints.filter(
      (id) => nodes.get(id)?.command !== undefined,
    );
  }
  const retained = new Set(selectedEntrypoints);
  const pending = [...retained];
  while (pending.length > 0) {
    const node = nodes.get(pending.pop()!);
    for (const adjacent of [
      ...(node?.dependencies ?? []),
      ...(node?.with ?? []),
    ]) {
      if (!retained.has(adjacent)) {
        retained.add(adjacent);
        pending.push(adjacent);
      }
    }
  }
  return {
    nodes: new Map([...nodes].filter(([id]) => retained.has(id))),
    entrypoints: selectedEntrypoints,
  };
};

export const topologicalOrder = (graph: TaskGraph): ReadonlyArray<string> => {
  const remaining = new Map(
    [...graph.nodes].map(
      ([id, node]) => [id, new Set(node.dependencies)] as const,
    ),
  );
  const order: Array<string> = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([id]) => id)
      .sort();
    if (ready.length === 0) {
      const id = [...remaining.keys()].sort()[0]!;
      throw new GraphError({
        task: id,
        message: "task graph contains a cycle",
      });
    }
    for (const id of ready) {
      remaining.delete(id);
      order.push(id);
      for (const dependencies of remaining.values()) {
        dependencies.delete(id);
      }
    }
  }
  return order;
};
