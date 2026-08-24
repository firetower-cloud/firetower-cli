import { describe, it, expect } from "vitest";
import { publicUrl, certificate, type Reach } from "../src/commands/install.js";

/**
 * The two things `install` derives rather than asks, and the only two that can
 * be quietly wrong: everything else it writes is either a secret it generated
 * or an answer somebody typed.
 */

const local: Reach = { kind: "local" };
const domain: Reach = { kind: "domain", domain: "firetower.example.com" };
const proxy: Reach = { kind: "proxy", publicUrl: "https://firetower.example.com" };

describe("publicUrl", () => {
  it("leaves the default port off, because a URL with :80 in it looks broken", () => {
    expect(publicUrl(local, { http: 80 })).toBe("http://localhost");
  });

  it("carries a port that is not the default", () => {
    // The whole point of the change. Without this the install succeeds and
    // prints a link to a port nothing is published on.
    expect(publicUrl(local, { http: 8080 })).toBe("http://localhost:8080");
  });

  it("is https for a domain, whose ports cannot have moved", () => {
    expect(publicUrl(domain, { http: 80 })).toBe("https://firetower.example.com");
  });

  it("takes the operator's word for it behind their own proxy", () => {
    // Not derived from the port: what their proxy serves on is theirs to know,
    // and this CLI only ever sees the port Caddy is published on behind it.
    expect(publicUrl(proxy, { http: 8080 })).toBe("https://firetower.example.com");
  });
});

describe("certificate", () => {
  it("says who holds it, in each of the three shapes", () => {
    expect(certificate(local)).toBe("none — plain HTTP");
    expect(certificate(domain)).toBe("Caddy, automatic, from Let's Encrypt");
    expect(certificate(proxy)).toBe("yours — Firetower serves plain HTTP");
  });
});
