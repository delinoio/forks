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
import { browserInvocation } from "./browser.js";
import { loadWorkflowRepository } from "./repository.js";

interface DevtoolsOptions {
  readonly common: ReturnType<typeof parseCommonArguments>["options"];
  readonly noOpen: boolean;
  readonly port: number;
}

const failure = (message: string): ConfigurationError =>
  new ConfigurationError({ path: "<arguments>", message });

const escapeHtml = (value: string): string =>
  value.replace(/[&<>]/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      default:
        return "&gt;";
    }
  });

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
      const graphDocument = {
        root: repository.rootPackage.name,
        packages: [repository.rootPackage, ...repository.packages].map(
          (packageModel) => ({
            name: packageModel.name,
            path: packageModel.relativeDirectory,
            dependencies: [...packageModel.internalDependencies].sort(),
          }),
        ),
      };
      const graph = JSON.stringify(graphDocument);
      const page = `<!doctype html><title>turbo-ts devtools</title><main><h1>turbo-ts package graph</h1><pre>${escapeHtml(JSON.stringify(graphDocument, undefined, 2))}</pre></main>`;
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
          body: page,
        });
      });
      const publicUrl = `http://127.0.0.1:${server.port}/`;
      const authenticatedUrl = `${publicUrl}?token=${token}`;
      yield* terminal.writeStdout(`turbo-ts devtools: ${publicUrl}\n`);
      const printAuthenticatedUrl = terminal.writeStdout(
        `turbo-ts devtools authenticated: ${authenticatedUrl}\n`,
      );
      if (options.noOpen || processes.spawnDetached === undefined) {
        yield* printAuthenticatedUrl;
      } else {
        const platform = yield* environment.platform;
        const invocation = browserInvocation(platform, authenticatedUrl);
        yield* processes
          .run({
            ...invocation,
            cwd: repository.root,
            inheritEnvironment: true,
            maxCapturedOutputCharacters: 64 * 1024,
            stdio: "capture",
          })
          .pipe(
            Effect.flatMap((result) =>
              result.exitCode === 0 ? Effect.void : printAuthenticatedUrl,
            ),
            Effect.catchAll(() => printAuthenticatedUrl),
          );
      }
      return yield* Effect.never;
    }),
  );
