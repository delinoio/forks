import { Schema } from "effect";
import {
  distributedSchemaBase64,
  parseDistributedSchema,
} from "./distributed-schema.js";

export const OutputLogsSchema = Schema.Literal(
  "full",
  "none",
  "hash-only",
  "new-only",
  "errors-only",
).annotations({ identifier: "OutputLogs" });

export const EnvModeSchema = Schema.Literal("loose", "strict").annotations({
  identifier: "EnvMode",
});

export const UiSchema = Schema.Literal(
  "tui",
  "stream",
  "stream-with-experimental-timestamps",
).annotations({ identifier: "UI" });

export const RelativeUnixPathSchema = Schema.String.annotations({
  identifier: "RelativeUnixPath",
});
export const EnvWildcardSchema = Schema.String.annotations({
  identifier: "EnvWildcard",
});

export const PermissionsSchema = Schema.Struct({
  allow: Schema.optional(Schema.Array(Schema.String)),
  deny: Schema.optional(Schema.Array(Schema.String)),
}).annotations({ identifier: "Permissions" });

export const TagRulesSchema = Schema.Struct({
  dependencies: Schema.optional(PermissionsSchema),
  dependents: Schema.optional(PermissionsSchema),
}).annotations({ identifier: "TagRules" });

export const BoundariesRulesMapSchema = Schema.Record({
  key: Schema.String,
  value: TagRulesSchema,
}).annotations({ identifier: "BoundariesRulesMap" });

export const BoundariesConfigSchema = Schema.Struct({
  implicitDependencies: Schema.optional(Schema.Array(Schema.String)),
  dependencies: Schema.optional(PermissionsSchema),
  dependents: Schema.optional(PermissionsSchema),
}).annotations({ identifier: "BoundariesConfig" });

export const RootBoundariesConfigSchema = Schema.extend(
  BoundariesConfigSchema,
  Schema.Struct({
    tags: Schema.optional(BoundariesRulesMapSchema),
  }),
).annotations({ identifier: "RootBoundariesConfig" });

export const StartupInputSchema = Schema.Struct({
  mode: Schema.Literal("startup"),
  globs: Schema.optional(Schema.Array(Schema.String)),
  withDefaults: Schema.optional(Schema.Boolean),
}).annotations({ identifier: "StartupInput" });

export const JitInputSchema = Schema.Struct({
  mode: Schema.Literal("jit"),
  globs: Schema.optional(Schema.Array(Schema.String)),
  withDefaults: Schema.optional(Schema.Boolean),
}).annotations({ identifier: "JitInput" });

export const DependencyOutputsInputSchema = Schema.Struct({
  mode: Schema.Literal("dependencyOutputs"),
  from: Schema.optional(Schema.Array(Schema.String)),
  globs: Schema.optional(Schema.Array(Schema.String)),
}).annotations({ identifier: "DependencyOutputsInput" });

export const TaskInputSchema = Schema.Union(
  Schema.String,
  StartupInputSchema,
  JitInputSchema,
  DependencyOutputsInputSchema,
).annotations({ identifier: "TaskInput" });

export const PipelineSchema = Schema.Struct({
  description: Schema.optional(Schema.String),
  dependsOn: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Array(EnvWildcardSchema)),
  passThroughEnv: Schema.optional(
    Schema.NullOr(Schema.Array(EnvWildcardSchema)),
  ),
  outputs: Schema.optional(Schema.Array(Schema.String)),
  cache: Schema.optional(Schema.Boolean),
  inputs: Schema.optional(Schema.Array(TaskInputSchema)),
  outputLogs: Schema.optional(OutputLogsSchema),
  persistent: Schema.optional(Schema.Boolean),
  interactive: Schema.optional(Schema.Boolean),
  interruptible: Schema.optional(Schema.Boolean),
  with: Schema.optional(Schema.Array(Schema.String)),
}).annotations({ identifier: "Pipeline" });

export const RemoteCacheSchema = Schema.Struct({
  signature: Schema.optional(Schema.Boolean),
  enabled: Schema.optional(Schema.Boolean),
  preflight: Schema.optional(Schema.Boolean),
  apiUrl: Schema.optional(Schema.String),
  loginUrl: Schema.optional(Schema.String),
  timeout: Schema.optional(Schema.NonNegative),
  uploadTimeout: Schema.optional(Schema.NonNegative),
  teamId: Schema.optional(Schema.String),
  teamSlug: Schema.optional(Schema.String),
}).annotations({ identifier: "RemoteCache" });

