import { describe, expect, it } from "@rstest/core";
import { isForbiddenProductionDependency } from "../src/internal/runtime-dependency-policy.js";

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
});
