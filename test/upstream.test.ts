import { describe, it, expect } from "vitest";
import { postgresMajor } from "../src/upstream.js";

/**
 * `withAcmeEmail` used to live here, prepending a `{ email … }` global block to
 * the Caddyfile before it was written.
 *
 * It is gone rather than adapted. The Caddyfile now carries its own global
 * block reading `{$ACME_EMAIL}` from the environment, and a Caddyfile may have
 * exactly one — so prepending a second would have turned an address nobody
 * needed into a proxy that could not parse its config at all. The address
 * reaches Caddy through the compose file's environment instead, which also
 * keeps the Caddyfile a file nothing rewrites after it is installed.
 */

describe("postgresMajor", () => {
  it("finds the major version in the compose file", () => {
    expect(postgresMajor("  postgres:\n    image: postgres:17-alpine\n")).toBe(17);
  });

  it("is null when there is nothing to find", () => {
    expect(postgresMajor("services: {}")).toBe(null);
  });
});
