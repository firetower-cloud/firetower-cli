import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as prompts from "@clack/prompts";
import * as docker from "../docker.js";
import * as env from "../env.js";
import * as hosts from "../hosts.js";
import * as services from "../services.js";
import * as upstream from "../upstream.js";
import { compare } from "../version.js";
import { requireDeployment } from "./shared.js";
import { open as openDeployment, missingVariables } from "../deployment.js";
import {
  cancelled,
  choosePorts,
  derive,
  infer,
  published,
  stop,
  type Ports,
  type Reach,
} from "../shape.js";
import { ui, pc } from "../ui.js";

export interface UpgradeOptions {
  dir?: string;
  yes?: boolean;
  backup?: boolean;
  httpPort?: number;
}

/**
 * Upgrade the control plane, and re-derive the deployment around it.
 *
 * The second half is the part that used to be missing. `upgrade` replaced
 * `firetower.yml` and reused whatever `.env` was on disk, which works exactly
 * as long as every variable keeps its meaning. `HTTP_PORT` stopped meaning
 * "Caddy's host port" and started meaning "the control plane's host port", and
 * a deployment installed under the old sense inherited an 80 that now described
 * something else — and failed to bind against a Caddy from its own previous
 * release, still running, that Compose had stopped managing.
 *
 * So nothing is carried forward on trust. The shape is recomputed from the
 * compose file that will actually run, printed key by key, and written over the
 * old one. See `env.SEALED` for the values that are exempt from that, and why.
 */
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

  // Read while the old stack is still up: these are the ports it holds and is
  // about to release, and they have to count as free when the new shape is
  // chosen. See `Held` in shape.ts.
  const held = await heldPorts(dir);

  const composeChanged = await refreshComposeFile(dir, options);
  const plan = await reshape(dir, options, held, deployment.compose);

  // Compose refuses to start without these, with an error naming a variable
  // the operator has never heard of. Say it properly instead.
  const missing = missingVariables(plan.compose, plan.next);
  if (missing.length > 0) {
    ui.blank();
    ui.fail(
      `this release needs ${missing.join(", ")}, which is not in your .env`,
      "upgrade the CLI: npm i -g @firetower/cli@latest",
    );
    ui.blank();
    process.exit(1);
  }

  report(plan, composeChanged);

  // The last question. Everything past this writes or removes something.
  if (!options.yes && (plan.changes.length > 0 || plan.orphans.length > 0)) {
    const proceed = await prompts.confirm({ message: "Continue?" });
    if (cancelled(proceed) || !proceed) stop("Nothing was changed.");
  }

  await backUp(await openDeployment(dir), options);
  await writeEnv(dir, plan);

  ui.blank();
  ui.step("Upgrading the control plane");

  // Down first, rather than `up -d --remove-orphans`, whenever the shape moved.
  // Two reasons, and both are the reported failure:
  //
  //   * a container from the old release has to have released its ports before
  //     the new one binds them, and orphan removal inside an `up` is not
  //     ordered against the creation that needs it;
  //   * `caddy` moved behind the `tls` profile, so Compose neither creates nor
  //     stops the old one — it stays up holding 80 and 443, unmentioned.
  //
  // Only when it buys something. `down` takes running agent sessions with it,
  // which a plain image bump has no business doing.
  // `held` is this project's own published ports. If the port about to be bound
  // is among them, something here is on it and `up` alone would recreate the
  // control plane straight into `address already in use` — the reported error,
  // raised against a container from the release being replaced.
  const collides = held.has(plan.ports.http);

  if (composeChanged || plan.changes.length > 0 || plan.orphans.length > 0 || collides) {
    // Every profile, not the ones this deployment wants. `--remove-orphans`
    // alone walks straight past the old Caddy: a profile-gated service is not
    // an orphan to Compose, just one it has not selected, so the container
    // stays up holding the port the control plane is about to want.
    await docker.composeOrThrow(
      { dir, profiles: services.allProfiles(plan.compose) },
      "down",
      "--remove-orphans",
    );
    ui.ok("stopped", plan.orphans.length > 0 ? "including the containers above" : undefined);
  }

  await clearForTakeoff(dir, plan);

  await docker.composeOrThrow({ dir, stream: true }, "pull");
  await docker.composeOrThrow({ dir }, "up", "-d");
  await docker.waitForHealthy({ dir }, control);
  ui.ok("healthy");

  const after = await docker.deployedVersion({ dir }, control);
  await confirmItAnswers(plan);

  ui.blank();
  ui.step(pc.bold(`Firetower is on ${after ?? "the latest release"}.`));
  ui.blank();
  ui.dim(`  ${plan.next.FIRETOWER_PUBLIC_URL}`);
  ui.blank();

  await reportWorkers(dir, control, after, fleetBefore, options);
}

