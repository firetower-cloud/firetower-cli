import { join } from "node:path";
import { execa } from "execa";
import * as docker from "../docker.js";
import * as env from "../env.js";
import * as hosts from "../hosts.js";
import * as upstream from "../upstream.js";
import * as services from "../services.js";
import { open as openDeployment, missingVariables } from "../deployment.js";
import { compare, versionFromTag } from "../version.js";
import { ok, warn, fail, type Check } from "./index.js";

/** Checks that only mean something once there is a deployment to ask about. */

export const containers: Check = {
  name: "containers",
  preflight: false,
  deployment: true,
  async run({ dir }) {
    if (!dir) return fail("containers", "no deployment found");

    const running = await docker.ps({ dir });
    if (running.length === 0) {
      return fail("containers", "nothing is running", "firetower start");
    }

    const unhealthy = running.filter(
      (c) => c.State !== "running" || (c.Health && c.Health !== "healthy"),
    );

    return unhealthy.length === 0
      ? ok("containers", `${running.length} running, all healthy`)
      : fail(
          "containers",
          unhealthy.map((c) => `${c.Service} is ${c.Health || c.State}`).join(", "),
          "firetower logs",
        );
  },
};

/**
 * That `.env` still says what it has to.
 *
 * The root key is the one worth checking character by character: a value that
 * is not 32 bytes of base64 is refused at start-up rather than used, so a
 * deployment that will not come back after a restart can be spotted while it is
 * still running.
 */
export const environment: Check = {
  name: ".env",
  preflight: false,
  deployment: true,
  async run({ dir }) {
    if (!dir) return fail(".env", "no deployment found");

    const values = await env.read(join(dir, ".env"));
    if (!values) return fail(".env", "missing", "the deployment cannot start without it");

    if (!values.POSTGRES_PASSWORD) {
      return fail(".env", "POSTGRES_PASSWORD is empty", "Compose will refuse to start");
    }

    const key = values.FIRETOWER_ROOT_KEY;
    if (key && !env.looksLikeARootKey(key)) {
      return fail(
        ".env",
        "FIRETOWER_ROOT_KEY is not 32 bytes of base64",
        "it is refused at start-up — restore the one this deployment was created with",
      );
    }

    if (values.ADMIN_INITIAL_PASSWORD) {
      return warn(
        ".env",
        "ADMIN_INITIAL_PASSWORD is still set",
        "delete it once the password has been replaced — it is plaintext here",
      );
    }

    // A release can add a variable Compose refuses to start without. Better
    // found here than at the next restart.
    const { compose } = await openDeployment(dir);
    const missing = missingVariables(compose, values);
    if (missing.length > 0) {
      return fail(
        ".env",
        `${missing.join(", ")} missing, and the compose file requires ${missing.length === 1 ? "it" : "them"}`,
        "upgrade the CLI: npm i -g @firetower/cli@latest",
      );
    }

    return ok(".env", key ? "complete" : "complete, root key on the volume");
  },
};

/**
 * A trusted header without a list of addresses to believe it from means anyone
 * who can reach Firetower can be anyone. The server refuses to start in that
 * state, so finding it here means it has not been restarted since.
 */
export const trustedProxy: Check = {
  name: "trusted proxy",
  preflight: false,
  deployment: true,
  async run({ dir }) {
    if (!dir) return fail("trusted proxy", "no deployment found");

    const values = (await env.read(join(dir, ".env"))) ?? {};
    const header = values.FIRETOWER_TRUSTED_PROXY_HEADER;
    const upstreams = values.FIRETOWER_TRUSTED_PROXY;

    if (!header && !upstreams) return ok("trusted proxy", "not configured");

    if (header && !upstreams) {
      return fail(
        "trusted proxy",
        "a header is trusted from anywhere",
        "set FIRETOWER_TRUSTED_PROXY — Firetower will not start until you do",
      );
    }

    if (!header && upstreams) {
      return warn("trusted proxy", "addresses are listed but no header is named");
    }

    return ok("trusted proxy", header);
  },
};

export const workerDrift: Check = {
  name: "workers",
  preflight: false,
  deployment: true,
  async run({ dir }) {
    if (!dir) return fail("workers", "no deployment found");

    const { services } = await openDeployment(dir);
    const deployed = await docker.deployedVersion({ dir }, services.control);
    const fleet = await hosts.list({ dir }, services.control);

    if (!fleet) {
      return warn(
        "workers",
        "this deployment cannot report its fleet",
        "upgrade Firetower to get the drift report",
      );
    }

    const unreachable = fleet.filter((h) => h.state === "Unreachable");
    const behind = deployed
      ? fleet.filter((h) => h.workerVersion && compare(h.workerVersion, deployed) < 0)
      : [];

    if (unreachable.length > 0) {
      return warn(
        "workers",
        `${unreachable.length} unreachable: ${unreachable.map((h) => h.name).join(", ")}`,
        "their sessions stay visible; Firetower keeps trying",
      );
    }

    return behind.length === 0
      ? ok("workers", `${fleet.length} host${fleet.length === 1 ? "" : "s"}, all current`)
      : warn(
          "workers",
          `${behind.length} behind ${deployed}: ${behind.map((h) => h.name).join(", ")}`,
          "firetower worker upgrade, on each machine",
        );
  },
};

