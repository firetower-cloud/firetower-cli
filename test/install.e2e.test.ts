import { describe, it, expect, afterAll } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as env from "../src/env.js";
import * as services from "../src/services.js";

/**
 * The install path, against a real Docker daemon.
 *
 * This is the test that would have caught the mistake the whole of `env.ts`
 * exists to prevent: a second `install` in a directory that already has one
 * must not write a new root key over the old one. Everything sealed with the
 * first key would still be in the database, and unreadable, and nothing would
 * say so until the next clone.
 */

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
let dir: string;

afterAll(async () => {
  if (!dir) return;

  await execa("docker", ["compose", "-f", "firetower.yml", "down", "-v"], {
    cwd: dir,
    reject: false,
  });
  await rm(dir, { recursive: true, force: true });
});

describe("install", () => {
  it("brings up a working deployment and keeps its secrets on a re-run", async () => {
    dir = await mkdtemp(join(tmpdir(), "firetower-e2e-"));

    const first = await execa("node", [CLI, "--dir", dir, "--yes", "install"], {
      reject: false,
      stdio: "inherit",
    });
    expect(first.exitCode).toBe(0);

    const before = await env.read(join(dir, ".env"));
    expect(before?.FIRETOWER_ROOT_KEY).toBeTruthy();
    expect(env.looksLikeARootKey(before!.FIRETOWER_ROOT_KEY!)).toBe(true);

    // `.env` holds every secret this deployment has. Nobody else on the
    // machine gets to read it.
    const { stdout: mode } = await execa("stat", ["-c", "%a", join(dir, ".env")], {
      reject: false,
    });
    if (mode) expect(String(mode).trim()).toBe("600");

    const doctor = await execa("node", [CLI, "--dir", dir, "doctor"], { reject: false });
    expect(doctor.exitCode).toBe(0);

    // The whole point of this file.
    const second = await execa("node", [CLI, "--dir", dir, "--yes", "install"], {
      reject: false,
    });

    const after = await env.read(join(dir, ".env"));
    expect(after?.FIRETOWER_ROOT_KEY).toBe(before?.FIRETOWER_ROOT_KEY);
    expect(after?.POSTGRES_PASSWORD).toBe(before?.POSTGRES_PASSWORD);
    expect(second.exitCode).not.toBe(0); // it should refuse, not proceed

    // And the compose file it wrote is the one the release publishes.
    const compose = await readFile(join(dir, "firetower.yml"), "utf8");
    expect(compose).toContain("ghcr.io/firetower-cloud/firetower");

    // The ports are written exactly when the release can honour them, and
    // never otherwise. A `.env` naming a port the compose file does not read
    // is worse than one that stays quiet: it tells the operator they changed
    // something that never moved.
    if (services.portsAreConfigurable(compose)) {
      expect(after?.HTTP_PORT).toBe("8080");
    } else {
      expect(after?.HTTP_PORT).toBeUndefined();
    }

    // HTTPS is Caddy's, and this shape has no Caddy.
    expect(after?.HTTPS_PORT).toBeUndefined();

    // Whatever the ports are, the URL that was printed agrees with them.
    expect(after?.FIRETOWER_PUBLIC_URL).toBe("http://localhost:8080");

    // Everything below asks the daemon what exists, rather than asking the
    // compose file what it meant to do. The compose file is the thing under
    // test.
    const running = await containers(dir);

    // No proxy was created. It is behind the `tls` profile, and this shape has
    // no certificate to terminate — the control plane serves its own
    // interface, API and preview routing, so a proxy here would be a
    // pass-through in front of a server that is already whole.
    //
    // Asked of the containers and not of `ps --services`, which lists what the
    // compose file *defines* — profiles and all — and so says "caddy" whether
    // or not one was ever created.
    const names = running.map((container) => container.Service);

    // The two positives are not decoration: they fail loudly if this ever
    // reads an empty list or an output shape without `Service`, which is the
    // way a `not.toContain` quietly stops testing anything.
    expect(names).toContain("firetower");
    expect(names).toContain("postgres");
    expect(names).not.toContain("caddy");

    // **The assertion this file exists for.** Not what was written to `.env` —
    // what Docker actually published. The bug this catches is an install that
    // answers "only from this machine" and then puts the control plane, which
    // holds every credential Firetower has, on the machine's public address. A
    // host firewall would not have saved it either: Docker's DNAT rules are
    // consulted before the host's INPUT chain.
    if (services.bindIsConfigurable(compose)) {
      expect(after?.HTTP_BIND).toBe("127.0.0.1");

      const published = running
        .flatMap((container) => container.Publishers ?? [])
        .filter((publisher) => publisher.URL);

      // There has to be one, or the loop below proves nothing. The control
      // plane publishes exactly one port and Postgres publishes none.
      expect(published.length).toBeGreaterThan(0);

      for (const publisher of published) {
        expect(publisher.URL).toBe("127.0.0.1");
      }
    }
  });
});

interface ComposeContainer {
  Service?: string;
  Publishers?: { URL?: string }[];
}

/**
 * The containers this deployment actually has.
 *
 * Compose has emitted this two ways depending on the version — one JSON object
 * per line, or a single JSON array — and getting it wrong is worse than
 * noisy: an unparsed array yields no rows, and every assertion above it passes
 * by finding nothing. So both are accepted, and the caller checks it found
 * something.
 */
async function containers(dir: string): Promise<ComposeContainer[]> {
  const { stdout } = await execa(
    "docker",
    ["compose", "-f", "firetower.yml", "ps", "--format", "json"],
    { cwd: dir, reject: false },
  );

  const text = String(stdout).trim();
  if (!text) return [];

  if (text.startsWith("[")) return JSON.parse(text) as ComposeContainer[];

  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ComposeContainer);
}
