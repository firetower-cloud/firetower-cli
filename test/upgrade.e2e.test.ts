import { describe, it, expect, afterAll } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as docker from "../src/docker.js";
import * as env from "../src/env.js";
import * as upstream from "../src/upstream.js";

/**
 * Upgrading across a release that changed what a variable means.
 *
 * The reported failure, end to end. A deployment installed when `HTTP_PORT`
 * was Caddy's host port is upgraded to a release where the same name is the
 * control plane's, and where Caddy has moved behind the `tls` profile. Before
 * this was fixed, both halves went wrong at once and the second hid the first:
 *
 *   * `.env` still said `HTTP_PORT=80`, so the control plane — which had never
 *     published a port before — tried to bind 127.0.0.1:80;
 *   * the old Caddy was still up holding 80, because Compose does not stop a
 *     service that moved behind a profile, and does not mention it either.
 *
 * The result was `failed to bind port 127.0.0.1:80/tcp: address already in
 * use`, from a container the operator had just replaced.
 */

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");

/**
 * A project of its own, and this is not tidiness.
 *
 * `deploy/firetower.yml` pins `name: firetower` precisely so that every
 * installation shares one namespace for its containers, network and volumes.
 * A test that installs that file inherits the pin — so on a machine that also
 * *runs* Firetower, the teardown below would take the real deployment's
 * database volume with it. COMPOSE_PROJECT_NAME outranks the file's own name.
 */
/**
 * Set per test, not once for the file. Each case brings up a stack of its own,
 * and one project name across both would have the second one adopting the
 * first's containers and volumes — which is the same namespace collision this
 * constant exists to prevent, moved inside the file.
 */
function isolate(name: string): string {
  process.env.COMPOSE_PROJECT_NAME = name;
  return name;
}

const cli = (...args: string[]): string[] => [CLI, "--skip-version-check", ...args];

/**
 * Ports nothing else on a developer's machine is likely to want.
 *
 * High on purpose. The release being upgraded *from* publishes Caddy on
 * HTTP_PORT and HTTPS_PORT directly, and a test that reproduced the report
 * literally would ask for 80 and 443 — which fails on any machine already
 * running something, including the one the report came from.
 */
const WAS = { http: 9380, https: 9443 };

/**
 * The compose file as it was before the change, trimmed to what this asserts.
 *
 * Written here rather than fetched at a tag: the shape is the fixture, and it
 * should not stop being a regression test the day that tag is unreachable.
 * The two things that matter are both in it — Caddy is unconditional and owns
 * `HTTP_PORT`, and the control plane publishes nothing at all.
 */
const PREVIOUS = `
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "\${HTTP_PORT:-80}:80"
      - "\${HTTPS_PORT:-443}:443"

  firetower:
    image: ghcr.io/firetower-cloud/firetower:latest
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://firetower:\${POSTGRES_PASSWORD}@postgres:5432/firetower
      ADMIN_USERNAME: \${ADMIN_USERNAME:-admin}
      ADMIN_INITIAL_PASSWORD: \${ADMIN_INITIAL_PASSWORD:-}
      FIRETOWER_ROOT_KEY: \${FIRETOWER_ROOT_KEY:-}
      FIRETOWER_PUBLIC_URL: \${FIRETOWER_PUBLIC_URL:-http://localhost}
    volumes:
      - firetower:/var/lib/firetower

  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: firetower
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: firetower
    volumes:
      - postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U firetower -d firetower"]
      interval: 2s
      timeout: 3s
      retries: 30

volumes:
  postgres:
  firetower:
  caddy_data:
  caddy_config:
`;

const stacks: { dir: string; project: string }[] = [];

