import { describe, it, expect, afterAll } from "vitest";
import { execa } from "execa";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as docker from "../src/docker.js";
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

/**
 * A project of its own, and this is not tidiness.
 *
 * `deploy/firetower.yml` pins `name: firetower` so that every installation
 * shares one namespace for its containers, network and volumes — which is
 * right for a deployment and dangerous for a test. Installing that file here
 * inherits the pin, so on a machine that also *runs* Firetower the
 * `down -v` below would remove the real deployment's database volume.
 * COMPOSE_PROJECT_NAME outranks the name in the file.
 */
process.env.COMPOSE_PROJECT_NAME = "firetower-install-e2e";

/**
 * The CLI under test, invoked without the registry check.
 *
 * `install` gates on what the current release says it needs, and rightly so:
 * an operator whose CLI predates the release it is about to write should be
 * stopped before it writes one. But the version that gate compares is the
 * *published* one, and the build under test here is by definition unpublished
 * — so a release that raises `minimumCli` blocks the very commit that would
 * satisfy it, and every e2e run until it ships.
 *
 * The flag exists for exactly this; `selfcheck.ts` calls it "for working
 * offline, and for developing this". Nothing is lost by using it, because the
 * gate is not what this file tests: `selfcheck.test.ts` covers `decide` with
 * no registry, no release and no daemon in the way.
 */
const cli = (...args: string[]): string[] => [CLI, "--skip-version-check", ...args];

let dir: string;

afterAll(async () => {
  if (!dir) return;

  await docker.compose({ dir }, "down", "-v");
  await rm(dir, { recursive: true, force: true });
});

/**
 * The shape this installs, and why it is the cheap one.
 *
 * Every install has a domain now, so every install creates Caddy — there is no
 * longer a shape with no proxy to test. `--dns-provider none` is the one that
 * costs least: the Dockerfile's build step exits early for it rather than
 * compiling Caddy from source, and nothing here waits on a certificate,
 * because the operator is the one supplying it.
 *
 * The two certificate files are written *before* `install` runs, so that
 * `requireCertificate` finds them and the run finishes rather than stopping to
 * ask for them. They are not valid and nothing here pretends otherwise: what is
 * asserted below is what Docker published, not what Caddy served.
 */
const DOMAIN = "ft.e2e.invalid";
const BIND = "127.0.0.1";

async function placeCertificates(into: string): Promise<void> {
  const certs = join(into, "certs");
  await mkdir(certs, { recursive: true });

  // A real self-signed certificate rather than a placeholder, because two of
  // `doctor`'s checks read it: one parses the expiry, and the other only
  // passes if Caddy started, which it will not do without something it can
  // parse. Written through a config file rather than `-addext`, which
  // LibreSSL — what macOS ships as `openssl` — has not always had.
  const config = join(into, "openssl.cnf");
  await writeFile(
    config,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = ext",
      "prompt = no",
      "[dn]",
      `CN = ${DOMAIN}`,
      "[ext]",
      "basicConstraints = critical,CA:FALSE",
      `subjectAltName = DNS:${DOMAIN}, DNS:*.${DOMAIN}`,
    ].join("\n"),
  );

  await execa("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "30",
    "-keyout",
    join(certs, "privkey.pem"),
    "-out",
    join(certs, "fullchain.pem"),
    "-config",
    config,
  ]);
}

/**
 * The hand-edit the bring-your-own-certificate path documents.
 *
 * `install` writes the release's Caddyfile unchanged for `DNS_PROVIDER=none`,
 * which still carries the `tls { dns … }` block — so Caddy would try to answer
 * an ACME challenge with a module that was never compiled in. The README says
 * to comment that block out and uncomment the `tls /certs/…` line; this is
 * that, done in the test, so what runs afterwards is a deployment somebody
 * could actually have.
 */
async function useSuppliedCertificate(dir: string): Promise<void> {
  const path = join(dir, "Caddyfile");
  const caddyfile = await readFile(path, "utf8");

  const replaced = caddyfile.replace(
    /\n\ttls \{[\s\S]*?\n\t\}\n/,
    "\n\ttls /certs/fullchain.pem /certs/privkey.pem\n",
  );

  // Fail loudly rather than quietly testing a deployment with no TLS at all.
  expect(replaced).not.toBe(caddyfile);
  expect(replaced).toContain("tls /certs/fullchain.pem");

  await writeFile(path, replaced);
  await docker.composeOrThrow({ dir }, "up", "-d", "--force-recreate", "caddy");
}

