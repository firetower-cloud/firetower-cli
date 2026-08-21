import { machineChecks } from "../checks/machine.js";
import { deploymentChecks } from "../checks/deployment.js";
import { runChecks, worst, type Result } from "../checks/index.js";
import { findDeployment } from "../config.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as env from "../env.js";
import { ui } from "../ui.js";

export interface DoctorOptions {
  dir?: string;
  json?: boolean;
}

/**
 * Everything `install` checks about the machine, plus everything that only
 * makes sense once a deployment exists.
 *
 * Exits non-zero on any failure, so it works unattended in a cron as well as
 * in front of somebody trying to work out why nothing loads.
 */
export async function doctor(options: DoctorOptions): Promise<void> {
  const dir = await findDeployment(options.dir);

  const checks = [
    ...machineChecks.filter((c) => c.deployment),
    ...(dir ? deploymentChecks : []),
  ];

  // The domain the deployment actually uses, so the check is about this
  // installation rather than about nothing.
  let domain: string | null = null;
  if (dir) {
    try {
      domain = env.parse(await readFile(join(dir, ".env"), "utf8")).DOMAIN || null;
    } catch {
      domain = null;
    }
  }

  const results = await runChecks(checks, { dir, domain });

  if (options.json) {
    ui.json({ dir, status: worst(results), checks: results });
    process.exit(worst(results) === "fail" ? 1 : 0);
  }

  report(dir, results);
  process.exit(worst(results) === "fail" ? 1 : 0);
}

function report(dir: string | null, results: Result[]): void {
  ui.title("Firetower");

  if (!dir) {
    ui.warn("no deployment found on this machine", "checking what a new one would need");
    ui.blank();
  } else {
    ui.dim(dir);
    ui.blank();
  }

  for (const result of results) {
    const label = result.detail ? `${result.name.padEnd(20)}${result.detail}` : result.name;

    if (result.status === "ok") ui.ok(result.name, result.detail);
    else if (result.status === "warn") ui.warn(label, result.remedy);
    else ui.fail(label, result.remedy);
  }

  const status = worst(results);
  ui.blank();

  if (status === "ok") ui.step("Nothing to report.");
  else if (status === "warn") ui.step("Nothing broken, but worth a look.");
  else ui.step("Something is wrong. The failures above say what.");

  ui.blank();
}
