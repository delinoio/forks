import { describe, expect, it } from "@rstest/core";
import { evidenceId } from "../src/compatibility/ledger.js";
import {
  normalizeOutput,
  normalizerIds,
} from "../src/compatibility/normalizers.js";
import { versionOutput } from "../src/version.js";

describe("deterministic normalizers", () => {
  it(evidenceId.normalizersAllowlist, () => {
    expect(normalizerIds).toEqual(["branding", "version"]);
  });

  it(evidenceId.normalizersDeterministic, () => {
    const enabled = ["branding", "version"] as const;
    const candidate = normalizeOutput(`${versionOutput}\r\n`, enabled);
    const reference = normalizeOutput("2.10.12\r\n", enabled);
    expect(candidate).toBe("<VERSION>\r\n");
    expect(reference).toBe(candidate);
    expect(normalizeOutput(candidate, enabled)).toBe(candidate);
  });

  it("does not normalize branding in user-controlled output", () => {
    const input =
      "task turbo emitted turbo-ts /opt/turbo nested\\turbo-ts payload";
    expect(normalizeOutput(input, ["branding"])).toBe(input);
  });
});
