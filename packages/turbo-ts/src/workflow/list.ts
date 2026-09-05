import { Effect } from "effect";
import { selectByGlobs } from "../core/glob.js";
import { ConfigurationError } from "../effect/errors.js";
import {
  EnvironmentService,
  FileSystemService,
  ProcessService,
  TerminalService,
} from "../effect/services.js";
import { selectPackages } from "../graph/task-graph.js";
import { configuredEnvironmentValue } from "../repository/model.js";
import {
  loadWorkflowRepository,
  repositoryGlobalInputPatterns,
  repositoryPackageManagerLabel,
} from "./repository.js";

export interface ListOptions {
  readonly cwd?: string;
  readonly filters: ReadonlyArray<string>;
  readonly output: "pretty" | "json";
  readonly affected: boolean;
}

export const parseListArguments = (
  arguments_: ReadonlyArray<string>,
): ListOptions => {
  const filters: Array<string> = [];
  let cwd: string | undefined;
  let output: "pretty" | "json" = "pretty";
  let affected = false;
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
      case "--filter":
      case "-F":
        filters.push(takeValue());
        break;
      case "--output": {
        const value = takeValue();
        if (value !== "pretty" && value !== "json") {
          throw new ConfigurationError({
            path: "<arguments>",
            message: `invalid output format: ${value}`,
          });
        }
        output = value;
        break;
      }
      case "--affected":
        affected = true;
        break;
      case "--no-update-notifier":
      case "--no-color":
        break;
      default:
        throw new ConfigurationError({
          path: "<arguments>",
          message: `unknown option: ${argument}`,
        });
    }
  }
  return { cwd, filters, output, affected };
};

export const executeList = (
  options: ListOptions,
): Effect.Effect<
  number,
  unknown,
  EnvironmentService | FileSystemService | ProcessService | TerminalService
> =>
  Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const environment = yield* EnvironmentService;
    const processService = yield* ProcessService;
    const repository = yield* loadWorkflowRepository(options);
    let packages = selectPackages(repository, options.filters);
    if (options.affected) {
      const [entries, platform] = yield* Effect.all([
        environment.entries,
        environment.platform,
      ]);
      const caseInsensitiveNames = platform === "win32";
      const base =
        configuredEnvironmentValue(
          entries,
          "TURBO_SCM_BASE",
          caseInsensitiveNames,
        ) ?? "main";
      const head =
        configuredEnvironmentValue(
          entries,
          "TURBO_SCM_HEAD",
          caseInsensitiveNames,
        ) ?? "HEAD";
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
        return yield* Effect.fail(
          new ConfigurationError({
            path: repository.root,
            message: "unable to calculate affected packages",
          }),
        );
      }
      const paths = new TextDecoder("utf-8", { fatal: true })
        .decode(git.right.stdout)
        .split("\0")
        .filter(Boolean);
      const selected = new Set<string>();
      let rootChanged =
        selectByGlobs(
          paths,
          repositoryGlobalInputPatterns(repository),
          platform === "win32",
        ).length > 0;
      for (const path of paths) {
        const owners = repository.packages.filter((packageModel) => {
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
        if (owners.length === 0) rootChanged = true;
        for (const owner of owners) selected.add(owner.identity);
      }
      if (rootChanged) {
        for (const packageModel of repository.packages) {
          selected.add(packageModel.identity);
        }
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const packageModel of repository.packages) {
          if (
            !selected.has(packageModel.identity) &&
            packageModel.internalDependencies.some((dependency) =>
              selected.has(dependency),
            )
          ) {
            selected.add(packageModel.identity);
            changed = true;
          }
        }
      }
      packages = packages.filter((packageModel) =>
        selected.has(packageModel.identity),
      );
    }
    const packageManager = repositoryPackageManagerLabel(repository);
    if (options.output === "json") {
      yield* terminal.writeStdout(
        `${JSON.stringify(
          {
            packageManager,
            packages: {
              count: packages.length,
              items: packages.map((packageModel) => ({
                name: packageModel.name,
                path: packageModel.relativeDirectory,
              })),
            },
          },
          undefined,
          2,
        )}\n`,
      );
      return 0;
    }
    const rows = packages.map(
      (packageModel) =>
        `  ${packageModel.name} ${packageModel.relativeDirectory}`,
    );
    yield* terminal.writeStdout(
      `${packages.length} package${packages.length === 1 ? "" : "s"} (${packageManager})\n\n${rows.join("\n")}${rows.length === 0 ? "" : "\n"}`,
    );
    return 0;
  });
