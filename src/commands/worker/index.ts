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

export interface WorkerOptions {
  container?: string;
  yes?: boolean;
  /** Comma separated, for an install nobody is watching. */
  agents?: string;
}

function runArgs(name: string): string[] {
  return [
    "run", "-d",
    "--name", name,
    "--restart", "unless-stopped",
    "-v", `${VOLUME}:/var/lib/firetower`,
    IMAGE,
    // Nothing listens. Work happens in `docker exec`, in tmux sessions that
    // outlive the connection.
    "sleep", "infinity",
  ];
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

  const run = await docker.docker(...runArgs(name));
  if (run.exitCode !== 0) {
    ui.fail("could not start the worker", `${run.stderr ?? ""}`.trim());
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

  const removed = await docker.docker("rm", "-f", name);
  if (removed.exitCode !== 0) {
    ui.fail(`could not remove ${name}`, `${removed.stderr ?? ""}`.trim());
    process.exit(1);
  }
  ui.ok("removed", name);

  const run = await docker.docker(...runArgs(name));
  if (run.exitCode !== 0) {
    ui.fail("could not start the new worker", `${run.stderr ?? ""}`.trim());
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
