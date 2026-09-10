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

  it("does not normalize versions in user-controlled output or paths", () => {
    const input =
      "task emitted release 0.1.0 from /artifacts/turbo/2.10.12/output";
    expect(normalizeOutput(input, ["version"])).toBe(input);
  });

  it("normalizes the complete candidate identity line only when selected", () => {
    expect(normalizeOutput(`${versionOutput}\n`, ["version"])).toBe(
      "turbo-ts <VERSION> (compatible with turbo <VERSION>)\n",
    );
  });

  it("normalizes only the complete command banner", () => {
    expect(normalizeOutput(`• ${versionOutput}\n`, ["branding"])).toBe(
      "• turbo 2.10.12\n",
    );
    expect(
      normalizeOutput(`task printed • ${versionOutput}\n`, ["branding"]),
    ).toBe(`task printed • ${versionOutput}\n`);
  });
});