export const upToDate: Check = {
  name: "version",
  preflight: false,
  deployment: true,
  async run({ dir }) {
    if (!dir) return fail("version", "no deployment found");

    const { services } = await openDeployment(dir);
    const deployed = await docker.deployedVersion({ dir }, services.control);
    if (!deployed) return warn("version", "the control plane did not answer");

    const { tag } = await upstream.deployment();
    if (!tag) return ok("version", deployed);

    const latest = versionFromTag(tag);
    if (!latest) return ok("version", deployed);

    return compare(deployed, latest) < 0
      ? warn("version", `${deployed}, and ${latest} is out`, "firetower upgrade")
      : ok("version", deployed);
  },
};

/**
 * Whether the control plane is on the network.
 *
 * The most expensive mistake this product can make. The control plane holds
 * every git token, every agent credential and the root key, so anything that
 * can reach it can erase the codebase of whoever installed it — and a host
 * firewall does not close a published port, because Docker's DNAT rules are
 * consulted before the host's INPUT chain.
 *
 * Two ways to end up here. A deployment older than `HTTP_BIND` publishes on
 * every interface and cannot be told not to; a newer one had the value edited.
 * They need different remedies, so they are told apart.
 */
export const exposure: Check = {
  name: "exposure",
  preflight: false,
  deployment: true,
  async run({ dir }) {
    if (!dir) return fail("exposure", "no deployment found");

    const deployment = await openDeployment(dir);
    const bind = deployment.env.HTTP_BIND;

    if (!services.bindIsConfigurable(deployment.compose)) {
      return warn(
        "exposure",
        "this release publishes the control plane on every interface",
        "firetower upgrade — this compose file has no HTTP_BIND to set",
      );
    }

    // Unset is the compose file's own default, which is loopback.
    if (bind === undefined || bind === "" || isLoopback(bind)) {
      return ok("exposure", `control plane on ${bind || "127.0.0.1"}`);
    }

    return fail(
      "exposure",
      `the control plane is published on ${bind}`,
      "set HTTP_BIND=127.0.0.1 in .env and restart. Reach it with `firetower tunnel`, or put a certificate in front with the tls profile.",
    );
  },
};

const isLoopback = (bind: string): boolean =>
  bind === "127.0.0.1" || bind === "::1" || bind.startsWith("127.");

/**
 * How long the certificate has left, and **who is going to do something about
 * it** — which is now two different answers.
 *
 * With a DNS provider configured, Caddy obtained the certificate over DNS-01
 * and renews it unattended at about two-thirds of its life. There is nothing
 * for the operator to do, so saying "nothing renews this for you" would be
 * false, and saying it three weeks out would be false and alarming. What is
 * still worth reporting is the date: a renewal can fail — a rotated API token,
 * a zone moved to another provider — and the expiry is where that first shows.
 *
 * With `DNS_PROVIDER=none` the old reading holds exactly: the certificate came
 * from the operator, nothing here renews it, and three weeks is enough notice
 * to mint another without hurrying.
 *
 * The certificate Caddy obtains is not on disk anywhere this can read — it is
 * in the `caddy_data` volume, not `certs/` — so the two paths do not even look
 * in the same place.
 */
export const certificateExpiry: Check = {
  name: "certificate",
  preflight: false,
  deployment: true,
  async run({ dir }) {
    if (!dir) return fail("certificate", "no deployment found");

    const deployment = await openDeployment(dir);

    // No proxy means no certificate to have an opinion about: the control
    // plane is on loopback and reached through a tunnel.
    if (!deployment.env.DOMAIN) return ok("certificate", "none — reached on loopback");

    const provider = (deployment.env.DNS_PROVIDER ?? "").trim();
    if (provider && provider !== "none") return await issuedByCaddy(dir, deployment, provider);

    const path = join(dir, "certs", "fullchain.pem");
    const notAfter = await expiryOf(path);

    if (notAfter === null) {
      return fail(
        "certificate",
        `cannot read ${path}`,
        "the tls profile needs certs/fullchain.pem and certs/privkey.pem — see the Caddyfile",
      );
    }

    const days = Math.floor((notAfter.getTime() - Date.now()) / 86_400_000);
    const when = notAfter.toISOString().slice(0, 10);

    if (days < 0) return fail("certificate", `expired on ${when}`, "replace it and restart caddy");
    if (days < 21) {
      return warn(
        "certificate",
        `${days} day${days === 1 ? "" : "s"} left, expires ${when}`,
        "you supply this one, and nothing renews it — mint a new one and copy it into certs/, or set DNS_PROVIDER in .env and let Caddy obtain it",
      );
    }

    return ok("certificate", `${days} days left, expires ${when}`);
  },
};

