import type { RootSchema, WorkspaceSchema } from "../src/index.js";

export const validRootType: RootSchema = {
  tasks: {
    build: {
      cache: true,
      outputLogs: "errors-only",
    },
  },
};

export const validWorkspaceType: WorkspaceSchema = {
  extends: ["//"],
  tasks: {},
};

export const invalidRootType: RootSchema = {
  tasks: {
    build: {
      // @ts-expect-error configuration types reject non-boolean cache values.
      cache: "sometimes",
    },
  },
};
