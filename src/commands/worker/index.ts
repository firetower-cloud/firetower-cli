import * as prompts from "@clack/prompts";
import * as docker from "../../docker.js";
import { ui, pc } from "../../ui.js";

/**
 * The worker, on the machine it runs on.
 *
 * **Nothing here touches a secret.** What an agent authenticates with is held
 * by the control plane and handed to a session as it starts, so a fresh
 * container needs no login. Installing an agent and signing it in are separate
 * acts and only the first happens here — `agents add` fetches a binary, and
 * that is all it does.
 *
 * These commands do not talk to the control plane. The worker machine holds no
 * credential for it — deliberately — so `worker upgrade` cannot confirm the host
 * is drained and has to ask instead.
 */

const IMAGE = "ghcr.io/firetower-cloud/firetower-worker:latest";
const DEFAULT_NAME = "firetower-worker";
const VOLUME = "firetower";

/**
 * Turns the daemon inside the worker container off.
 *
 * The same spelling the worker's entrypoint reads and the control plane sets —
 * two names for one contract is a setting that appears to be ignored.
 */
const DOCKER_ENV = "FIRETOWER_WORKER_DOCKER";

export interface WorkerOptions {
  container?: string;
  yes?: boolean;
  /** Comma separated, for an install nobody is watching. */
  agents?: string;
  /** Whether this worker runs a Docker daemon. `--no-docker` turns it off. */
  docker?: boolean;
}

/**
 * Where a worker's image cache lives, keyed to the worker.
 *
 * Named, and per worker rather than shared: two workers on one machine are two
 * daemons, and a daemon does not share `/var/lib/docker` with another one —
 * they would corrupt each other's metadata.
 *
 * The prefix is load-bearing in two other places, so it cannot be renamed here
 * alone: `cache_volume` in ft-server builds the same string, and the
 * `worker-cache-clean` recipe strips it back off to recover the worker's name.
 */
function cacheVolume(name: string): string {
  return `firetower-docker-${name}`;
}

/**
 * The whole `docker run`, as one list, so that what a worker is created with
 * can be asserted rather than described.
 *
 * **This has to agree with `run_args` in ft-server.** Both create the same
 * container, and the two of them drifting apart is what made `worker upgrade`
 * hand back a worker whose Docker could not start: the daemon came up, failed
 * to write its iptables NAT chain without `CAP_NET_ADMIN`, and exited — which
 * a session sees only as "cannot connect to the Docker daemon".
 */
export function runArgs(name: string, docker: boolean): string[] {
  const args = [
    "run", "-d",
    "--name", name,
    "--restart", "unless-stopped",

    // An init as pid 1, to reap what the daemon leaves behind.
    //
    // The command below is `sleep infinity`, which reaps nothing. dockerd's
    // children — containerd, and a shim per container — reparent to pid 1 when
    // they exit, and a machine that starts and stops containers all day would
    // leave a growing pile of zombies on a worker that stays up for weeks.
    "--init",

    "-v", `${VOLUME}:/var/lib/firetower`,
  ];

  if (docker) {
    // What lets a session run its own stack — compose, a database, whatever
    // the repository needs.
    //
    // **Nothing smaller works.** The daemon needs `CAP_NET_ADMIN` to create
    // the bridge network and `CAP_SYS_ADMIN` to mount an image's layers, and
    // on a host with AppArmor the `docker-default` profile denies `mount`
    // whatever capabilities are added. `--cap-add` alone gets you a daemon
    // that starts and then cannot pull an image.
    //
    // **What this costs.** A privileged container can become root on the
    // machine it runs on. A worker is already a machine somebody hands to an
    // agent, which is why it is a machine you were willing to give away —
    // `--no-docker` is there for when it isn't.
    args.push("--privileged");

    // The daemon's own storage, on a volume rather than on the container's
    // filesystem.
    //
    // **Not an optimisation — a requirement.** A daemon writing its overlay
    // filesystem onto the overlay filesystem it is itself running on is the
    // classic nested-Docker failure, and it fails in ways that read as a
    // broken image rather than a bad mount.
    //
    // That it also survives `upgrade` is the second reason, and the one
    // somebody notices: without it every upgrade costs a fresh pull of
    // postgres, node and everything else a session had built up.
    args.push("-v", `${cacheVolume(name)}:/var/lib/docker`);
  } else {
    // Told rather than inferred. The entrypoint would otherwise start a daemon
    // that cannot work and leave a failure in the log that looks like a fault
    // instead of a setting.
    args.push("-e", `${DOCKER_ENV}=off`);
  }

  args.push(
    IMAGE,
    // Nothing listens. Work happens in `docker exec`, in tmux sessions that
    // outlive the connection.
    "sleep", "infinity",
  );

  return args;
}

