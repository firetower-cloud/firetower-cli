import { describe, it, expect } from "vitest";
import { publicUrl, certificate, published, type Reach } from "../src/commands/install.js";

/**
 * The three things `install` derives rather than asks, and the only three that
 * can be quietly wrong: everything else it writes is either a secret it
 * generated or an answer somebody typed.
 */

const local: Reach = { kind: "local" };
const domain: Reach = { kind: "domain", domain: "firetower.example.com" };
const proxy: Reach = { kind: "proxy", publicUrl: "https://firetower.example.com" };

const bound = { configurable: true, bindable: true };

describe("publicUrl", () => {
  it("leaves the default port off, because a URL with :80 in it looks broken", () => {
    expect(publicUrl(local, { http: 80, https: 443 })).toBe("http://localhost");
  });

  it("carries a port that is not the default", () => {
    // The whole point of the change, and the default shape now: without this
    // the install succeeds and prints a link to a port nothing is published on.
    expect(publicUrl(local, { http: 8080, https: 8443 })).toBe("http://localhost:8080");
  });

  it("is https for a domain, on Caddy's port rather than the control plane's", () => {
    // 8080 is where the control plane is published, on loopback, behind Caddy.
    // Nobody opens that; they open 443.
    expect(publicUrl(domain, { http: 8080, https: 443 })).toBe("https://firetower.example.com");
  });

  it("carries Caddy's port when that has moved too", () => {
    expect(publicUrl(domain, { http: 8080, https: 8443 })).toBe(
      "https://firetower.example.com:8443",
    );
  });

  it("takes the operator's word for it behind their own proxy", () => {
    // Not derived from the port: what their proxy serves on is theirs to know,
    // and this CLI only ever sees the port published behind it.
    expect(publicUrl(proxy, { http: 8080, https: 8443 })).toBe("https://firetower.example.com");
  });
});

describe("certificate", () => {
  it("says who holds it, in each of the three shapes", () => {
    expect(certificate(local)).toBe("none — plain HTTP, on loopback only");
    expect(certificate(domain)).toBe("yours, from ./certs — see the Caddyfile");
    expect(certificate(proxy)).toBe("yours — Firetower serves plain HTTP");
  });

  it("never promises a certificate Firetower would have to be exposed to get", () => {
    // `domain` used to mean Let's Encrypt, which meant answering a challenge
    // from the internet — with the vault behind it.
    for (const reach of [local, domain, proxy]) {
      expect(certificate(reach)).not.toMatch(/let's encrypt/i);
    }
  });
});

describe("published", () => {
  it("says loopback, because that is the line that matters", () => {
    expect(published(local, { http: 8080, https: 8443, ...bound })).toBe("127.0.0.1:8080");
  });

  it("names Caddy's ports too, when there is a Caddy", () => {
    const summary = published(domain, { http: 8080, https: 443, ...bound });

    expect(summary).toContain("127.0.0.1:8080");
    expect(summary).toContain("443");
  });

  it("admits it when the release cannot be held to loopback", () => {
    // The failure this whole line exists to prevent: a release older than
    // HTTP_BIND publishes on every interface, and saying "127.0.0.1" then
    // would be a promise the compose file does not keep.
    const summary = published(local, { http: 8080, https: 8443, configurable: true, bindable: false });

    expect(summary).not.toContain("127.0.0.1");
    expect(summary).toContain("every interface");
  });
});