export const FutureFlagsSchema = Schema.Struct({
  errorsOnlyShowHash: Schema.optional(Schema.Boolean),
  experimentalObservability: Schema.optional(Schema.Boolean),
  longerSignatureKey: Schema.optional(Schema.Boolean),
  affectedUsingTaskInputs: Schema.optional(Schema.Boolean),
  githubActionsRemoteBaseRefFallback: Schema.optional(Schema.Boolean),
  watchUsingTaskInputs: Schema.optional(Schema.Boolean),
  pruneIncludesGlobalFiles: Schema.optional(Schema.Boolean),
  filterUsingTasks: Schema.optional(Schema.Boolean),
  strictTaskEntrypointSelection: Schema.optional(Schema.Boolean),
  globalConfiguration: Schema.optional(Schema.Boolean),
  experimentalCargoWorkspaces: Schema.optional(Schema.Boolean),
  experimentalPythonWorkspaces: Schema.optional(Schema.Boolean),
}).annotations({ identifier: "FutureFlags" });

export const InternalFutureFlagsSchema = Schema.extend(
  FutureFlagsSchema,
  Schema.Struct({
    experimentalCargoSccache: Schema.optional(Schema.Boolean),
  }),
).annotations({ identifier: "InternalFutureFlags" });

export const GlobalConfigSchema = Schema.Struct({
  inputs: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Array(EnvWildcardSchema)),
  passThroughEnv: Schema.optional(
    Schema.NullOr(Schema.Array(EnvWildcardSchema)),
  ),
  remoteCache: Schema.optional(RemoteCacheSchema),
  ui: Schema.optional(UiSchema),
  concurrency: Schema.optional(Schema.String),
  dangerouslyDisablePackageManagerCheck: Schema.optional(Schema.Boolean),
  cacheDir: Schema.optional(RelativeUnixPathSchema),
  cacheMaxAge: Schema.optional(Schema.String),
  cacheMaxSize: Schema.optional(Schema.String),
  daemon: Schema.optional(Schema.Boolean),
  envMode: Schema.optional(EnvModeSchema),
  noUpdateNotifier: Schema.optional(Schema.Boolean),
}).annotations({ identifier: "GlobalConfig" });

export const TasksSchema = Schema.Record({
  key: Schema.String,
  value: PipelineSchema,
});

export const BaseSchemaSchema = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  tasks: Schema.optional(Schema.NullOr(TasksSchema)),
}).annotations({ identifier: "BaseSchema" });

export const RootSchemaSchema = Schema.extend(
  BaseSchemaSchema,
  Schema.Struct({
    globalDependencies: Schema.optional(Schema.Array(Schema.String)),
    globalEnv: Schema.optional(Schema.Array(EnvWildcardSchema)),
    globalPassThroughEnv: Schema.optional(
      Schema.NullOr(Schema.Array(EnvWildcardSchema)),
    ),
    remoteCache: Schema.optional(RemoteCacheSchema),
    ui: Schema.optional(UiSchema),
    concurrency: Schema.optional(Schema.String),
    dangerouslyDisablePackageManagerCheck: Schema.optional(Schema.Boolean),
    cacheDir: Schema.optional(RelativeUnixPathSchema),
    cacheMaxAge: Schema.optional(Schema.String),
    cacheMaxSize: Schema.optional(Schema.String),
    daemon: Schema.optional(Schema.Boolean),
    envMode: Schema.optional(EnvModeSchema),
    boundaries: Schema.optional(RootBoundariesConfigSchema),
    noUpdateNotifier: Schema.optional(Schema.Boolean),
    global: Schema.optional(GlobalConfigSchema),
    futureFlags: Schema.optional(FutureFlagsSchema),
  }),
).annotations({ identifier: "RootSchema" });

export const WorkspaceSchemaSchema = Schema.extend(
  BaseSchemaSchema,
  Schema.Struct({
    extends: Schema.Array(Schema.String),
    tags: Schema.optional(Schema.Array(Schema.String)),
    boundaries: Schema.optional(BoundariesConfigSchema),
  }),
).annotations({ identifier: "WorkspaceSchema" });

export const TurboConfigurationSchema = Schema.Union(
  RootSchemaSchema,
  WorkspaceSchemaSchema,
).annotations({
  jsonSchema: parseDistributedSchema(distributedSchemaBase64),
});