/**
 * Ports this deployment's own containers currently publish.
 *
 * Without this, upgrading a deployment already on 8080 asks Docker whether 8080
 * is free, is told no by its own control plane, and steers the operator onto a
 * different port for no reason at all. Orphans are included: they are precisely
 * what `down --remove-orphans` is about to release.
 */
async function heldPorts(dir: string): Promise<Set<number>> {
  const containers = await docker.projectContainers({ dir });
  return new Set(containers.flatMap((container) => container.ports));
}

interface Plan {
  dir: string;
  /** The compose file as it is on disk now, which may not be the new one. */
  compose: string;
  reach: Reach;
  /** Not readonly: `clearForTakeoff` moves this when the prediction was wrong. */
  ports: Ports;
  current: env.Env;
  next: env.Env;
  changes: env.Change[];
  orphans: docker.ProjectContainer[];
}

/**
 * What this deployment should look like on the release it is moving to.
 *
 * Nothing here is translated from the old values. The reach is read back out of
 * `.env` — it is the one answer that cannot be derived from anything else — and
 * the rest is computed from the compose file now on disk. A variable whose
 * meaning changed between releases is therefore recomputed under the new
 * meaning instead of being carried forward under the old one.
 */
async function reshape(
  dir: string,
  options: UpgradeOptions,
  held: Set<number>,
  previous: string,
): Promise<Plan> {
  // Reopened, because `refreshComposeFile` may have replaced the file — and may
  // deliberately not have, if the operator kept theirs. The shape has to follow
  // the file that will actually run.
  const deployment = await openDeployment(dir);

  const reach = infer(deployment.env);
  const kept = await keepablePorts(previous, deployment, held);

  const ports = await choosePorts(
    reach,
    deployment.compose,
    { ...options, httpPort: options.httpPort ?? kept.http, httpsPort: kept.https },
    held,
  );

  const next = env.reshape(deployment.env, derive(reach, ports));
  const expected = services.createdServices(deployment.compose, services.activeProfiles(next));

  return {
    dir,
    compose: deployment.compose,
    reach,
    ports,
    current: deployment.env,
    next,
    changes: env.changes(deployment.env, next),
    orphans: await docker.orphans({ dir }, expected),
  };
}

/**
 * The ports worth keeping, which is not the same question as what is in `.env`.
 *
 * Re-deriving is about meaning, not about numbers. An operator who chose 9000
 * because 8080 was spoken for should still be on 9000 after an upgrade, and
 * moving them because a release edited an unrelated line of the compose file
 * would be its own broken bookmark.
 *
 * So the number survives exactly when the thing it describes does. `portOwner`
 * answers that from the two files: `HTTP_PORT` belonged to `caddy` and now
 * belongs to the control plane, and a value about Caddy's front door is not a
 * value about where the vault is published. Different owner, or a port
 * something else has taken in the meantime, and the answer is recomputed.
 */