/**
 * Whether the container that is already there had its daemon turned off on
 * purpose.
 *
 * **Asked this way round for a reason.** The obvious question — is it
 * privileged? — cannot tell the two cases apart that matter here. Every worker
 * created before this CLI could run Docker is unprivileged, and so is every
 * worker somebody deliberately installed with `--no-docker`. Preserving
 * "unprivileged" would mean the upgrade that exists to give those first
 * workers Docker gives it to none of them.
 *
 * So the question is whether somebody said no, and only this variable says
 * that. A container that predates the feature has neither the privilege nor
 * the variable, and comes back with Docker on — which is the point of running
 * the upgrade at all.
 *
 * Read from the container rather than remembered, because nothing on this
 * machine writes down what it was installed with.
 */
async function dockerTurnedOff(name: string): Promise<boolean> {
  const result = await docker.docker(
    "inspect", "-f", `{{range .Config.Env}}{{println .}}{{end}}`, name,
  );

  // A container we could not read is not a container that said no. Guessing
  // "off" here would turn Docker off on a worker that had it, for nothing
  // worse than a daemon that was busy.
  if (result.exitCode !== 0) return false;

  return saysDockerOff(String(result.stdout));
}

/**
 * Whether an environment says the daemon is off.
 *
 * Any value but `off` leaves it on, which is how the entrypoint and the
 * control plane both read this variable — a typo should not quietly remove the
 * feature.
 */
export function saysDockerOff(env: string): boolean {
  return env.split("\n").some((line) => {
    // Split on the first `=` only: a value may contain more of them, and the
    // name may not.
    const at = line.indexOf("=");
    if (at < 0) return false;

    // The name exactly, the value however it was typed — the same asymmetry
    // the control plane reads it with. `Off` is off; `FIRETOWER_worker_docker`
    // is a different variable that nothing looks at.
    return (
      line.slice(0, at).trim() === DOCKER_ENV &&
      line.slice(at + 1).trim().toLowerCase() === "off"
    );
  });
}

/**
 * What `docker run` said, turned into something to do about it.
 *
 * One case is worth naming. A machine configured to refuse privileged
 * containers — a hardened daemon, some managed hosts, a rootless daemon — says
 * so in a way that reads as a bug in Firetower, and the answer is a flag
 * rather than a fix.
 */
function refusal(stderr: string): { message: string; remedy: string } {
  const said = stderr.trim();

  if (said.toLowerCase().includes("privileged")) {
    return {
      message:
        "this machine will not run privileged containers, which is what a " +
        "worker needs to run Docker inside a session",
      remedy:
        "re-run with --no-docker: sessions there serve terminals, git and " +
        "agents as before, and simply have no Docker",
    };
  }

  return { message: "could not start the worker", remedy: said };
}

async function workerVersion(name: string): Promise<string | null> {
  const result = await docker.docker("exec", name, "firetower", "--version");
  if (result.exitCode !== 0) return null;

  const match = /(\d+\.\d+\.\d+)/.exec(String(result.stdout));
  return match?.[1] ?? null;
}

/** What somebody can be asked to install, and what to call it. */
const AGENTS = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
] as const;

/**
 * Install agents into the worker's volume.
 *
 * They are not in the image — each is a few hundred megabytes and they are
 * published on their own schedules — so they are fetched onto the volume,
 * which survives recreating the container to upgrade the worker.
 *
 * A failure here is reported and does not fail the install: a worker with no
 * agent is a worker somebody can add one to, and pretending the whole thing
 * did not happen would be worse.
 */
