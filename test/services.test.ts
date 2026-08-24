import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as services from "../src/services.js";
import { missingVariables } from "../src/deployment.js";

// The file the CLI actually writes, so these are assertions about reality
// rather than about a fixture that agrees with them.
const COMPOSE = readFileSync(join(import.meta.dirname, "..", "fallback", "firetower.yml"), "utf8");

describe("resolve", () => {
  it("finds the services in the real compose file", () => {
    const resolved = services.resolve(COMPOSE);

    expect(resolved.control).toBe("firetower");
    expect(resolved.database).toBe("postgres");
    expect(resolved.proxy).toBe("caddy");
  });

  it("follows a rename, because it matches on the image", () => {
    // The failure this replaces: waitForHealthy(…, "postgres") against a file
    // that calls it something else spins for three minutes and then fails an
    // install of a stack that came up fine.
    const renamed = COMPOSE.replace(/^ {2}postgres:$/m, "  db:").replace(
      /^ {2}firetower:$/m,
      "  control-plane:",
    );

    const resolved = services.resolve(renamed);
    expect(resolved.database).toBe("db");
    expect(resolved.control).toBe("control-plane");
  });

  it("does not mistake the worker image for the control plane", () => {
    const withWorker = `services:
  worker:
    image: ghcr.io/firetower-cloud/firetower-worker:latest
  brain:
    image: ghcr.io/firetower-cloud/firetower:latest
`;

    expect(services.resolve(withWorker).control).toBe("brain");
  });

  it("falls back to the conventional names when the file is unreadable", () => {
    expect(services.resolve("{{{ not yaml").control).toBe("firetower");
    expect(services.resolve("services: {}").database).toBe("postgres");
  });
});

describe("requiredVariables", () => {
  it("finds the one the compose file insists on today", () => {
    expect(services.requiredVariables(COMPOSE)).toEqual(["POSTGRES_PASSWORD"]);
  });

  it("finds one a future release might add", () => {
    const next = COMPOSE.replace(
      "FIRETOWER_ROOT_KEY: ${FIRETOWER_ROOT_KEY:-}",
      "FIRETOWER_ROOT_KEY: ${FIRETOWER_ROOT_KEY:?set it}",
    );

    expect(services.requiredVariables(next)).toContain("FIRETOWER_ROOT_KEY");
  });

  it("ignores a variable that merely has a default", () => {
    expect(services.requiredVariables("x: ${DOMAIN:-:80}")).toEqual([]);
  });
});

describe("missingVariables", () => {
  it("is empty when the .env supplies everything required", () => {
    expect(missingVariables(COMPOSE, { POSTGRES_PASSWORD: "hunter2" })).toEqual([]);
  });

  it("reports a required variable that is absent or empty", () => {
    expect(missingVariables(COMPOSE, {})).toEqual(["POSTGRES_PASSWORD"]);
    expect(missingVariables(COMPOSE, { POSTGRES_PASSWORD: "" })).toEqual(["POSTGRES_PASSWORD"]);
  });
});

describe("databaseIdentity", () => {
  const resolved = services.resolve(COMPOSE);

  it("uses the compose file's defaults when .env is silent", () => {
    expect(services.databaseIdentity(COMPOSE, resolved, {})).toEqual({
      user: "firetower",
      database: "firetower",
    });
  });

  it("follows .env when it overrides them", () => {
    // pg_dump had both hardcoded. This is the case that broke the backup
    // `upgrade` takes immediately before applying migrations.
    expect(
      services.databaseIdentity(COMPOSE, resolved, {
        POSTGRES_USER: "ft",
        POSTGRES_DB: "production",
      }),
    ).toEqual({ user: "ft", database: "production" });
  });

  it("follows a changed default in the compose file", () => {
    const changed = COMPOSE.replace(/\$\{POSTGRES_DB:-firetower\}/g, "${POSTGRES_DB:-ft_main}");
    expect(services.databaseIdentity(changed, resolved, {}).database).toBe("ft_main");
  });
});

describe("interpolate", () => {
  it("resolves the forms a compose file uses", () => {
    expect(services.interpolate("${A:-fallback}", {})).toBe("fallback");
    expect(services.interpolate("${A:-fallback}", { A: "set" })).toBe("set");
    expect(services.interpolate("${A}", {})).toBe("");
    expect(services.interpolate("${A:?required}", { A: "set" })).toBe("set");
  });

  it("treats an empty value as unset, the way Compose does", () => {
    expect(services.interpolate("${A:-fallback}", { A: "" })).toBe("fallback");
  });
});

describe("portsAreConfigurable", () => {
  it("says yes for the compose file this CLI ships", () => {
    expect(services.portsAreConfigurable(COMPOSE)).toBe(true);
  });

  it("says no for a release that hardcodes the ports", () => {
    // The trap this exists for. The compose file comes from the Firetower
    // release, not from this CLI, so one published before HTTP_PORT existed
    // still says "80:80" — and offering the choice against it would write a
    // value into `.env` that nothing reads, then fail on the very conflict the
    // question was asked to avoid.
    const older = COMPOSE.replace('"${HTTP_PORT:-80}:80"', '"80:80"').replace(
      '"${HTTPS_PORT:-443}:443"',
      '"443:443"',
    );

    expect(services.portsAreConfigurable(older)).toBe(false);
  });

  it("wants the variable in the proxy's own ports, not merely in the file", () => {
    // A mention in a comment, or on another service, publishes nothing.
    const mentioned = COMPOSE.replace(
      '"${HTTP_PORT:-80}:80"',
      '"80:80"  # HTTP_PORT is not read here',
    );

    expect(services.portsAreConfigurable(mentioned)).toBe(false);
  });

  it("says no rather than throwing on a file it cannot read", () => {
    expect(services.portsAreConfigurable("this: is: not: yaml:")).toBe(false);
    expect(services.portsAreConfigurable("")).toBe(false);
  });
});
