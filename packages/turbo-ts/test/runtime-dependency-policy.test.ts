import { describe, expect, it } from "@rstest/core";
import {
  haveExactProductionDependencySections,
  isForbiddenProductionDependency,
  productionDependencyEntries,
} from "../src/internal/runtime-dependency-policy.js";

describe("runtime dependency policy", () => {
  it("rejects the Parcel native watcher explicitly", () => {
    expect(isForbiddenProductionDependency("@parcel/watcher@2.5.6")).toBe(true);
  });

  it("retains existing native heuristics without rejecting pure packages", () => {
    expect(isForbiddenProductionDependency("node-addon-api@8.5.0")).toBe(true);
    expect(isForbiddenProductionDependency("msgpackr-extract@3.0.3")).toBe(
      true,
    );
    expect(isForbiddenProductionDependency("effect@3.22.1")).toBe(false);
  });

  it("validates optional dependencies as a separate production section", () => {
    const expected = {
      dependencies: { effect: "3.22.1" },
      optionalDependencies: {},
    };
    expect(
      haveExactProductionDependencySections(
        { dependencies: { effect: "3.22.1" } },
        expected,
      ),
    ).toBe(true);
    expect(
      haveExactProductionDependencySections(
        {
          dependencies: { effect: "3.22.1" },
          optionalDependencies: { "node-addon-api": "8.5.0" },
        },
        expected,
      ),
    ).toBe(false);
  });

  it("seeds production traversal from optional importer dependencies", () => {
    expect(
      productionDependencyEntries({
        dependencies: { effect: { version: "3.22.1" } },
        optionalDependencies: {
          "node-addon-api": { version: "8.5.0" },
        },
      }),
    ).toEqual([
      ["effect", { version: "3.22.1" }],
      ["node-addon-api", { version: "8.5.0" }],
    ]);
  });
});
