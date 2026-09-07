import { describe, it, expect } from "vitest";
import { infer, derive, choosePorts, ALTERNATE, type Ports, type Reach } from "../src/shape.js";
import * as env from "../src/env.js";
import * as services from "../src/services.js";
import { hostPorts } from "../src/docker.js";

/**
 * The derivation `upgrade` relies on, and the reason it exists.
 *
 * A deployment installed before `HTTP_PORT` changed meaning came out of an
 * upgrade holding a value that described something else — Caddy's host port,
 * read as the control plane's — and failed to bind against a container from
 * its own previous release. None of what follows translates an old value into
 * a new one. It recomputes, which is the only thing that survives a release
 * renaming a variable nobody warned this CLI about.
 */

/** The release in the report: the control plane publishes its own port. */
const CURRENT = `
name: firetower
services:
  firetower:
    image: ghcr.io/firetower-cloud/firetower:latest
    ports:
      - "\${HTTP_BIND:-127.0.0.1}:\${HTTP_PORT:-8080}:4400"
  caddy:
    profiles: [tls]
    image: caddy:2-alpine
    ports:
      - "\${HTTPS_BIND:-0.0.0.0}:\${HTTPS_PORT:-443}:443"
      - "\${HTTPS_BIND:-0.0.0.0}:80:80"
  postgres:
    image: postgres:17-alpine
`;

/** The release before it: Caddy is the front door and owns HTTP_PORT. */
const PREVIOUS = `
name: firetower
services:
  caddy:
    image: caddy:2-alpine
    ports:
      - "\${HTTP_PORT:-80}:80"
      - "\${HTTPS_PORT:-443}:443"
  firetower:
    image: ghcr.io/firetower-cloud/firetower:latest
  postgres:
    image: postgres:17-alpine
`;

const bound: Pick<Ports, "configurable" | "bindable"> = { configurable: true, bindable: true };

describe("infer", () => {
  it("reads the reported deployment as loopback", () => {
    // Verbatim from the .env in the report — written by a CLI old enough that
    // HTTP_PORT still meant Caddy's, which is exactly the file that has to be
    // understood without believing any of its values.
    const reach = infer({
      DOMAIN: "",
      HTTP_PORT: "80",
      HTTPS_PORT: "443",
      FIRETOWER_PUBLIC_URL: "http://localhost",
    });

    expect(reach).toEqual({ kind: "local" });
  });

  it("takes a domain as the domain shape", () => {
    expect(infer({ DOMAIN: "firetower.example.com" })).toEqual({
      kind: "domain",
      domain: "firetower.example.com",
    });
  });

  it("reads an address that is not this machine as somebody else's proxy", () => {
    expect(infer({ DOMAIN: "", FIRETOWER_PUBLIC_URL: "https://firetower.example.com" })).toEqual({
      kind: "proxy",
      publicUrl: "https://firetower.example.com",
    });
  });

  it("does not mistake a loopback address for a proxy", () => {
    // The `local` shape writes one of these, so reading it back as a proxy
    // would turn every tunnel install into one on the next upgrade.
    expect(infer({ FIRETOWER_PUBLIC_URL: "http://127.0.0.1:8080" })).toEqual({ kind: "local" });
  });

  it("falls to loopback on a value it cannot parse", () => {
    // The safe answer: it publishes on 127.0.0.1 and promises nothing.
    expect(infer({ FIRETOWER_PUBLIC_URL: "not a url" })).toEqual({ kind: "local" });
  });

  it("reads an empty file as loopback", () => {
    expect(infer({})).toEqual({ kind: "local" });
  });
});

