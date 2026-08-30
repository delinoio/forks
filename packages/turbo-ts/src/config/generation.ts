export const generatedConfigurationTypes = `// This file is generated. Run \`pnpm generate\` after changing config/schema.ts.
import type { Schema as EffectSchema } from "effect";
import type {
  BaseSchemaSchema,
  BoundariesConfigSchema,
  BoundariesRulesMapSchema,
  DependencyOutputsInputSchema,
  EnvModeSchema,
  EnvWildcardSchema,
  FutureFlagsSchema,
  GlobalConfigSchema,
  JitInputSchema,
  OutputLogsSchema,
  PermissionsSchema,
  PipelineSchema,
  RelativeUnixPathSchema,
  RemoteCacheSchema,
  RootBoundariesConfigSchema,
  RootSchemaSchema,
  StartupInputSchema,
  StructuredInputSchema,
  TaskInputSchema,
  TurboConfigurationSchema,
  UiSchema,
  WorkspaceSchemaSchema,
} from "../config/schema.js";

export type BaseSchema = EffectSchema.Schema.Type<typeof BaseSchemaSchema>;
export type BoundariesConfig = EffectSchema.Schema.Type<
  typeof BoundariesConfigSchema
>;
export type BoundariesRulesMap = EffectSchema.Schema.Type<
  typeof BoundariesRulesMapSchema
>;
export type DependencyOutputsInput = EffectSchema.Schema.Type<
  typeof DependencyOutputsInputSchema
>;
export type EnvMode = EffectSchema.Schema.Type<typeof EnvModeSchema>;
export type EnvWildcard = EffectSchema.Schema.Type<typeof EnvWildcardSchema>;
export type FutureFlags = EffectSchema.Schema.Type<typeof FutureFlagsSchema>;
export type GlobalConfig = EffectSchema.Schema.Type<typeof GlobalConfigSchema>;
export type JitInput = EffectSchema.Schema.Type<typeof JitInputSchema>;
export type OutputLogs = EffectSchema.Schema.Type<typeof OutputLogsSchema>;
export type Permissions = EffectSchema.Schema.Type<typeof PermissionsSchema>;
export type Pipeline = EffectSchema.Schema.Type<typeof PipelineSchema>;
export type RelativeUnixPath = EffectSchema.Schema.Type<
  typeof RelativeUnixPathSchema
>;
export type RemoteCache = EffectSchema.Schema.Type<typeof RemoteCacheSchema>;
export type RootBoundariesConfig = EffectSchema.Schema.Type<
  typeof RootBoundariesConfigSchema
>;
export type RootSchema = EffectSchema.Schema.Type<typeof RootSchemaSchema>;
export type Schema = EffectSchema.Schema.Type<typeof TurboConfigurationSchema>;
export type StartupInput = EffectSchema.Schema.Type<typeof StartupInputSchema>;
export type StructuredInput = EffectSchema.Schema.Type<
  typeof StructuredInputSchema
>;
export type TaskInput = EffectSchema.Schema.Type<typeof TaskInputSchema>;
export type UI = EffectSchema.Schema.Type<typeof UiSchema>;
export type WorkspaceSchema = EffectSchema.Schema.Type<
  typeof WorkspaceSchemaSchema
>;
`;
