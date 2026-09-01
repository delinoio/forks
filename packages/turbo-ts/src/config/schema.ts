import { Schema } from "effect";

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
  allow: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  deny: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
}).annotations({ identifier: "Permissions" });

export const TagRulesSchema = Schema.Struct({
  dependencies: Schema.optional(Schema.NullOr(PermissionsSchema)),
  dependents: Schema.optional(Schema.NullOr(PermissionsSchema)),
}).annotations({ identifier: "TagRules" });

export const BoundariesRulesMapSchema = Schema.Record({
  key: Schema.String,
  value: TagRulesSchema,
}).annotations({ identifier: "BoundariesRulesMap" });

export const BoundariesConfigSchema = Schema.Struct({
  implicitDependencies: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.String)),
  ),
  dependencies: Schema.optional(Schema.NullOr(PermissionsSchema)),
  dependents: Schema.optional(Schema.NullOr(PermissionsSchema)),
}).annotations({ identifier: "BoundariesConfig" });

export const RootBoundariesConfigSchema = Schema.extend(
  BoundariesConfigSchema,
  Schema.Struct({
    tags: Schema.optional(Schema.NullOr(BoundariesRulesMapSchema)),
  }),
).annotations({ identifier: "RootBoundariesConfig" });

export const StartupInputSchema = Schema.Struct({
  mode: Schema.Literal("startup"),
  globs: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  withDefaults: Schema.optional(Schema.NullOr(Schema.Boolean)),
}).annotations({ identifier: "StartupInput" });

export const JitInputSchema = Schema.Struct({
  mode: Schema.Literal("jit"),
  globs: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  withDefaults: Schema.optional(Schema.NullOr(Schema.Boolean)),
}).annotations({ identifier: "JitInput" });

export const DependencyOutputsInputSchema = Schema.Struct({
  mode: Schema.Literal("dependencyOutputs"),
  from: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  globs: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
}).annotations({ identifier: "DependencyOutputsInput" });

export const StructuredInputSchema = Schema.Struct({
  from: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  globs: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  mode: Schema.optional(Schema.NullOr(Schema.String)),
  withDefaults: Schema.optional(Schema.NullOr(Schema.Boolean)),
}).annotations({ identifier: "StructuredInput" });

export const TaskInputSchema = Schema.Union(
  Schema.String,
  StructuredInputSchema,
).annotations({ identifier: "TaskInput" });

export const PipelineSchema = Schema.Struct({
  description: Schema.optional(Schema.NullOr(Schema.String)),
  dependsOn: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  env: Schema.optional(Schema.NullOr(Schema.Array(EnvWildcardSchema))),
  passThroughEnv: Schema.optional(
    Schema.NullOr(Schema.Array(EnvWildcardSchema)),
  ),
  outputs: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  cache: Schema.optional(Schema.NullOr(Schema.Boolean)),
  inputs: Schema.optional(Schema.NullOr(Schema.Array(TaskInputSchema))),
  outputLogs: Schema.optional(Schema.NullOr(OutputLogsSchema)),
  persistent: Schema.optional(Schema.NullOr(Schema.Boolean)),
  interactive: Schema.optional(Schema.NullOr(Schema.Boolean)),
  interruptible: Schema.optional(Schema.NullOr(Schema.Boolean)),
  with: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
}).annotations({ identifier: "Pipeline" });

// Turbo 2.10.12 documents task-level `extends` for package configurations but
// omits it from the distributed Pipeline definition. Keep the package-only
// field in its own authoritative Effect schema so the public distributed
// Schema can remain byte-for-byte compatible. This split can be removed when a
// future compatibility baseline includes the field in its distributed schema.
export const WorkspacePipelineSchema = Schema.extend(
  PipelineSchema,
  Schema.Struct({
    extends: Schema.optional(Schema.Boolean),
  }),
).annotations({ identifier: "WorkspacePipeline" });

