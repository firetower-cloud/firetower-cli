import { describe, it, expect } from "vitest";
import { withAcmeEmail, postgresMajor } from "../src/upstream.js";

describe("withAcmeEmail", () => {
  it("leaves the file alone when there is no address", () => {
    const caddyfile = "{$DOMAIN} {\n\treverse_proxy firetower:4400\n}\n";
    expect(withAcmeEmail(caddyfile, null)).toBe(caddyfile);
  });

  it("adds the block Caddy needs to send renewal warnings", () => {
    const result = withAcmeEmail("{$DOMAIN} {\n}\n", "ops@example.com");
    expect(result.startsWith("{\n\temail ops@example.com\n}\n")).toBe(true);
  });
});

describe("postgresMajor", () => {
  it("finds the major version in the compose file", () => {
    expect(postgresMajor("  postgres:\n    image: postgres:17-alpine\n")).toBe(17);
  });

  it("is null when there is nothing to find", () => {
    expect(postgresMajor("services: {}")).toBe(null);
  });
});