describe("derive", () => {
  it("puts the control plane on loopback and writes no proxy", () => {
    const values = derive({ kind: "local" }, { http: 8080, https: 8443, ...bound });

    expect(values).toEqual({
      DOMAIN: "",
      HTTP_BIND: "127.0.0.1",
      HTTP_PORT: "8080",
      FIRETOWER_PUBLIC_URL: "http://localhost:8080",
    });
    // Not merely absent from the assertion above — Caddy is not created in this
    // shape, so a port for it is a value nothing reads.
    expect(values.HTTPS_PORT).toBeUndefined();
    expect(values.COMPOSE_PROFILES).toBeUndefined();
  });

  it("turns the tls profile on for a domain, and nothing else does", () => {
    const reach: Reach = { kind: "domain", domain: "firetower.example.com" };
    const values = derive(reach, { http: 8080, https: 443, ...bound });

    expect(values.COMPOSE_PROFILES).toBe("tls");
    expect(values.HTTPS_PORT).toBe("443");
    expect(values.FIRETOWER_PREVIEW_DOMAIN).toBe("firetower.example.com");
    // Caddy's address, not the control plane's loopback port.
    expect(values.FIRETOWER_PUBLIC_URL).toBe("https://firetower.example.com");
  });

  it("writes no ports at all against a release that hardcodes them", () => {
    // Writing HTTP_PORT here would put a number in .env that nothing reads,
    // and leave somebody certain they had moved a port that never moved.
    const values = derive(
      { kind: "local" },
      { http: 80, https: 443, configurable: false, bindable: false },
    );

    expect(values.HTTP_PORT).toBeUndefined();
    expect(values.HTTP_BIND).toBeUndefined();
  });
});

describe("choosePorts", () => {
  it("moves a deployment off the port it was installed on when the meaning changed", async () => {
    // The regression. `HTTP_PORT=80` was Caddy's; on the current release the
    // same name is the control plane's, and the answer is a high port.
    //
    // Not asserted as 8080 exactly: unattended selection walks up from there to
    // something free, so pinning the number makes this test fail on any machine
    // that happens to be running Firetower — including one running the release
    // under test.
    const ports = await choosePorts({ kind: "local" }, CURRENT, { yes: true }, new Set([80, 443]));

    expect(ports.http).not.toBe(80);
    expect(ports.http).toBeGreaterThanOrEqual(ALTERNATE.http);
    expect(ports.bindable).toBe(true);
  });

  it("treats a port this deployment already holds as free", async () => {
    // Its own control plane is what answers on 8080 during an upgrade, and
    // being steered off a port by yourself is not a port conflict.
    const ports = await choosePorts({ kind: "local" }, CURRENT, { yes: true }, new Set([8080]));

    expect(ports.http).toBe(8080);
  });

  it("keeps the control plane out of Caddy's way when there is a certificate", async () => {
    const reach: Reach = { kind: "domain", domain: "firetower.example.com" };
    const ports = await choosePorts(reach, CURRENT, {}, new Set());

    expect(ports.http).toBe(8080);
    expect(ports.https).toBe(443);
  });

  it("reports the previous release as unable to hold the vault to loopback", async () => {
    const ports = await choosePorts({ kind: "local" }, PREVIOUS, { yes: true }, new Set());

    expect(ports.bindable).toBe(false);
    // It does read HTTP_PORT — on Caddy — so the port is still choosable.
    expect(ports.configurable).toBe(true);
  });
});

describe("portOwner", () => {
  it("names the service a port variable actually belongs to", () => {
    // The whole basis for telling a re-purposed name from a stable one.
    expect(services.portOwner(PREVIOUS, "HTTP_PORT")).toBe("caddy");
    expect(services.portOwner(CURRENT, "HTTP_PORT")).toBe("firetower");
  });

  it("says nothing about a variable no ports entry reads", () => {
    // An absence is not evidence, and treating it as one is how a port stops
    // being honoured without anybody being told.
    expect(services.portOwner(CURRENT, "NOT_A_PORT")).toBeNull();
  });

  it("finds the owner of a variable that is one of several on a service", () => {
    expect(services.portOwner(CURRENT, "HTTPS_PORT")).toBe("caddy");
  });
});