async function keepablePorts(
  previous: string,
  deployment: { compose: string; env: env.Env },
  held: Set<number>,
): Promise<{ http?: number; https?: number }> {
  const before = services.portOwner(previous, "HTTP_PORT");
  const after = services.portOwner(deployment.compose, "HTTP_PORT");

  // A file with no `${HTTP_PORT}` on either side says nothing either way, and
  // guessing from an absence is how a port silently stops being honoured.
  if (!before || !after || before !== after) return {};

  // Comparing the two files is not enough on its own, and this is the case it
  // misses: an upgrade that replaced `firetower.yml` and then failed leaves the
  // compose file migrated and `.env` untouched. Both sides of the comparison
  // above are then the *new* file, they agree, and the stale number is kept —
  // which is the failure this whole command exists to prevent, surviving into
  // the fix for it.
  //
  // So ask the file instead of the history: a compose that reads `HTTP_BIND`
  // against a `.env` that has never heard of it was written by an older world,
  // and nothing in it describes this release.
  if (services.bindIsConfigurable(deployment.compose) && !deployment.env.HTTP_BIND) return {};

  const http = port(deployment.env.HTTP_PORT);
  const https = port(deployment.env.HTTPS_PORT);

  // Held by this deployment counts as free: it is the container about to be
  // replaced. So does genuinely free, for a deployment that is upgraded while
  // stopped. Anything else on it is a conflict, and keeping the number would
  // walk into exactly the bind failure this command exists to avoid.
  if (http === undefined) return {};
  if (!held.has(http) && !(await docker.portIsFree(http))) return {};

  return { http, https };
}

const port = (value?: string): number | undefined => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : undefined;
};

/**
 * Everything about to change, by name.
 *
 * An upgrade that rewrites `.env` is only tolerable if it says which values and
 * what they become, so this is deliberately not a summary. A moved port is the
 * difference between a bookmark that works and one that does not, and the
 * operator should read that here rather than discover it.
 */
function report(plan: Plan, composeChanged: boolean): void {
  ui.blank();
  ui.step("Here is what I will do:");
  ui.blank();

  if (composeChanged) ui.dim(`compose       replaced by the new release`);
  ui.dim(`reached by    ${describe(plan.reach)}`);
  ui.dim(`published     ${published(plan.reach, plan.ports)}`);
  ui.dim(`url           ${plan.next.FIRETOWER_PUBLIC_URL}`);

  if (plan.changes.length === 0) {
    ui.dim(`env           unchanged`);
  } else {
    ui.blank();
    ui.step(".env, recomputed from this release:");
    ui.blank();
    for (const { key, before, after } of plan.changes) {
      ui.dim(`  ${key.padEnd(24)} ${shown(before)} → ${shown(after)}`);
    }
  }

  if (plan.orphans.length > 0) {
    ui.blank();
    ui.step("From the release you are leaving, and no longer part of it:");
    ui.blank();
    for (const orphan of plan.orphans) {
      const holding = orphan.ports.length > 0 ? `holding ${orphan.ports.join(", ")}` : "";
      ui.dim(`  ${orphan.name.padEnd(28)} ${holding}`);
    }
    ui.blank();
    ui.dim("  These will be removed. Their volumes are kept.");
  }

  ui.blank();
}

/** A value that is absent and one that is empty are different, and both matter. */
const shown = (value?: string): string =>
  value === undefined ? "unset" : value === "" ? "empty" : value;

function describe(reach: Reach): string {
  if (reach.kind === "domain") return `${reach.domain}, over HTTPS`;
  if (reach.kind === "proxy") return `${reach.publicUrl}, behind your own proxy`;

  return "this machine only, over an ssh tunnel";
}

/**
 * `.env`, with the previous one kept beside it.
 *
 * `firetower.yml.backup` has existed since the compose file started being
 * replaced. This file is replaced now too, and deserves it more: the compose
 * file can always be fetched from the release again, and a `.env` cannot be
 * fetched from anywhere.
 */
