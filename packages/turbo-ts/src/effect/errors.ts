import { Schema } from "effect";

export class BoundaryError extends Schema.TaggedError<BoundaryError>(
  "BoundaryError",
)("BoundaryError", {
  boundary: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
}) {}

export class ProcessExecutionError extends Schema.TaggedError<ProcessExecutionError>(
  "ProcessExecutionError",
)("ProcessExecutionError", {
  command: Schema.String,
  message: Schema.String,
}) {}

export class OracleError extends Schema.TaggedError<OracleError>("OracleError")(
  "OracleError",
  {
    message: Schema.String,
  },
) {}

export class GeneratedFileError extends Schema.TaggedError<GeneratedFileError>(
  "GeneratedFileError",
)("GeneratedFileError", {
  path: Schema.String,
  message: Schema.String,
}) {}

export class LedgerError extends Schema.TaggedError<LedgerError>("LedgerError")(
  "LedgerError",
  {
    message: Schema.String,
  },
) {}

export class UnsupportedCompatibilityError extends Schema.TaggedError<UnsupportedCompatibilityError>(
  "UnsupportedCompatibilityError",
)("UnsupportedCompatibilityError", {
  surface: Schema.String,
  targetGate: Schema.Number,
}) {}

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>(
  "ConfigurationError",
)("ConfigurationError", {
  path: Schema.String,
  message: Schema.String,
}) {}

export class RepositoryError extends Schema.TaggedError<RepositoryError>(
  "RepositoryError",
)("RepositoryError", {
  path: Schema.String,
  message: Schema.String,
}) {}

export class GraphError extends Schema.TaggedError<GraphError>("GraphError")(
  "GraphError",
  {
    task: Schema.String,
    message: Schema.String,
  },
) {}

export class FilterError extends Schema.TaggedError<FilterError>("FilterError")(
  "FilterError",
  {
    filter: Schema.String,
    message: Schema.String,
  },
) {}

export class CacheError extends Schema.TaggedError<CacheError>("CacheError")(
  "CacheError",
  {
    path: Schema.String,
    message: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

export class TaskExecutionError extends Schema.TaggedError<TaskExecutionError>(
  "TaskExecutionError",
)("TaskExecutionError", {
  task: Schema.String,
  exitCode: Schema.Number,
  message: Schema.String,
}) {}