/**
 * The `notAfter` date, read with whatever openssl is on the machine.
 *
 * Parsing X.509 by hand to avoid a dependency would be a poor trade for a
 * date, and openssl is on every machine that is already running Docker.
 * `null` covers both "no file" and "no openssl" — neither is a certificate
 * this can vouch for, and the remedy is the same either way.
 */
/**
 * The expiry of a certificate Caddy is managing, read from Caddy rather than
 * from disk.
 *
 * `certs/` is empty in this shape, so the file this check used to read does not
 * exist and its absence means nothing. The certificate lives in the
 * `caddy_data` volume under a path that includes the issuer and the account, so
 * it is found rather than constructed.
 *
 * Unreadable is `ok`, not a failure: a proxy that is not running, or a Caddy
 * without the shell to look, is not evidence of an expiring certificate — and
 * `containers` is the check that reports a proxy that is down.
 */
async function issuedByCaddy(
  dir: string,
  deployment: Awaited<ReturnType<typeof openDeployment>>,
  provider: string,
): Promise<Awaited<ReturnType<Check["run"]>>> {
  const proxy = deployment.services.proxy;
  const renewer = `Caddy renews it, over DNS-01 through ${provider}`;

  if (!proxy) return ok("certificate", renewer);

  // Caddy's own layout: /data/caddy/certificates/<issuer>/<subject>/<subject>.crt.
  // Bounded rather than unbounded because this is read into memory, and a
  // `cat` of something unexpected should not be.
  const found = await docker.compose(
    { dir },
    "exec",
    "-T",
    proxy,
    "sh",
    "-c",
    "cat /data/caddy/certificates/*/*/*.crt 2>/dev/null | head -c 200000",
  );

  const bundle = String(found.stdout ?? "").trim();
  if (found.exitCode !== 0 || !bundle.includes("BEGIN CERTIFICATE")) {
    // Nothing issued yet is the normal state for the first minutes of a new
    // deployment, and `firetower logs caddy` is where an issuance that keeps
    // failing actually says why.
    return ok("certificate", `${renewer} — none issued yet`);
  }

  // **The earliest of them, not the first.** There are normally two here —
  // Caddy orders the bare name and the wildcard separately — and they do not
  // expire together. Reporting whichever the shell glob happened to list first
  // would be a date that is right half the time, and silent about the one that
  // is actually about to lapse.
  const notAfter = await earliestExpiry(bundle);
  if (notAfter === null) return ok("certificate", renewer);

  const days = Math.floor((notAfter.getTime() - Date.now()) / 86_400_000);
  const when = notAfter.toISOString().slice(0, 10);

  if (days < 0) {
    return fail(
      "certificate",
      `expired on ${when}, and Caddy has not replaced it`,
      "firetower logs caddy — renewal has been failing, usually a DNS_API_TOKEN that no longer works",
    );
  }

  // Well inside what Caddy renews at, so reaching this is a renewal that is
  // not happening rather than a certificate that is merely getting on.
  if (days < 14) {
    return warn(
      "certificate",
      `${days} day${days === 1 ? "" : "s"} left, expires ${when}`,
      "Caddy renews at about a third of the life remaining, so this is late — check `firetower logs caddy`",
    );
  }

  return ok("certificate", `${days} days left, expires ${when} — ${renewer}`);
}

/** Every PEM certificate in a concatenated bundle. */
function certificatesIn(bundle: string): string[] {
  return [...bundle.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)].map(
    (match) => match[0],
  );
}

async function earliestExpiry(bundle: string): Promise<Date | null> {
  const dates: Date[] = [];

  for (const pem of certificatesIn(bundle)) {
    const result = await execa("openssl", ["x509", "-enddate", "-noout"], {
      input: pem,
      reject: false,
    });
    if (result.exitCode !== 0) continue;

    const parsed = parseNotAfter(String(result.stdout));
    if (parsed) dates.push(parsed);
  }

  if (dates.length === 0) return null;

  return dates.reduce((earliest, date) => (date < earliest ? date : earliest));
}

async function expiryOf(path: string): Promise<Date | null> {
  const result = await execa("openssl", ["x509", "-enddate", "-noout", "-in", path], {
    reject: false,
  });
  if (result.exitCode !== 0) return null;

  return parseNotAfter(String(result.stdout));
}

function parseNotAfter(output: string): Date | null {
  const match = /notAfter=(.+)/.exec(output.trim());
  if (!match?.[1]) return null;

  const parsed = new Date(match[1]);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export const deploymentChecks: Check[] = [
  containers,
  environment,
  exposure,
  certificateExpiry,
  trustedProxy,
  upToDate,
  workerDrift,
];