async function addAgents(name: string, kinds: readonly string[]): Promise<void> {
  for (const kind of kinds) {
    const label = AGENTS.find((a) => a.value === kind)?.label ?? kind;
    ui.step(`Installing ${label}`);

    const result = await docker.dockerStreaming(
      "exec",
      name,
      "firetower-worker",
      "agents",
      "add",
      kind,
    );

    if (result.exitCode !== 0) {
      ui.fail(`could not install ${label}`, `firetower worker agents add ${kind}`);
    }
  }
}

/** Which agents to install, asked once. */
async function chooseAgents(yes: boolean | undefined): Promise<readonly string[]> {
  // Nothing to ask when nobody is there to answer. `--agents` is how a scripted
  // install says what it wants.
  if (yes) return [];

  const picked = await prompts.multiselect({
    message: "Which agents will run on this machine?",
    options: AGENTS.map((a) => ({ value: a.value, label: a.label })),
    initialValues: ["claude-code"],
    required: false,
  });

  if (prompts.isCancel(picked)) return [];
  return picked as readonly string[];
}

export async function agents(options: WorkerOptions & { add?: string; remove?: string }): Promise<void> {
  const name = options.container ?? DEFAULT_NAME;
  ui.title("Agents");

  if (!(await docker.containerExists(name))) {
    ui.fail(`no container called ${name}`, "firetower worker install");
    ui.blank();
    process.exit(1);
  }

  if (options.add) {
    await addAgents(name, [options.add]);
    ui.blank();
    return;
  }

  if (options.remove) {
    const result = await docker.dockerStreaming(
      "exec", name, "firetower-worker", "agents", "remove", options.remove,
    );
    if (result.exitCode !== 0) process.exit(1);
    ui.blank();
    return;
  }

  const listed = await docker.docker("exec", name, "firetower-worker", "agents");
  for (const line of String(listed.stdout ?? "").trimEnd().split("\n")) {
    ui.dim(line);
  }
  ui.blank();
}

export async function install(options: WorkerOptions): Promise<void> {
  const name = options.container ?? DEFAULT_NAME;
  ui.title("Firetower worker");

  const daemon = await docker.daemon();
  if (!daemon.ok) {
    ui.fail(daemon.message ?? "docker is unreachable", daemon.remedy);
    ui.blank();
    process.exit(1);
  }

  if (await docker.containerExists(name)) {
    ui.fail(`a container called ${name} already exists`, "firetower worker upgrade");
    ui.blank();
    process.exit(1);
  }

  ui.step("Starting the worker");
  const pull = await docker.dockerStreaming("pull", IMAGE);
  if (pull.exitCode !== 0) process.exit(1);

  // On unless it was turned off, because the useful configuration is the
  // default one and a worker that cannot run the repository's stack is a
  // worker somebody has to come back to.
  const wantsDocker = options.docker !== false;

  const run = await docker.docker(...runArgs(name, wantsDocker));
  if (run.exitCode !== 0) {
    const { message, remedy } = refusal(`${run.stderr ?? ""}`);
    ui.fail(message, remedy);
    process.exit(1);
  }

  ui.ok(name, (await workerVersion(name)) ?? "started");

  // After the container exists, because installing one runs inside it. Before
  // the "now add it in Firetower" notice, so somebody following along top to
  // bottom has a working host by the time they reach it.
  const wanted = options.agents
    ? options.agents.split(",").map((a: string) => a.trim()).filter(Boolean)
    : await chooseAgents(options.yes);

  if (wanted.length > 0) {
    ui.blank();
    await addAgents(name, wanted);
  }

  // Firetower will be this account. If it cannot reach Docker, the host is
  // added and stays unreachable for a reason nobody thinks to check.
  ui.blank();
  ui.step("The account Firetower connects as must be able to reach Docker.");
  ui.dim("Check with `docker ps` as that account, not as root.");

  ui.notice([
    "Now add it in Firetower:",
    "",
    `  ${pc.bold("Compute → Add compute → A server")}`,
    "",
    "  address    this machine's hostname or address",
    "  user       the account to ssh as",
    "  key        a private key that account accepts",
    `  container  ${name}`,
    "",
    "Nothing here needs a port, a key inside the image, or an sshd:",
    "Firetower ssh-es to the machine and runs `docker exec`.",
  ]);
}

