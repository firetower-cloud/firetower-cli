import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as prompts from "@clack/prompts";
import * as docker from "../docker.js";
import * as hosts from "../hosts.js";
import * as upstream from "../upstream.js";
import { compare } from "../version.js";
import { requireDeployment } from "./shared.js";
import { open as openDeployment, missingVariables } from "../deployment.js";
import { ui, pc } from "../ui.js";

export interface UpgradeOptions {
  dir?: string;
  yes?: boolean;
  backup?: boolean;
}

export async function upgrade(options: UpgradeOptions): Promise<void> {
  const dir = await requireDeployment(options.dir);

  ui.title("Firetower");

  const deployment = await openDeployment(dir);
  const control = deployment.services.control;

  const before = await docker.deployedVersion({ dir }, control);
  ui.dim(`installed   ${before ?? "unknown"}   ${dir}`);
  ui.dim("images      :latest");
  ui.blank();

  // The fleet, before anything moves. A host that is already unreachable is
  // worth knowing about now rather than blaming on the upgrade afterwards.
  const fleetBefore = await hosts.list({ dir }, control);

  await refreshComposeFile(dir, options);
  await backUp(deployment, options);

  const reopened = await openDeployment(dir);
  const missing = missingVariables(reopened.compose, reopened.env);
  if (missing.length > 0) {
    ui.blank();
    ui.fail(
      `this release needs ${missing.join(", ")}, which is not in your .env`,
      "upgrade the CLI: npm i -g @firetower/cli@latest",
    );
    ui.blank();
    process.exit(1);
  }

  ui.blank();
  ui.step("Upgrading the control plane");
  await docker.composeOrThrow({ dir, stream: true }, "pull");
  await docker.composeOrThrow({ dir }, "up", "-d");
  await docker.waitForHealthy({ dir }, control);
  ui.ok("healthy");

  const after = await docker.deployedVersion({ dir }, control);
  ui.blank();
  ui.step(pc.bold(`Firetower is on ${after ?? "the latest release"}.`));

  await reportWorkers(dir, control, after, fleetBefore, options);
}

/**
 * Re-fetch `firetower.yml` from the release being upgraded to, so a compose
 * change that ships with a release actually lands.
 *
 * Shown as a diff rather than applied silently: the file on disk may have been
 * edited — an extra volume, a port, a second worker — and overwriting somebody's
 * deployment without saying so is how a CLI stops being trusted with it.
 */
async function refreshComposeFile(dir: string, options: UpgradeOptions): Promise<void> {
  const files = await upstream.deployment();
  if (!files.tag) {
    ui.warn("could not reach github", "keeping the compose file already on disk");
    return;
  }

  const path = join(dir, docker.COMPOSE_FILE);
  const current = await readFile(path, "utf8");
  if (current === files.compose) return;

  const currentMajor = upstream.postgresMajor(current);
  const nextMajor = upstream.postgresMajor(files.compose);

  // Refused, not attempted. A Postgres container recreated on a new major
  // starts, finds a data directory it cannot read, and stays down until
  // somebody runs pg_upgrade by hand.
  if (currentMajor && nextMajor && currentMajor !== nextMajor) {
    ui.blank();
    ui.fail(
      `${files.tag} moves Postgres from ${currentMajor} to ${nextMajor}`,
      "https://usefiretower.com/docs/upgrading-postgres",
    );
    process.exit(1);
  }

  ui.warn(`${docker.COMPOSE_FILE} has changed in ${files.tag}`);

  if (!options.yes) {
    const replace = await prompts.confirm({ message: "Take the new one?" });
    if (prompts.isCancel(replace) || !replace) {
      ui.dim("keeping yours");
      return;
    }
  }

  await writeFile(join(dir, `${docker.COMPOSE_FILE}.backup`), current);
  await writeFile(path, files.compose);
  ui.ok(docker.COMPOSE_FILE, `updated, previous kept as ${docker.COMPOSE_FILE}.backup`);
}

/**
 * Offered first and defaulted to yes: migrations run on start and there is no
 * down path.
 */
