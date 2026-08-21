import { describe, it, expect } from "vitest";
import { decide } from "../src/selfcheck.js";

describe("decide", () => {
  it("blocks when the release requires a newer CLI", () => {
    expect(decide("0.4.0", "0.4.0", { minimumCli: "0.5.0", reason: "why" })).toEqual({
      kind: "blocked",
      minimum: "0.5.0",
      reason: "why",
    });
  });

  it("lets an equal or newer CLI through", () => {
    expect(decide("0.5.0", "0.5.0", { minimumCli: "0.5.0" })).toEqual({ kind: "ok" });
    expect(decide("0.6.0", "0.6.0", { minimumCli: "0.5.0" })).toEqual({ kind: "ok" });
  });

  it("blocks in preference to merely noting a newer release", () => {
    // Being behind what you are about to install matters more than being
    // behind the registry.
    expect(decide("0.4.0", "0.9.0", { minimumCli: "0.5.0" }).kind).toBe("blocked");
  });

  it("only notes a newer version when nothing requires one", () => {
    expect(decide("0.4.0", "0.5.0", null)).toEqual({ kind: "behind", published: "0.5.0" });
  });

  it("says nothing when there is no requirement and nothing newer", () => {
    // deploy/cli.json does not exist upstream today, and every release before
    // it did must keep working.
    expect(decide("0.1.0", "0.1.0", null)).toEqual({ kind: "ok" });
    expect(decide("0.1.0", null, null)).toEqual({ kind: "ok" });
  });

  it("is not fooled by version ordering", () => {
    expect(decide("0.10.0", null, { minimumCli: "0.9.0" })).toEqual({ kind: "ok" });
    expect(decide("0.9.0", null, { minimumCli: "0.10.0" }).kind).toBe("blocked");
  });
});
