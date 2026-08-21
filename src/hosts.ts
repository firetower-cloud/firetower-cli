import { compose, type ComposeOptions } from "./docker.js";

/**
 * The fleet, asked of the control plane running on this machine.
 *
 * Over `docker compose exec`, not HTTP. The CLI is on the same machine as the
 * container, inside the same trust boundary, and the alternative is holding a
 * session token in Node and keeping it alive — a credential to store, expire
 * and leak in exchange for nothing.
 *
 * `firetower hosts --json` does not exist yet. It belongs in the main
 * repository beside `passwd` and `healthcheck`, reading DATABASE_URL the same
 * way. Until a deployment has it, `list` returns null and the caller says
 * something general instead of nothing at all.
 */

export type Compute =
  | { kind: "local" }
  | { kind: "container"; image: string; name: string }
  | {
      kind: "server";
      host: string;
      user?: string;
      port?: number;
      container?: string;
    };

export interface Host {
  id: string;
  name: string;
  state: "Online" | "Unreachable";
  drained: boolean;
  workerVersion: string | null;
  compute: Compute;
}

/**
 * Ask, or return null when this deployment is too old to answer.
 *
 * Null and not an exception: a control plane that does not know the subcommand
 * is a normal thing to meet, and failing an upgrade over it would be worse than
 * the vaguer message it costs.
 */
export async function list(
  options: ComposeOptions,
  service = "firetower",
): Promise<Host[] | null> {
  const result = await compose(options, "exec", "-T", service, "firetower", "hosts", "--json");
  if (result.exitCode !== 0) return null;

  try {
    return JSON.parse(String(result.stdout)) as Host[];
  } catch {
    return null;
  }
}

/** How to reach a host over ssh, as something to paste. */
export function sshDestination(compute: Compute): string | null {
  if (compute.kind !== "server") return null;

  const destination = compute.user ? `${compute.user}@${compute.host}` : compute.host;
  return compute.port && compute.port !== 22 ? `${destination} -p ${compute.port}` : destination;
}

/** The container the worker runs in there, or the documented default. */
export function containerName(compute: Compute): string {
  if (compute.kind === "container") return compute.name;
  if (compute.kind === "server" && compute.container) return compute.container;
  return "firetower-worker";
}