async function backUp(
  deployment: Awaited<ReturnType<typeof openDeployment>>,
  options: UpgradeOptions,
): Promise<void> {
  const { dir } = deployment;
  if (options.backup === false) return;

  if (!options.yes && options.backup !== true) {
    const wanted = await prompts.confirm({ message: "Back up the database first?" });
    if (prompts.isCancel(wanted)) process.exit(1);
    if (!wanted) return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const directory = join(dir, "backups");
  await mkdir(directory, { recursive: true });

  const path = join(directory, `${stamp}.sql`);
  // `pg_dump -U firetower firetower` was hardcoded. Both come from the compose
  // file's ${POSTGRES_USER:-…} and ${POSTGRES_DB:-…}, so a changed default
  // upstream would have failed exactly the backup that matters most.
  const result = await docker.compose(
    { dir },
    "exec", "-T", deployment.services.database,
    "pg_dump", "-U", deployment.database.user, deployment.database.database,
  );

  if (result.exitCode !== 0) {
    ui.fail("the backup failed", `${result.stderr ?? ""}`.trim());
    if (!options.yes) {
      const anyway = await prompts.confirm({
        message: "Upgrade without a backup?",
        initialValue: false,
      });
      if (prompts.isCancel(anyway) || !anyway) process.exit(1);
    }
    return;
  }

  await writeFile(path, String(result.stdout));
  ui.ok(path);

  // The dump is worth nothing on its own: every credential in it is sealed
  // with the root key, so the two have to travel together to be a restore.
  const env = await readFile(join(dir, ".env"), "utf8");
  const key = /^FIRETOWER_ROOT_KEY=(.*)$/m.exec(env)?.[1];
  if (key) {
    await writeFile(join(directory, `${stamp}.root-key.txt`), `${key}\n`, { mode: 0o600 });
    ui.ok("root key copied alongside it");
  }
}

/**
 * Which machines are now behind, and exactly what to run on each.
 *
 * The control plane already knows: it compares its version against every
 * worker's on each handshake. All this does is ask, and turn the answer into
 * something to paste.
 */
async function reportWorkers(
  dir: string,
  control: string,
  version: string | null,
  before: hosts.Host[] | null,
  options: UpgradeOptions,
): Promise<void> {
  const fleet = (await hosts.list({ dir }, control)) ?? before;

  if (!fleet) {
    ui.notice([
      "Your workers need upgrading too.",
      "",
      "This deployment cannot list them — that arrived in a later",
      "release — so check Compute in the interface for a version",
      "warning, and on each machine that has one:",
      "",
      `  ${pc.bold("firetower worker upgrade")}`,
    ]);
    return;
  }

  const behind = fleet.filter(
    (host) => host.workerVersion && version && compare(host.workerVersion, version) < 0,
  );

  if (behind.length === 0) {
    ui.blank();
    ui.ok("every host is current");
    ui.blank();
    return;
  }

  const rows = behind.map((host) => {
    const destination = hosts.sshDestination(host.compute) ?? "local";
    return `  ${host.name.padEnd(12)} ${(host.workerVersion ?? "?").padEnd(8)} ${destination.padEnd(20)} ${hosts.containerName(host.compute)}`;
  });

  const current = fleet.length - behind.length;

  ui.notice([
    `${behind.length} of your ${fleet.length} machines ${behind.length === 1 ? "is" : "are"} still behind.`,
    "",
    "A worker and the control plane report a drift to each other on",
    "every handshake, so these will show a warning in the interface",
    "until they are upgraded.",
    "",
    ...rows,
    "",
    ...(current > 0 ? [`${current} already current, including localhost.`, ""] : []),
    "On each machine:",
    "",
    `  ${pc.bold("firetower worker upgrade")}`,
    "",
    "Or, if the CLI isn't there:",
    "",
    "  npm i -g @firetower/cli && firetower worker upgrade",
    "",
    "Recreating a worker takes its tmux server with it, and every",
    "session on that host goes too. `worker upgrade` refuses until the",
    "host is drained — that is the step this replaces, and the one",
    "people skip.",
  ]);

  if (options.yes) return;

  const show = await prompts.confirm({
    message: "Show the ssh line for each machine",
    initialValue: false,
  });
  if (prompts.isCancel(show) || !show) return;

  ui.blank();
  for (const host of behind) {
    const destination = hosts.sshDestination(host.compute);
    if (!destination) continue;

    const container = hosts.containerName(host.compute);
    ui.dim(
      `ssh ${destination} 'npm i -g @firetower/cli && firetower worker upgrade --container ${container}'`,
    );
  }
  ui.blank();
}
