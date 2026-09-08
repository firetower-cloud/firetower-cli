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
 * What an address on this machine is *for*, which is the only thing that makes
 * one of them a better answer than another.
 *
 *   * `mesh` — a tailnet or a VPN tunnel. The address other people's laptops
 *     can reach without anything being published to the internet, which is the
 *     whole shape the `domain` deployment is for.
 *   * `private` — an ordinary RFC1918 address. Right for a machine on the
 *     network its users are on, and wrong for a cloud VM whose VPC nobody is
 *     peered into. Those two are indistinguishable from here.
 *   * `public` — routable from the internet. Never the recommended answer.
 */
export type AddressKind = "mesh" | "private" | "public";

export interface Candidate {
  address: string;
  /** The interface it is on, which is what makes it recognisable to a human. */
  iface: string;
  kind: AddressKind;
}

/**
 * Interfaces that belong to something other than a network people are on.
 *
 * Docker's bridges are the ones that matter. Node marks only loopback as
 * `internal`, so `docker0` and every Compose bridge come back from
 * `networkInterfaces()` looking exactly like a NIC — and this deployment
 * creates several of them. Offering `172.17.0.1` as the address to point a
 * domain at is offering an address that is unreachable from anywhere,
 * including from the container that would be answering on it.
 */
const NOT_A_NETWORK = /^(docker|br-|veth|virbr|lo|cni|flannel|kube)/;

/** Interfaces that are a tunnel into a network somebody else is also on. */
const MESH_INTERFACE = /^(tailscale|wg|wt|nebula|zt|tun|utun)/;

/**
 * Tailscale's range. `100.64.0.0/10` is carrier-grade NAT space, which
 * Tailscale uses for every node — a stronger signal than an interface name,
 * because the name is `tailscale0` on Linux and `utun` plus a number on macOS,
 * where it is indistinguishable from any other tunnel.
 */
function octets(address: string): [number, number] {
  const [a = -1, b = -1] = address.split(".").map(Number);
  return [a, b];
}

function isCgnat(address: string): boolean {
  const [a, b] = octets(address);
  return a === 100 && b >= 64 && b <= 127;
}

function isPrivate(address: string): boolean {
  const [a, b] = octets(address);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * Every address this machine answers on that somebody could plausibly reach,
 * with what each one is.
 *
 * Loopback is left out: a domain pointing at 127.0.0.1 resolves to *the
 * browser's* machine, not this one, so it is not evidence that this deployment
 * is reachable. Link-local is left out for the same reason. Docker's bridges
 * are left out because they are not a network at all — see `NOT_A_NETWORK`.
 *
 * The classification orders a list and pre-selects an entry. It never decides:
 * a WireGuard interface somebody named `corp0` is a perfectly good mesh that no
 * pattern here will recognise, and the cost of that has to be an arrow key
 * rather than a refusal.
 */
export function candidateAddresses(): Candidate[] {
  const found: Candidate[] = [];
  const seen = new Set<string>();

  for (const [iface, addresses] of Object.entries(networkInterfaces())) {
    if (NOT_A_NETWORK.test(iface)) continue;

    for (const entry of addresses ?? []) {
      const { address } = entry;
      if (entry.internal) continue;
      // IPv4 only. An AAAA record is a fine way to reach a machine, but the
      // records this prints are A records and mixing the two in one list is a
      // way to have somebody paste a v6 address into an A record.
      if (!address.includes(".")) continue;
      if (address.startsWith("169.254.")) continue;
      if (seen.has(address)) continue;
      seen.add(address);

      const kind: AddressKind =
        isCgnat(address) || MESH_INTERFACE.test(iface)
          ? "mesh"
          : isPrivate(address)
            ? "private"
            : "public";

      found.push({ address, iface, kind });
    }
  }

  const rank = { mesh: 0, private: 1, public: 2 };

  return found.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

/**
 * Every address this machine answers on, as plain strings.
 *
 * Kept for `doctor`, which asks "is this an address this machine has" and does
 * not care what kind it is.
 */
export function localAddresses(): string[] {
  return candidateAddresses().map((candidate) => candidate.address);
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
  async run({ domain, httpsBind }) {
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

    const where = await pointsHere(domain, addresses, httpsBind ?? null);

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

async function pointsHere(
  domain: string,
  addresses: string[],
  httpsBind: string | null,
): Promise<Pointing> {
  // Asked first, and asked separately, because "an address on this machine" is
  // the wrong question once Caddy is held to one interface. A name resolving to
  // the VPC address beside a tailnet-bound Caddy passes that question and
  // reaches nothing.
  if (httpsBind) {
    if (addresses.includes(httpsBind)) {
      return { here: true, detail: `${domain} → ${httpsBind}, where Caddy is listening` };
    }

    return {
      here: false,
      detail: `${domain} → ${addresses.join(", ")}, but Caddy is listening on ${httpsBind}`,
      remedy: `point both records at ${httpsBind}, or change HTTPS_BIND to an address the name already resolves to`,
    };
  }

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