describe("allProfiles", () => {
  it("finds the profile a service moved behind", () => {
    // `down` has to select these or it walks past the container holding the
    // port — a profile-gated service is not an orphan, just an unselected one.
    expect(services.allProfiles(CURRENT)).toEqual(["tls"]);
  });

  it("has nothing to say about a file with no profiles at all", () => {
    expect(services.allProfiles(PREVIOUS)).toEqual([]);
  });
});

describe("reshape", () => {
  const previous: env.Env = {
    DOMAIN: "",
    HTTP_PORT: "80",
    HTTPS_PORT: "443",
    FIRETOWER_PUBLIC_URL: "http://localhost",
    POSTGRES_PASSWORD: "kept-secret",
    FIRETOWER_ROOT_KEY: "kept-key",
    ADMIN_USERNAME: "admin",
    FIRETOWER_TRUSTED_PROXY: "10.0.0.0/8",
  };

  const next = env.reshape(previous, derive({ kind: "local" }, { http: 8080, https: 8443, ...bound }));

  it("recomputes the value whose meaning changed", () => {
    expect(next.HTTP_PORT).toBe("8080");
    expect(next.FIRETOWER_PUBLIC_URL).toBe("http://localhost:8080");
  });

  it("drops an owned key the new release has no use for", () => {
    // Caddy is not created without the tls profile, so a port for it is not a
    // stale-but-harmless value: it is one somebody will read back and believe.
    expect(next).not.toHaveProperty("HTTPS_PORT");
  });

  it("never touches a sealed value", () => {
    // The whole of env.ts exists for this. A new root key over an existing
    // database does not fail — it makes every stored credential unreadable.
    expect(next.FIRETOWER_ROOT_KEY).toBe("kept-key");
    expect(next.POSTGRES_PASSWORD).toBe("kept-secret");
    expect(next.ADMIN_USERNAME).toBe("admin");
  });

  it("carries a key it does not own", () => {
    expect(next.FIRETOWER_TRUSTED_PROXY).toBe("10.0.0.0/8");
  });

  it("survives the round trip through the file it writes", () => {
    // `format` emits the explained keys and then everything else; a key that
    // fell out of both lists would be silently lost on the next upgrade.
    expect(env.parse(env.format(next))).toEqual(next);
  });
});

describe("changes", () => {
  it("names every value that moves, and only those", () => {
    const before = { HTTP_PORT: "80", HTTPS_PORT: "443", POSTGRES_PASSWORD: "x" };
    const after = { HTTP_PORT: "8080", POSTGRES_PASSWORD: "x", HTTP_BIND: "127.0.0.1" };

    expect(env.changes(before, after)).toEqual([
      { key: "HTTPS_PORT", before: "443", after: undefined },
      { key: "HTTP_BIND", before: undefined, after: "127.0.0.1" },
      { key: "HTTP_PORT", before: "80", after: "8080" },
    ]);
  });

  it("says nothing about a deployment that is already the right shape", () => {
    const values = { HTTP_PORT: "8080" };
    expect(env.changes(values, { ...values })).toEqual([]);
  });
});

describe("createdServices", () => {
  it("leaves out a service behind a profile that is off", () => {
    // Which is what makes the old Caddy an orphan rather than a service that
    // failed to start: Compose neither creates it nor stops it.
    expect(services.createdServices(CURRENT, [])).toEqual(["firetower", "postgres"]);
  });

  it("includes it once the profile is on", () => {
    expect(services.createdServices(CURRENT, ["tls"])).toContain("caddy");
  });
});

describe("hostPorts", () => {
  it("reads the ports a container actually holds", () => {
    // Straight from `docker ps` for the Caddy in the report.
    expect(hostPorts("0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp, 443/udp, 2019/tcp").sort()).toEqual(
      [443, 80].sort(),
    );
  });

  it("ignores an exposed port that binds nothing on this machine", () => {
    expect(hostPorts("5432/tcp")).toEqual([]);
  });

  it("reads an IPv6 binding", () => {
    expect(hostPorts("[::]:8080->4400/tcp")).toEqual([8080]);
  });

  it("has nothing to say about a container that publishes nothing", () => {
    expect(hostPorts("")).toEqual([]);
  });
});