afterAll(async () => {
  for (const { dir, project } of stacks) {
    // The project each stack was created under, restored before taking it
    // down — otherwise the last test's name is the one in the environment and
    // the earlier stacks are never found, let alone removed.
    process.env.COMPOSE_PROJECT_NAME = project;

    await docker.compose({ dir, profiles: ["tls"] }, "down", "-v", "--remove-orphans");
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * The state a failed upgrade leaves behind: compose migrated, `.env` not.
 *
 * This is what actually reached the operator. The first upgrade replaced
 * `firetower.yml` and then died binding the port; the second ran the fix and
 * failed the same way, because comparing the compose file before and after
 * found the *new* file on both sides — they agreed, and the stale `HTTP_PORT`
 * was kept as though it had been chosen on purpose.
 *
 * A `.env` with no `HTTP_BIND` against a compose file that reads one is the
 * tell, and it needs no history to see.
 */
describe("upgrade, resumed after a failed one", () => {
  it("does not trust a .env the compose file has already moved past", async () => {
    const project = isolate("firetower-resume-e2e");
    const resumed = await mkdtemp(join(tmpdir(), "firetower-resume-e2e-"));
    stacks.push({ dir: resumed, project });

    const rootKey = env.generateRootKey();

    // The compose file of the release being moved to, already on disk.
    const files = await upstream.deployment();
    await writeFile(join(resumed, "firetower.yml"), files.compose);

    // The `.env` of the release being moved from, never rewritten. No
    // HTTP_BIND, because the release that wrote it had no such variable.
    await env.write(join(resumed, ".env"), {
      DOMAIN: "",
      HTTP_PORT: "80",
      HTTPS_PORT: "443",
      FIRETOWER_PUBLIC_URL: "http://localhost",
      POSTGRES_PASSWORD: env.generatePassword(),
      FIRETOWER_ROOT_KEY: rootKey,
      ADMIN_USERNAME: "admin",
    });

    const upgraded = await execa(
      "node",
      cli("--dir", resumed, "--yes", "upgrade", "--no-backup"),
      { reject: false, stdio: "inherit" },
    );
    expect(upgraded.exitCode).toBe(0);

    const after = await env.read(join(resumed, ".env"));

    // **The bug.** 80 described Caddy's front door on the release this `.env`
    // came from, and describes the vault's published port on this one.
    expect(after?.HTTP_PORT).not.toBe("80");
    expect(after?.HTTP_BIND).toBe("127.0.0.1");
    expect(after?.FIRETOWER_PUBLIC_URL).toBe(`http://localhost:${after?.HTTP_PORT}`);
    expect(after?.FIRETOWER_ROOT_KEY).toBe(rootKey);

    const response = await fetch(`http://127.0.0.1:${after?.HTTP_PORT}`, {
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).toBeLessThan(500);
  });
});

describe("upgrade", () => {
  it("re-derives a deployment whose variables changed meaning under it", async () => {
    const project = isolate("firetower-upgrade-e2e");
    const dir = await mkdtemp(join(tmpdir(), "firetower-upgrade-e2e-"));
    stacks.push({ dir, project });

    const rootKey = env.generateRootKey();
    const password = env.generatePassword();

    await writeFile(join(dir, "firetower.yml"), PREVIOUS);
    await env.write(join(dir, ".env"), {
      DOMAIN: "",
      // Caddy's, on the release being left. This is the value that stops
      // meaning what it says.
      HTTP_PORT: String(WAS.http),
      HTTPS_PORT: String(WAS.https),
      FIRETOWER_PUBLIC_URL: `http://localhost:${WAS.http}`,
      POSTGRES_PASSWORD: password,
      FIRETOWER_ROOT_KEY: rootKey,
      ADMIN_USERNAME: "admin",
      ADMIN_INITIAL_PASSWORD: "not-a-real-password",
      // Owned by nobody here. It has to come out the other side untouched.
      FIRETOWER_TRUSTED_PROXY: "10.0.0.0/8",
    });

    // The deployment as it was, running, with Caddy holding the ports.
    await docker.composeOrThrow({ dir, stream: true }, "up", "-d");

    const wasHolding = await docker.projectContainers({ dir });
    expect(wasHolding.map((c) => c.service)).toContain("caddy");
    expect(wasHolding.flatMap((c) => c.ports)).toContain(WAS.http);

    const upgraded = await execa("node", cli("--dir", dir, "--yes", "upgrade", "--no-backup"), {
      reject: false,
      stdio: "inherit",
    });
    expect(upgraded.exitCode).toBe(0);

    const after = await env.read(join(dir, ".env"));

    // **The regression.** The old value described Caddy; the new one describes
    // the control plane, and 80 was never a port this shape should publish.
    expect(after?.HTTP_PORT).not.toBe(String(WAS.http));
    expect(after?.HTTP_BIND).toBe("127.0.0.1");

    // Caddy is not created without the tls profile, so a port for it is a
    // value nothing reads — dropped rather than carried.
    expect(after?.HTTPS_PORT).toBeUndefined();

    // The address printed at the end has to be the address that answers.
    expect(after?.FIRETOWER_PUBLIC_URL).toBe(`http://localhost:${after?.HTTP_PORT}`);

    // Nothing sealed moved. An upgrade that rotated either of these would
    // succeed and leave every stored credential unreadable.
    expect(after?.FIRETOWER_ROOT_KEY).toBe(rootKey);
    expect(after?.POSTGRES_PASSWORD).toBe(password);

    // Nor is a key this CLI does not own quietly dropped.
    expect(after?.FIRETOWER_TRUSTED_PROXY).toBe("10.0.0.0/8");

    // The file it replaced is still there to read.
    await expect(access(join(dir, ".env.backup"))).resolves.toBeUndefined();
    expect(await readFile(join(dir, ".env.backup"), "utf8")).toContain(
      `HTTP_PORT=${WAS.http}`,
    );

    // The compose file is the one the release publishes.
    const compose = await readFile(join(dir, "firetower.yml"), "utf8");
    expect(compose).toContain("${HTTP_PORT");
    expect(compose).toContain("profiles");

    // **The other half.** The Caddy from the release being left is gone,
    // rather than left running and holding a port nothing asked it to hold.
    const now = await docker.projectContainers({ dir });
    expect(now.map((container) => container.service)).not.toContain("caddy");
    expect(now.map((container) => container.service)).toContain("firetower");

    // And it is published where `.env` says, on loopback and nowhere else.
    const control = now.find((container) => container.service === "firetower");
    expect(control?.ports).toEqual([Number(after?.HTTP_PORT)]);

    // Asked of the host rather than of Compose: `waitForHealthy` passes for a
    // control plane that is perfectly well on a port nobody was told about.
    const response = await fetch(`http://127.0.0.1:${after?.HTTP_PORT}`, {
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).toBeLessThan(500);
  });
});
