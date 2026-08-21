import { join } from "node:path";
import * as docker from "../docker.js";
import * as env from "../env.js";
import * as hosts from "../hosts.js";
import * as upstream from "../upstream.js";
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

    const deployed = await docker.deployedVersion({ dir });
    const fleet = await hosts.list({ dir });

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

    const deployed = await docker.deployedVersion({ dir });
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

export const deploymentChecks: Check[] = [
  containers,
  environment,
  trustedProxy,
  upToDate,
  workerDrift,
];
