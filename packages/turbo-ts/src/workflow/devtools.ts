import { Effect } from "effect";
import { parseCommonArguments } from "../cli/common-options.js";
import { ConfigurationError } from "../effect/errors.js";
import {
  EnvironmentService,
  FileSystemService,
  LoopbackHttpService,
  ProcessService,
  RandomnessService,
  TerminalService,
} from "../effect/services.js";
import { loadWorkflowRepository } from "./repository.js";

interface DevtoolsOptions {
  readonly common: ReturnType<typeof parseCommonArguments>["options"];
  readonly noOpen: boolean;
  readonly port: number;
}

const failure = (message: string): ConfigurationError =>
  new ConfigurationError({ path: "<arguments>", message });

export const parseDevtoolsArguments = (
  arguments_: ReadonlyArray<string>,
): DevtoolsOptions => {
  const parsed = parseCommonArguments(arguments_);
  let noOpen = false;
  let port = 9876;
  for (let index = 0; index < parsed.remaining.length; index += 1) {
    const argument = parsed.remaining[index]!;
    const name = argument.split("=", 1)[0]!;
    if (name === "--no-open") {
      noOpen = true;
      continue;
    }
    if (name === "--port") {
      const raw = argument.includes("=")
        ? argument.slice(argument.indexOf("=") + 1)
        : parsed.remaining[++index];
      port = Number(raw);
      if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
        throw failure(`invalid devtools port: ${raw}`);
      }
      continue;
    }
    throw failure(`unknown option: ${argument}`);
  }
  return { common: parsed.options, noOpen, port };
};

const browserInvocation = (
  platform: NodeJS.Platform,
  url: string,
): { readonly command: string; readonly args: ReadonlyArray<string> } =>
  platform === "darwin"
    ? { command: "open", args: [url] }
    : platform === "win32"
      ? { command: "cmd.exe", args: ["/d", "/s", "/c", "start", "", url] }
      : { command: "xdg-open", args: [url] };

export const executeDevtools = (
  arguments_: ReadonlyArray<string>,
): Effect.Effect<
  number,
  unknown,
  | EnvironmentService
  | FileSystemService
  | LoopbackHttpService
  | ProcessService
  | RandomnessService
  | TerminalService
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const options = parseDevtoolsArguments(arguments_);
      const environment = yield* EnvironmentService;
      const http = yield* LoopbackHttpService;
      const processes = yield* ProcessService;
      const randomness = yield* RandomnessService;
      const terminal = yield* TerminalService;
      const repository = yield* loadWorkflowRepository({
        cwd: options.common.cwd,
        rootTurboJson: options.common.rootTurboJson,
      });
      const token = yield* randomness.uuidV7;
      const graph = JSON.stringify({
        root: repository.rootPackage.name,
        packages: [repository.rootPackage, ...repository.packages].map(
          (packageModel) => ({
            name: packageModel.name,
            path: packageModel.relativeDirectory,
            dependencies: [...packageModel.internalDependencies].sort(),
          }),
        ),
      });
      const server = yield* http.serve(options.port, (request) => {
        const url = new URL(request.path, "http://127.0.0.1");
        if (url.searchParams.get("token") !== token) {
          return Effect.succeed({ status: 403, body: "Forbidden" });
        }
        if (url.pathname === "/graph") {
          return Effect.succeed({
            status: 200,
            headers: { "content-type": "application/json" },
            body: graph,
          });
        }
        return Effect.succeed({
          status: 200,
          headers: {
            "content-security-policy":
              "default-src 'none'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
            "content-type": "text/html; charset=utf-8",
            "referrer-policy": "no-referrer",
          },
          body: "<!doctype html><title>turbo-ts devtools</title><main id=app>turbo-ts package graph</main>",
        });
      });
      const url = `http://127.0.0.1:${server.port}/?token=${token}`;
      yield* terminal.writeStdout(`turbo-ts devtools: ${url}\n`);
      if (!options.noOpen && processes.spawnDetached !== undefined) {
        const platform = yield* environment.platform;
        const invocation = browserInvocation(platform, url);
        yield* processes
          .spawnDetached({
            ...invocation,
            cwd: repository.root,
            inheritEnvironment: true,
          })
          .pipe(Effect.catchAll(() => Effect.void));
      }
      return yield* Effect.never;
    }),
  );