export const RemoteCacheSchema = Schema.Struct({
  signature: Schema.optional(Schema.NullOr(Schema.Boolean)),
  enabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
  preflight: Schema.optional(Schema.NullOr(Schema.Boolean)),
  apiUrl: Schema.optional(Schema.NullOr(Schema.String)),
  loginUrl: Schema.optional(Schema.NullOr(Schema.String)),
  timeout: Schema.optional(Schema.NullOr(Schema.NonNegativeInt)),
  uploadTimeout: Schema.optional(Schema.NullOr(Schema.NonNegativeInt)),
  teamId: Schema.optional(Schema.NullOr(Schema.String)),
  teamSlug: Schema.optional(Schema.NullOr(Schema.String)),
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
  inputs: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  env: Schema.optional(Schema.NullOr(Schema.Array(EnvWildcardSchema))),
  passThroughEnv: Schema.optional(
    Schema.NullOr(Schema.Array(EnvWildcardSchema)),
  ),
  remoteCache: Schema.optional(Schema.NullOr(RemoteCacheSchema)),
  ui: Schema.optional(Schema.NullOr(UiSchema)),
  concurrency: Schema.optional(Schema.NullOr(Schema.String)),
  dangerouslyDisablePackageManagerCheck: Schema.optional(
    Schema.NullOr(Schema.Boolean),
  ),
  cacheDir: Schema.optional(Schema.NullOr(RelativeUnixPathSchema)),
  cacheMaxAge: Schema.optional(Schema.NullOr(Schema.String)),
  cacheMaxSize: Schema.optional(Schema.NullOr(Schema.String)),
  daemon: Schema.optional(Schema.NullOr(Schema.Boolean)),
  envMode: Schema.optional(Schema.NullOr(EnvModeSchema)),
  noUpdateNotifier: Schema.optional(Schema.NullOr(Schema.Boolean)),
}).annotations({ identifier: "GlobalConfig" });

export const TasksSchema = Schema.Record({
  key: Schema.String,
  value: PipelineSchema,
});

export const WorkspaceTasksSchema = Schema.Record({
  key: Schema.String,
  value: WorkspacePipelineSchema,
});

export const BaseSchemaSchema = Schema.Struct({
  $schema: Schema.optional(Schema.NullOr(Schema.String)),
  tasks: Schema.optional(Schema.NullOr(TasksSchema)),
}).annotations({ identifier: "BaseSchema" });

export const RootSchemaSchema = Schema.extend(
  BaseSchemaSchema,
  Schema.Struct({
    globalDependencies: Schema.optional(
      Schema.NullOr(Schema.Array(Schema.String)),
    ),
    globalEnv: Schema.optional(Schema.NullOr(Schema.Array(EnvWildcardSchema))),
    globalPassThroughEnv: Schema.optional(
      Schema.NullOr(Schema.Array(EnvWildcardSchema)),
    ),
    remoteCache: Schema.optional(Schema.NullOr(RemoteCacheSchema)),
    ui: Schema.optional(Schema.NullOr(UiSchema)),
    concurrency: Schema.optional(Schema.NullOr(Schema.String)),
    dangerouslyDisablePackageManagerCheck: Schema.optional(
      Schema.NullOr(Schema.Boolean),
    ),
    cacheDir: Schema.optional(Schema.NullOr(RelativeUnixPathSchema)),
    cacheMaxAge: Schema.optional(Schema.NullOr(Schema.String)),
    cacheMaxSize: Schema.optional(Schema.NullOr(Schema.String)),
    daemon: Schema.optional(Schema.NullOr(Schema.Boolean)),
    envMode: Schema.optional(Schema.NullOr(EnvModeSchema)),
    boundaries: Schema.optional(Schema.NullOr(RootBoundariesConfigSchema)),
    noUpdateNotifier: Schema.optional(Schema.NullOr(Schema.Boolean)),
    global: Schema.optional(Schema.NullOr(GlobalConfigSchema)),
    futureFlags: Schema.optional(Schema.NullOr(FutureFlagsSchema)),
  }),
).annotations({ identifier: "RootSchema" });

export const WorkspaceSchemaSchema = Schema.Struct({
  $schema: Schema.optional(Schema.NullOr(Schema.String)),
  tasks: Schema.optional(Schema.NullOr(WorkspaceTasksSchema)),
  extends: Schema.NullOr(Schema.Array(Schema.String)),
  tags: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  boundaries: Schema.optional(Schema.NullOr(BoundariesConfigSchema)),
}).annotations({ identifier: "WorkspaceSchema" });

export const TurboConfigurationSchema = Schema.extend(
  RootSchemaSchema,
  Schema.Struct({
    extends: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    tags: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  }),
);
