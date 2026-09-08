import { statfs } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { resolve4, resolve6 } from "node:dns/promises";
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
  async run({ httpPort = 80, httpsPort = 443, heldPorts }) {
    const wanted = [...new Set([httpPort, httpsPort])];
    const name = `ports ${wanted.join(", ")}`;

    const busy: number[] = [];
    for (const port of wanted) {
      // A port this deployment already publishes is one it is about to release,
      // so it is not a conflict. Without this an upgrade reports its own
      // control plane as the thing in the way.
      if (heldPorts?.has(port)) continue;
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
 * Every address this machine answers on, from its own interfaces.
 *
 * Loopback and the rest of the internal ones are left out: a domain pointing at
 * 127.0.0.1 resolves to *the browser's* machine, not this one, so it is not
 * evidence that this deployment is reachable. It is called out separately
 * below, because it is a specific mistake with a specific remedy.
 */
export function localAddresses(): string[] {
  const found = new Set<string>();

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!address.internal) found.add(address.address);
    }
  }

  return [...found];
}

const isLoopbackAddress = (address: string): boolean =>
  address === "::1" || address.startsWith("127.");

/** A and AAAA together — either is a way to point a name at this machine. */
async function addressesOf(domain: string): Promise<string[]> {
  const [a, aaaa] = await Promise.all([
    resolve4(domain).catch((): string[] => []),
    resolve6(domain).catch((): string[] => []),
  ]);

  return [...a, ...aaaa];
}

/**
 * Whether the domain points here, and whether previews will resolve.
 *
 * **This used to compare against this machine's public IP and fail when they
 * differed.** That was right when Caddy answered an HTTP-01 challenge, because
 * then the name had to resolve to somewhere Let's Encrypt could reach. It is
 * wrong now, and wrong in the direction that matters: the certificate is
 * obtained over DNS-01, which needs no inbound path at all, so the address in
 * DNS should be whatever *browsers* use — and on the networks this product is
 * built for that is a private one. A tailnet address, or 10.0.0.5. As written
 * the check failed every correct install of the shape it was guarding, and told
 * the operator about an ACME rate limit that no longer applies.
 *
 * So the question is now "is this an address this machine answers on", public
 * or private, with the public-IP lookup kept only as a fallback for the machine
 * behind NAT whose interfaces show none of it.
 *
 * Nothing here fails on a mismatch any more. DNS that points somewhere else
 * does not stop the certificate being issued; it stops people reaching the
 * server, which this cannot always tell apart from a split-horizon answer, a
 * load balancer, or a name that is meant to resolve differently from here.
 *
 * The wildcard is checked too, and it is not a detail: previews are served at
 * `<session>-<port>-<signature>.DOMAIN`, so a deployment with the apex record
 * and no wildcard gets an interface that works and previews that do not
 * resolve at all.
 */
export const domainResolves: Check = {
  name: "domain",
  preflight: true,
  deployment: true,
  async run({ domain }) {
    if (!domain) return ok("domain", "none — reached on loopback");

    const addresses = await addressesOf(domain);

    if (addresses.length === 0) {
      return fail(
        "domain",
        `${domain} does not resolve`,
        "point an A record at this machine — the address browsers reach it on, which on a private network is a private one",
      );
    }

    // Probed with a label nothing could have been configured for, because that
    // is the only way to tell a wildcard from a single record that happens to
    // exist. A resolver that answers this answers every preview hostname.
    const label = `probe-${randomBytes(3).toString("hex")}`;
    const wildcard = (await addressesOf(`${label}.${domain}`)).length > 0;

    const where = await pointsHere(domain, addresses);

    if (!wildcard) {
      return warn(
        "domain",
        `${where.detail}, but *.${domain} does not resolve`,
        `previews are served on subdomains and will not resolve. Add a wildcard A record: *.${domain} → the same address.`,
      );
    }

    return where.here
      ? ok("domain", `${where.detail}, and *.${domain} resolves`)
      : warn("domain", where.detail, where.remedy);
  },
};

interface Pointing {
  here: boolean;
  detail: string;
  remedy?: string;
}

async function pointsHere(domain: string, addresses: string[]): Promise<Pointing> {
  const mine = new Set(localAddresses());
  const matched = addresses.filter((address) => mine.has(address));

  if (matched.length > 0) {
    return { here: true, detail: `${domain} → ${matched.join(", ")}, an address on this machine` };
  }

  if (addresses.every(isLoopbackAddress)) {
    return {
      here: false,
      detail: `${domain} → ${addresses.join(", ")}, which is loopback`,
      remedy:
        "that resolves to whichever machine the browser is on, not this one. Point it at an address of this machine that the people using it can reach.",
    };
  }

  // Only now, and only because the interfaces did not answer: a machine behind
  // NAT has its public address on a router rather than on itself.
  const publicIp = await publicAddress();

  if (publicIp && addresses.includes(publicIp)) {
    return {
      here: true,
      detail: `${domain} → ${publicIp}, this machine's public address`,
    };
  }

  return {
    here: false,
    detail: `${domain} → ${addresses.join(", ")}, which is not an address of this machine`,
    remedy:
      "not necessarily wrong — a load balancer, or DNS that answers differently from here, both look like this. Worth confirming a browser on your network reaches this machine at that name.",
  };
}

async function publicAddress(): Promise<string | null> {
  try {
    const response = await fetch("https://api.ipify.org", {
      signal: AbortSignal.timeout(8000),
    });
    return (await response.text()).trim();
  } catch {
    // Not knowing our own address is not the domain's fault, and with DNS-01
    // it is not needed for anything else.
    return null;
  }
}

export const machineChecks: Check[] = [
  dockerDaemon,
  composePlugin,
  ports,
  architecture,
  disk,
  registries,
  domainResolves,
];
