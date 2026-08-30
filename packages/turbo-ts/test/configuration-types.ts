import type {
  RootSchema,
  Schema as TurboConfiguration,
  WorkspaceSchema,
} from "../src/index.js";

export const validEmptyRootType: RootSchema = {};

export const validNullTasksRootType: RootSchema = { tasks: null };

export const validRootType: RootSchema = {
  tasks: {
    build: {
      cache: null,
      inputs: [
        {},
        { mode: null, globs: null },
        { mode: "future-mode", withDefaults: null },
      ],
      outputLogs: null,
    },
  },
  remoteCache: null,
};

export const validWorkspaceType: WorkspaceSchema = {
  extends: ["//"],
};

export const validMixedConfigurationType: TurboConfiguration = {
  extends: ["//"],
  globalDependencies: ["package.json"],
  tags: ["app"],
};

export const validNullTasksWorkspaceType: WorkspaceSchema = {
  extends: null,
  tasks: null,
};

export const invalidRootType: RootSchema = {
  tasks: {
    build: {
      // @ts-expect-error configuration types reject non-boolean cache values.
      cache: "sometimes",
    },
  },
};
