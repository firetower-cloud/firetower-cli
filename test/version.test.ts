import { describe, it, expect } from "vitest";
import { compare, versionFromTag } from "../src/version.js";

describe("compare", () => {
  it("orders by number, not by string", () => {
    // The one that matters: 0.10.0 is newer than 0.9.0, and a string compare
    // would call every host on 0.10.0 out of date.
    expect(compare("0.10.0", "0.9.0")).toBeGreaterThan(0);
  });

  it("is zero for the same version, with or without a v", () => {
    expect(compare("0.4.0", "0.4.0")).toBe(0);
    expect(compare("v0.4.0", "0.4.0")).toBe(0);
  });

  it("treats a missing segment as zero", () => {
    expect(compare("0.4", "0.4.0")).toBe(0);
    expect(compare("0.4", "0.4.1")).toBeLessThan(0);
  });

  it("says nothing rather than something wrong about a version it cannot read", () => {
    // A worker reporting something unparseable is a reason to stay quiet, not
    // to claim it is behind.
    expect(compare("nightly", "0.4.0")).toBe(0);
  });
});

describe("versionFromTag", () => {
  it("reads the version out of a release-please tag", () => {
    // The main repository tags releases `firetower-v0.4.0`, so stripping a
    // leading `v` is not enough.
    expect(versionFromTag("firetower-v0.4.0")).toBe("0.4.0");
    expect(versionFromTag("v0.4.0")).toBe("0.4.0");
    expect(versionFromTag("0.4.0")).toBe("0.4.0");
  });

  it("is null for a tag with no version in it", () => {
    expect(versionFromTag("latest")).toBe(null);
  });
});