async function writeEnv(dir: string, plan: Plan): Promise<void> {
  if (plan.changes.length === 0) return;

  const path = join(dir, ".env");

  await writeFile(join(dir, ".env.backup"), await readFile(path, "utf8"), { mode: 0o600 });
  await env.write(path, plan.next);

  ui.ok(path, "previous kept as .env.backup");
}

/**
 * That the port really is free, now that everything meant to release it has.
 *
 * Everything above this point is a prediction: which containers would go, which
 * ports they were holding, what would therefore be free. This is the one place
 * that checks, and it runs at the only moment the answer is authoritative —
 * after the `down`, before Compose binds anything.
 *
 * It exists because the prediction has been wrong. Treating a port as free
 * because *this project* held it is right only if the container actually went,
 * and an orphan that was never detected does not go. Compose's error for that
 * names a container id and an errno; this names the port and moves off it.
 */
async function clearForTakeoff(dir: string, plan: Plan): Promise<void> {
  if (!plan.ports.configurable) return;
  if (await docker.portIsFree(plan.ports.http)) return;

  const moved = await firstFreePort(plan.ports.http);

  ui.blank();
  ui.warn(
    `something still answers on ${plan.ports.http}`,
    `publishing on ${moved} instead — stop whatever holds it and re-run to move back`,
  );

  plan.ports = { ...plan.ports, http: moved };
  plan.next = env.reshape(plan.next, derive(plan.reach, plan.ports));
  plan.changes = env.changes(plan.current, plan.next);

  await env.write(join(dir, ".env"), plan.next);
  ui.ok(join(dir, ".env"), `HTTP_PORT is ${moved}`);
}

async function firstFreePort(from: number): Promise<number> {
  for (let port = from + 1; port < from + 64; port++) {
    if (await docker.portIsFree(port)) return port;
  }

  return from;
}

/**
 * That the thing just moved actually answers where the last line says it does.
 *
 * `waitForHealthy` asks the container about itself, through Compose, and passes
 * happily for a control plane that is perfectly well and published on a port
 * nobody was told about. This asks the host, on the port that was just written.
 */
async function confirmItAnswers(plan: Plan): Promise<void> {
  const address = `http://127.0.0.1:${plan.ports.http}`;

  try {
    await fetch(address, { signal: AbortSignal.timeout(10_000) });
    ui.ok("answering", address);
  } catch {
    // Not fatal. Compose has already said the control plane is healthy, so this
    // is a publishing problem — and naming the address that failed is worth
    // more than failing a command whose work is done.
    ui.warn(
      `nothing answers on ${address}`,
      `the control plane is healthy, so something else holds ${plan.ports.http}: firetower doctor`,
    );
  }
}

/**
 * Re-fetch `firetower.yml` from the release being upgraded to, so a compose
 * change that ships with a release actually lands.
 *
 * Shown as a diff rather than applied silently: the file on disk may have been
 * edited — an extra volume, a port, a second worker — and overwriting somebody's
 * deployment without saying so is how a CLI stops being trusted with it.
 */
async function refreshComposeFile(dir: string, options: UpgradeOptions): Promise<boolean> {
  const files = await upstream.deployment();
  if (!files.tag) {
    ui.warn("could not reach github", "keeping the compose file already on disk");
    return false;
  }

  const path = join(dir, docker.COMPOSE_FILE);
  const current = await readFile(path, "utf8");
  if (current === files.compose) return false;

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
      return false;
    }
  }

  await writeFile(join(dir, `${docker.COMPOSE_FILE}.backup`), current);
  await writeFile(path, files.compose);
  ui.ok(docker.COMPOSE_FILE, `updated, previous kept as ${docker.COMPOSE_FILE}.backup`);

  return true;
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
  const contents = await readFile(join(dir, ".env"), "utf8");
  const key = /^FIRETOWER_ROOT_KEY=(.*)$/m.exec(contents)?.[1];
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
