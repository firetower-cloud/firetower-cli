import { statfs } from "node:fs/promises";
import { resolve4 } from "node:dns/promises";
import * as docker from "../docker.js";
import { ok, warn, fail, type Check } from "./index.js";

/** Checks about the machine, run before an install and again by `doctor`. */

export const dockerDaemon: Check = {
  name: "docker",
  preflight: true,
  deployment: true,
  async run() {
    const version = await docker.version();
    if (!version) {
      return fail("docker", "not installed", "https://docs.docker.com/engine/install/");
    }

    const reachable = await docker.daemon();
    if (!reachable.ok) {
      return fail("docker", reachable.message ?? "unreachable", reachable.remedy);
    }

    return ok("docker", version);
  },
};

export const composePlugin: Check = {
  name: "docker compose",
  preflight: true,
  deployment: true,
  async run() {
    const version = await docker.composeVersion();

    // A plain Docker install does not always have it, which is exactly the
    // case the compose file in the main repository warns about.
    return version
      ? ok("docker compose", version)
      : fail(
          "docker compose",
          "the Compose plugin is missing",
          "sudo apt install docker-compose-plugin",
        );
  },
};

/**
 * The ports being published, not a fixed pair.
 *
 * `install` asks which ones before this runs, so a machine that already has
 * something on 80 is checked against the answer rather than against the
 * default it was just moved off.
 */
export const ports: Check = {
  name: "ports",
  preflight: true,
  deployment: false,
  async run({ httpPort = 80, httpsPort = 443 }) {
    const wanted = [...new Set([httpPort, httpsPort])];
    const name = `ports ${wanted.join(", ")}`;

    const busy: number[] = [];
    for (const port of wanted) {
      if (!(await docker.portIsFree(port))) busy.push(port);
    }

    return busy.length === 0
      ? ok(name, "free")
      : fail(
          name,
          `${busy.join(" and ")} already in use`,
          "stop whatever holds them, or publish Firetower on other ports",
        );
  },
};

export const architecture: Check = {
  name: "architecture",
  preflight: true,
  deployment: false,
  async run() {
    const arch = await docker.architecture();
    if (!arch) return warn("architecture", "could not be determined");

    return ["amd64", "arm64"].includes(arch)
      ? ok("architecture", arch)
      : fail("architecture", `${arch} — the images are amd64 and arm64 only`);
  },
};

export const disk: Check = {
  name: "disk",
  preflight: true,
  deployment: true,
  async run({ dir }) {
    const stats = await statfs(dir ?? process.cwd());
    const free = (stats.bavail * stats.bsize) / 1e9;

    // The images, a database, and every repository a session clones. Two is
    // enough to start and not enough to work in.
    if (free < 2) {
      return fail("disk", `${free.toFixed(1)} GB free`, "Firetower needs a few GB to start");
    }

    return free < 10
      ? warn("disk", `${free.toFixed(1)} GB free`, "workspaces and mirrors will fill this")
      : ok("disk", `${free.toFixed(0)} GB free`);
  },
};

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(8000),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

export const registries: Check = {
  name: "ghcr.io, github",
  preflight: true,
  deployment: true,
  async run() {
    const [ghcr, github] = await Promise.all([
      reachable("https://ghcr.io/v2/"),
      reachable("https://api.github.com/"),
    ]);

    if (!ghcr) {
      return fail("ghcr.io, github", "ghcr.io is unreachable", "the images are pulled from there");
    }

    // Only a warning: the bundled compose file covers this, and an install
    // with a warm image cache should still work.
    return github
      ? ok("ghcr.io, github", "reachable")
      : warn(
          "ghcr.io, github",
          "github is unreachable",
          "the bundled deployment files will be used instead",
        );
  },
};

/**
 * Whether the domain points here.
 *
 * Worth the network call because the failure it prevents is the expensive one:
 * Caddy asks Let's Encrypt, the challenge fails because the name resolves
 * somewhere else, and the rate limit that follows is measured in days.
 *
 * That rate limit is also the whole reason the published ports are pinned to 80
 * and 443 when there is a domain — the challenge is answered on those two and
 * nowhere else. The two decisions are the same decision, so they are written
 * down together.
 *
 * A deployment behind somebody's own reverse proxy has no domain here and gets
 * no certificate from us, so there is nothing for this to protect and `install`
 * passes no domain at all.
 */
export const domainResolves: Check = {
  name: "domain",
  preflight: true,
  deployment: true,
  async run({ domain }) {
    if (!domain) return ok("domain", "none — no certificate to get");

    let addresses: string[];
    try {
      addresses = await resolve4(domain);
    } catch {
      return fail(
        "domain",
        `${domain} does not resolve`,
        "point an A record at this machine and wait for it to propagate",
      );
    }

    let publicIp: string | null = null;
    try {
      const response = await fetch("https://api.ipify.org", {
        signal: AbortSignal.timeout(8000),
      });
      publicIp = (await response.text()).trim();
    } catch {
      // Not knowing our own address is not the domain's fault.
      return warn("domain", `${domain} → ${addresses.join(", ")}`, "could not confirm it is us");
    }

    return addresses.includes(publicIp)
      ? ok("domain", `resolves to ${publicIp}, which is this machine`)
      : fail(
          "domain",
          `${domain} resolves to ${addresses.join(", ")}, not ${publicIp}`,
          "Caddy will fail the ACME challenge, and the rate limit lasts days",
        );
  },
};

export const machineChecks: Check[] = [
  dockerDaemon,
  composePlugin,
  ports,
  architecture,
  disk,
  registries,
  domainResolves,
];
