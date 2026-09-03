import { Effect } from "effect";
import { ConfigurationError } from "../effect/errors.js";
import {
  DaemonService,
  DigestService,
  EnvironmentService,
  FileSystemService,
  ProcessService,
  SystemService,
  TerminalService,
} from "../effect/services.js";
import { daemonIsRunning } from "./daemon.js";
import {
  loadWorkflowRepository,
  repositoryPackageManagerLabel,
} from "./repository.js";

const completionShells = [
  "bash",
  "elvish",
  "fish",
  "powershell",
  "zsh",
] as const;

export const isWindowsSubsystemForLinux = (
  operatingSystem: string,
  kernelRelease: string,
): boolean =>
  operatingSystem === "linux" && /(?:microsoft|wsl)/i.test(kernelRelease);

export const executeCompletion = (
  arguments_: ReadonlyArray<string>,
): Effect.Effect<number, ConfigurationError | unknown, TerminalService> =>
  Effect.gen(function* () {
    const terminal = yield* TerminalService;
    const shell = arguments_[0];
    if (
      shell === undefined ||
      !completionShells.includes(shell as (typeof completionShells)[number])
    ) {
      return yield* Effect.fail(
        new ConfigurationError({
          path: "<arguments>",
          message: `completion shell must be one of: ${completionShells.join(", ")}`,
        }),
      );
    }
    const scripts: Record<(typeof completionShells)[number], string> = {
      bash: "complete -W 'run watch daemon query ls prune info completion' turbo-ts\n",
      elvish:
        "set edit:completion:arg-completer[turbo-ts] = { |@words| put run watch daemon query ls prune info completion }\n",
      fish: "complete -c turbo-ts -f -a 'run watch daemon query ls prune info completion'\n",
      powershell:
        "Register-ArgumentCompleter -Native -CommandName turbo-ts -ScriptBlock { 'run','watch','daemon','query','ls','prune','info','completion' }\n",
      zsh: "#compdef turbo-ts\n_arguments '1:command:(run watch daemon query ls prune info completion)'\n",
    };
    yield* terminal.writeStdout(scripts[shell as keyof typeof scripts]);
    return 0;
  });

export const executeInfo = (
  arguments_: ReadonlyArray<string>,
): Effect.Effect<
  number,
  unknown,
  | EnvironmentService
  | DaemonService
  | DigestService
  | FileSystemService
  | ProcessService
  | SystemService
  | TerminalService
> =>
  Effect.gen(function* () {
    let cwd: string | undefined;
    for (let index = 0; index < arguments_.length; index += 1) {
      const argument = arguments_[index]!;
      if (argument === "--cwd" || argument.startsWith("--cwd=")) {
        cwd = argument.includes("=")
          ? argument.slice(argument.indexOf("=") + 1)
          : arguments_[++index];
      } else if (
        argument !== "--no-color" &&
        argument !== "--no-update-notifier"
      ) {
        return yield* Effect.fail(
          new ConfigurationError({
            path: "<arguments>",
            message: `unknown option: ${argument}`,
          }),
        );
      }
    }
    const terminal = yield* TerminalService;
    const environment = yield* EnvironmentService;
    const system = yield* SystemService;
    const repository = yield* loadWorkflowRepository({ cwd });
    const daemonRunning = yield* daemonIsRunning(repository.root);
    const information = yield* system.information;
    const executable =
      environment.executablePath === undefined
        ? "unknown"
        : yield* environment.executablePath;
    const entries = yield* environment.entries;
    const stdin =
      terminal.stdinIsTerminal === undefined
        ? false
        : yield* terminal.stdinIsTerminal;
    yield* terminal.writeStdout(`CLI:
   Version: 0.1.0 (compatible with 2.10.12)
   Path to executable: ${executable}
   Daemon status: ${daemonRunning ? "Running" : "Not running"}
   Package manager: ${repositoryPackageManagerLabel(repository)}

Platform:
   Architecture: ${information.architecture === "x64" ? "x86_64" : information.architecture}
   Operating system: ${information.operatingSystem}
   WSL: ${isWindowsSubsystemForLinux(information.operatingSystem, information.kernelRelease)}
   Available memory (MB): ${information.availableMemoryMegabytes}
   Available CPU cores: ${information.availableCpuCores}

Environment:
   CI: ${entries.CI ?? "None"}
   AI agent: None
   Terminal (TERM): ${entries.TERM ?? "unknown"}
   Terminal program (TERM_PROGRAM): ${entries.TERM_PROGRAM ?? "unknown"}
   Terminal program version (TERM_PROGRAM_VERSION): ${entries.TERM_PROGRAM_VERSION ?? "unknown"}
   Shell (SHELL): ${entries.SHELL ?? "unknown"}
   stdin: ${stdin}
   Node.js version: ${process.version}
`);
    return 0;
  });