describe("install", () => {
  it("brings up a working deployment and keeps its secrets on a re-run", async () => {
    dir = await mkdtemp(join(tmpdir(), "firetower-e2e-"));
    await placeCertificates(dir);

    // A high HTTPS port because 443 is a poor thing to demand of whatever
    // machine this runs on. Port 80 is Caddy's redirect and is not
    // configurable; Docker publishes it as root, so it needs none here.
    const install = (...extra: string[]) =>
      cli(
        "--dir",
        dir,
        "--yes",
        "install",
        "--domain",
        DOMAIN,
        "--dns-provider",
        "none",
        "--https-bind",
        BIND,
        "--https-port",
        "9443",
        ...extra,
      );

    const first = await execa("node", install(), {
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

    await useSuppliedCertificate(dir);

    // `doctor`, and specifically *which* of its checks fail.
    //
    // A bare exit code cannot be asserted here any more: every deployment has
    // a domain now, and the one this installs is deliberately unresolvable —
    // `.invalid` is reserved by RFC 2606 precisely so that it never resolves.
    // So the DNS check fails, correctly, and it is the only thing allowed to.
    // Asserting the set rather than the code is what keeps this a test of the
    // deployment rather than of the test's own choice of domain.
    const doctor = await execa("node", cli("--dir", dir, "--json", "doctor"), { reject: false });
    const report = JSON.parse(doctor.stdout) as {
      checks: { name: string; status: string }[];
    };
    const failing = report.checks.filter((c) => c.status === "fail").map((c) => c.name);

    expect(failing).toEqual(["domain"]);

    // The one this file is really about: the control plane is not on the
    // network, and `doctor` agrees.
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "exposure", status: "ok" }),
    );

    // The whole point of this file.
    const second = await execa("node", install(), {
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

    // HTTPS is Caddy's, and every shape has a Caddy now.
    if (services.portsAreConfigurable(compose)) {
      expect(after?.HTTPS_PORT).toBe("9443");
    }

    // The bind is written, and the advertised address is not: it is only
    // written when it differs from the bind, and here it does not.
    expect(after?.HTTPS_BIND).toBe(BIND);
    expect(after?.HTTPS_ADVERTISE).toBeUndefined();
    expect(after?.DOMAIN).toBe(DOMAIN);
    expect(after?.FIRETOWER_PREVIEW_DOMAIN).toBe(DOMAIN);

    // Whatever the ports are, the URL that was printed agrees with them.
    expect(after?.FIRETOWER_PUBLIC_URL).toBe(`https://${DOMAIN}:9443`);

    // Everything below asks the daemon what exists, rather than asking the
    // compose file what it meant to do. The compose file is the thing under
    // test.
    const running = await containers(dir);

    // The proxy was created, which is what `COMPOSE_PROFILES=tls` is for and
    // what every install writes now. Its health is deliberately not asserted:
    // the certificate placed above is not a real one, and the bring-your-own
    // path also wants the Caddyfile's `tls` line uncommented by hand. What is
    // under test here is what Compose created and where Docker published it.
    //
    // Asked of the containers and not of `ps --services`, which lists what the
    // compose file *defines* — profiles and all — and so says "caddy" whether
    // or not one was ever created.
    const names = running.map((container) => container.Service);

    expect(names).toContain("firetower");
    expect(names).toContain("postgres");
    expect(names).toContain("caddy");

    // **The assertion this file exists for.** Not what was written to `.env` —
    // what Docker actually published. The bug it catches is an install that
    // puts the control plane, which holds every credential Firetower has, on
    // the machine's public address. A host firewall would not have saved it
    // either: Docker's DNAT rules are consulted before the host's INPUT chain.
    //
    // Caddy is published too now, and on purpose — it is the front door. This
    // bound it to loopback, so every publisher in this deployment should name
    // that one address, whichever container it belongs to.
    if (services.bindIsConfigurable(compose)) {
      expect(after?.HTTP_BIND).toBe("127.0.0.1");

      const published = running
        .flatMap((container) => container.Publishers ?? [])
        .filter((publisher) => publisher.URL);

      // There has to be one, or the loop below proves nothing.
      expect(published.length).toBeGreaterThan(0);

      for (const publisher of published) {
        expect(publisher.URL).toBe(BIND);
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
 * Through the CLI's own runner rather than a bare `docker compose`, for the
 * reason in `docker.ts`: Compose interpolates every service in the file before
 * it filters by profile, so the proxy's required DOMAIN refuses the command in
 * a deployment that has no proxy. What is being asserted is still the daemon's
 * answer — this only affects how the question is asked.
 *
 * Compose has emitted this two ways depending on the version — one JSON object
 * per line, or a single JSON array — and getting it wrong is worse than
 * noisy: an unparsed array yields no rows, and every assertion above it passes
 * by finding nothing. So both are accepted, and the caller checks it found
 * something.
 */
async function containers(dir: string): Promise<ComposeContainer[]> {
  const { stdout } = await docker.compose({ dir }, "ps", "--format", "json");

  const text = String(stdout).trim();
  if (!text) return [];

  if (text.startsWith("[")) return JSON.parse(text) as ComposeContainer[];

  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ComposeContainer);
}
