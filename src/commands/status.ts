import * as docker from "../docker.js";
import * as hosts from "../hosts.js";
import { compare } from "../version.js";
import { requireDeployment } from "./shared.js";
import { open as openDeployment } from "../deployment.js";
import { ui, pc } from "../ui.js";

export interface StatusOptions {
  dir?: string;
  json?: boolean;
}

export async function status(options: StatusOptions): Promise<void> {
  const dir = await requireDeployment(options.dir);
  const { services } = await openDeployment(dir);

  const [containers, version, fleet] = await Promise.all([
    docker.ps({ dir }),
    docker.deployedVersion({ dir }, services.control),
    hosts.list({ dir }, services.control),
  ]);

  if (options.json) {
    ui.json({ dir, version, containers, hosts: fleet });
    return;
  }

  ui.title("Firetower");
  ui.dim(`${version ?? "not running"}   ${dir}`);
  ui.blank();

  for (const container of containers) {
    const state = container.Health || container.State;
    const healthy = state === "healthy" || state === "running";
    if (healthy) ui.ok(container.Service, state);
    else ui.fail(`${container.Service}  ${state}`);
  }

  if (!fleet) {
    ui.blank();
    ui.dim("this deployment cannot list its fleet — upgrade for the drift report");
    ui.blank();
    return;
  }

  ui.blank();
  ui.step(pc.bold("Compute"));
  ui.blank();

  for (const host of fleet) {
    const worker = host.workerVersion ?? "?";
    const behind = version && host.workerVersion && compare(host.workerVersion, version) < 0;

    const notes = [
      host.state === "Unreachable" ? "unreachable" : null,
      host.drained ? "drained" : null,
      behind ? `behind ${version}` : null,
    ].filter(Boolean);

    const line = `${host.name.padEnd(14)}${worker.padEnd(10)}${notes.join(", ")}`;

    if (host.state === "Unreachable") ui.fail(line);
    else if (behind || host.drained) ui.warn(line);
    else ui.ok(host.name, worker);
  }

  ui.blank();
}
