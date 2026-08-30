import { Schema } from "effect";

export const OracleInvocationSchema = Schema.Struct({
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  env: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
  stdin: Schema.optional(Schema.String),
});

export type OracleInvocation = Schema.Schema.Type<
  typeof OracleInvocationSchema
>;

export const OracleResultSchema = Schema.Struct({
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
});

export type OracleResult = Schema.Schema.Type<typeof OracleResultSchema>;
