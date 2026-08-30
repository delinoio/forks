import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

const sourceFiles = async (directory: string): Promise<Array<string>> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? sourceFiles(path)
        : Promise.resolve(path.endsWith(".ts") ? [path] : []);
    }),
  );
  return nested.flat();
};

describe("clean-room architecture", () => {
  it("does not import Turbo implementation packages", async () => {
    for (const file of await sourceFiles(`${packageRoot}/src`)) {
      const contents = await readFile(file, "utf8");
      expect(contents, relative(packageRoot, file)).not.toMatch(
        /from\s+["'](?:turbo|@turbo\/)/,
      );
    }
  });

  it("confines Node boundary imports to adapters and entrypoints", async () => {
    const allowed = new Set([
      "src/effect/node-layer.ts",
      "src/internal/generate-configuration.ts",
    ]);
    for (const file of await sourceFiles(`${packageRoot}/src`)) {
      const contents = await readFile(file, "utf8");
      if (/from\s+["']node:/.test(contents)) {
        expect(allowed.has(relative(packageRoot, file))).toBe(true);
      }
    }
  });
});
