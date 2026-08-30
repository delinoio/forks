import { describe, expect, it } from "@rstest/core";
import { evidenceId } from "../src/compatibility/ledger.js";
import {
  normalizeOutput,
  normalizerIds,
} from "../src/compatibility/normalizers.js";

describe("deterministic normalizers", () => {
  it(evidenceId.normalizersAllowlist, () => {
    expect(normalizerIds).toEqual([
      "branding",
      "version",
      "executable-path",
      "temporary-path",
      "path-separator",
    ]);
  });

  it(evidenceId.normalizersDeterministic, () => {
    const input = "turbo-ts 0.1.0 /opt/tool /tmp/case nested\\path";
    const enabled = [
      "branding",
      "version",
      "executable-path",
      "temporary-path",
      "path-separator",
    ] as const;
    const once = normalizeOutput(input, enabled, {
      executablePaths: ["/opt/tool"],
      temporaryPaths: ["/tmp/case"],
    });
    expect(
      normalizeOutput(once, enabled, {
        executablePaths: ["/opt/tool"],
        temporaryPaths: ["/tmp/case"],
      }),
    ).toBe(once);
    expect(once).toBe("<PRODUCT> <VERSION> <EXECUTABLE> <TEMP> nested/path");
  });
});