export async function upgrade(options: WorkerOptions): Promise<void> {
  const name = options.container ?? DEFAULT_NAME;
  ui.title("Firetower worker");

  if (!(await docker.containerExists(name))) {
    ui.fail(`no container called ${name}`, "firetower worker install");
    ui.blank();
    process.exit(1);
  }

  const before = await workerVersion(name);
  ui.dim(`${name}   ${before ?? "unknown"}`);

  // Read before the container is removed, which is the only moment it can be
  // read at all.
  //
  // An upgrade keeps the machine somebody has: a worker installed with
  // `--no-docker` stays that way, and one that has Docker keeps it. Passing
  // either flag is how that is changed, and this is the one command where
  // changing it is the point — every worker created before Docker worked has
  // to come through here to get it.
  const wantsDocker = options.docker ?? !(await dockerTurnedOff(name));

  // The one step here that can lose work, which is why it comes before the
  // commands rather than after them.
  ui.notice([
    pc.yellow("Drain this host first, and wait."),
    "",
    "Recreating the container takes the tmux server with it, and",
    "every session running here goes too. In Firetower: Compute →",
    "this host → Drain, until nothing is running on it.",
    "",
    "This CLI cannot check for you — the worker machine holds no",
    "credential for the control plane, which is the point.",
  ]);

  if (!options.yes) {
    const drained = await prompts.confirm({
      message: "The host is drained and idle",
      initialValue: false,
    });
    if (prompts.isCancel(drained) || !drained) {
      ui.dim("nothing was changed");
      ui.blank();
      process.exit(1);
    }
  }

  ui.step("Upgrading");
  const pull = await docker.dockerStreaming("pull", IMAGE);
  if (pull.exitCode !== 0) process.exit(1);

  // `--volumes` removes the container's *anonymous* volumes and leaves every
  // named one alone — so `firetower` and the image cache survive, and the
  // anonymous `/var/lib/docker` that older CLIs left behind on each upgrade
  // (the image declares it, nothing claimed it) is finally collected rather
  // than dangling with a cache nobody can reach.
  const removed = await docker.docker("rm", "-f", "--volumes", name);
  if (removed.exitCode !== 0) {
    ui.fail(`could not remove ${name}`, `${removed.stderr ?? ""}`.trim());
    process.exit(1);
  }
  ui.ok("removed", name);

  const run = await docker.docker(...runArgs(name, wantsDocker));
  if (run.exitCode !== 0) {
    const { message, remedy } = refusal(`${run.stderr ?? ""}`);
    ui.fail(message, remedy);
    process.exit(1);
  }

  ui.ok(name, (await workerVersion(name)) ?? "started");

  // After the container exists, because installing one runs inside it. Before
  // the "now add it in Firetower" notice, so somebody following along top to
  // bottom has a working host by the time they reach it.
  const wanted = options.agents
    ? options.agents.split(",").map((a: string) => a.trim()).filter(Boolean)
    : await chooseAgents(options.yes);

  if (wanted.length > 0) {
    ui.blank();
    await addAgents(name, wanted);
  }
  ui.ok("volume reattached", VOLUME);
  ui.ok("docker", wantsDocker ? `on, cache in ${cacheVolume(name)}` : "off");

  ui.blank();
  ui.step("Undrain the host in Firetower to give it work again.");
  ui.blank();
}

export async function status(options: WorkerOptions & { json?: boolean }): Promise<void> {
  const name = options.container ?? DEFAULT_NAME;

  const exists = await docker.containerExists(name);
  const version = exists ? await workerVersion(name) : null;

  if (options.json) {
    ui.json({ container: name, exists, version });
    return;
  }

  ui.title("Firetower worker");

  if (!exists) {
    ui.fail(`no container called ${name}`, "firetower worker install");
    ui.blank();
    process.exit(1);
  }

  ui.ok(name, version ?? "running, version unknown");
  ui.blank();
}
