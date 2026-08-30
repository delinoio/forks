import { describe, expect, it } from "@rstest/core";
import {
  normalizeOutput,
  normalizerIds,
} from "../src/compatibility/normalizers.js";

describe("deterministic normalizers", () => {
  it("has exactly the approved normalization identifiers", () => {
    expect(normalizerIds).toEqual([
      "branding",
      "version",
      "executable-path",
      "temporary-path",
      "path-separator",
      "pid",
      "port",
      "request-id",
      "session-id",
      "timestamp",
      "duration",
      "runtime-profile",
      "hosted-identity",
    ]);
  });

  it("is idempotent and only replaces selected fields", () => {
    const input =
      "turbo-ts 0.1.0 pid=42 localhost:3210 /tmp/case request-id=abc";
    const enabled = [
      "branding",
      "version",
      "temporary-path",
      "pid",
      "port",
      "request-id",
    ] as const;
    const once = normalizeOutput(input, enabled, {
      temporaryPaths: ["/tmp/case"],
    });
    expect(
      normalizeOutput(once, enabled, { temporaryPaths: ["/tmp/case"] }),
    ).toBe(once);
    expect(once).toBe(
      "<PRODUCT> <VERSION> pid=<PID> localhost:<PORT> <TEMP> request-id=<REQUEST_ID>",
    );
  });
});
