import { execa, type Options, type Result } from "execa";
import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as env from "./env.js";
import * as services from "./services.js";

/**
 * Everything that shells out to Docker.
 *
 * `docker compose`, not the Docker SDK: the SDK speaks to the daemon, and
 * Compose is a client-side thing the daemon knows nothing about. Driving the
 * binary is also what the README tells people to do by hand, so a deployment
 * this CLI made and one somebody made themselves are the same deployment.
 */

export const COMPOSE_FILE = "firetower.yml";

export class DockerError extends Error {
  constructor(
    message: string,
    /** What to actually do about it. Printed under the error. */
    readonly remedy?: string,
  ) {
    super(message);
    this.name = "DockerError";
  }
}

async function run(command: string, args: string[], options: Options = {}): Promise<Result> {
  return execa(command, args, { ...options, reject: false });
}

export async function version(): Promise<string | null> {
  const result = await run("docker", ["version", "--format", "{{.Client.Version}}"]);
  return result.exitCode === 0 ? String(result.stdout).trim() : null;
}

/**
 * Whether the daemon answers, and whether this account is allowed to ask.
 *
 * These are different failures with the same shape. Permission denied is by far
 * the most common, and the remedy needs saying in full — adding yourself to the
 * group does nothing until you log back in, which is the step people miss.
 */
export async function daemon(): Promise<{ ok: boolean; message?: string; remedy?: string }> {
  const result = await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (result.exitCode === 0) return { ok: true };

  const output = `${result.stderr ?? ""}`.toLowerCase();

  if (output.includes("permission denied")) {
    return {
      ok: false,
      message: "this account is not allowed to talk to the Docker daemon",
      remedy: "sudo usermod -aG docker $USER, then log out and back in",
    };
  }

  if (output.includes("cannot connect") || output.includes("is the docker daemon running")) {
    return {
      ok: false,
      message: "the Docker daemon is not running",
      remedy: "sudo systemctl start docker",
    };
  }

  return { ok: false, message: "docker info failed", remedy: `${result.stderr ?? ""}`.trim() };
}

export async function composeVersion(): Promise<string | null> {
  const result = await run("docker", ["compose", "version", "--short"]);
  return result.exitCode === 0 ? String(result.stdout).trim() : null;
}

export async function architecture(): Promise<string | null> {
  const result = await run("docker", ["version", "--format", "{{.Server.Arch}}"]);
  return result.exitCode === 0 ? String(result.stdout).trim() : null;
}

/**
 * Whether anything already holds a port.
 *
 * Checked before `up` because the alternative is a Compose error naming a
 * container id and an errno, at the end of a pull, with the stack half-created.
 */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const settle = (free: boolean) => {
      socket.destroy();
      resolve(free);
    };

    socket.setTimeout(1000);
    socket.once("connect", () => settle(false));
    socket.once("timeout", () => settle(true));
    socket.once("error", () => settle(true));
  });
}

export interface ComposeOptions {
  /** The directory holding firetower.yml and .env. */
  dir: string;
  /** Stream to the terminal. For pulls and logs, where silence looks hung. */
  stream?: boolean;
  /**
   * Run against these profiles instead of the ones `.env` asks for.
   *
   * For `down` and nothing else. A profile-gated service is not an orphan —
   * Compose knows about it and has simply not selected it — so neither
   * `--remove-orphans` nor a plain `down` touches the container of a service
   * that moved behind a profile in the release being left. It stays up holding
   * its ports. Selecting every profile the file defines is what makes a `down`
   * mean the whole project.
   */
  profiles?: string[];
}

/**
 * What a variable is worth when the only thing that asks for it will not be
 * created.
 *
 * Something Compose can interpolate and nothing can read. Deliberately not a
 * plausible domain: if this ever does reach a container, the value should be
 * the thing that gives away where it came from.
 */
const UNREAD = "unset";

interface Invocation {
  /** `--profile` flags, for the optional services this deployment wants. */
  profiles: string[];
  /** Values for the variables Compose demands of services it will not create. */
  environment: Record<string, string>;
}

/**
 * How to run Compose in this directory, read from the deployment rather than
 * assumed. Two answers, from one read of `.env`.
 *
 * **The profiles** are passed explicitly rather than left to
 * `COMPOSE_PROFILES` in the file. Compose does read that file, but whether it
 * honours this particular setting from it has varied between versions — and
 * the failure is quiet in the worst way: `up -d` succeeds having created no
 * proxy, and the operator is left with a deployment that never answers on the
 * name they configured.
 *
 * **The environment** is the opposite problem, and it is Compose's own. A
 * profile decides which containers are created; it does not decide which
 * variables are interpolated, and the whole file is interpolated before any of
 * it is filtered. So the proxy's `DOMAIN: ${DOMAIN:?…}` refuses to pull in a
 * deployment that has no proxy — the shape this CLI installs by default — and
 * the error names a container that was never going to exist. A value only this
 * command can see gets past that without writing a domain nobody chose into
 * `.env`, where `doctor` would later read it back as a certificate to check
 * and `install` would have recorded a decision the operator never made.
 *
 * Anything actually set wins, in `.env` or in the environment this process was
 * given. The placeholder is only ever for a variable with no answer at all.
 */
async function invocation(dir: string, override?: string[]): Promise<Invocation> {
  const values = (await env.read(join(dir, ".env"))) ?? {};
  const profiles = override ?? services.activeProfiles(values);
  const compose = await composeFile(dir);

  // With an override the placeholder covers more ground, and has to. Turning a
  // profile on to take its container down makes that service live, so what was
  // a dormant `${DOMAIN:?…}` a moment ago becomes a variable Compose demands
  // of a deployment that has no answer for it — and the `down` fails on the
  // very service it was widened to reach. Anything genuinely missing from a
  // live service has already been refused by `missingVariables`.
  const unanswered = override
    ? services.requiredVariables(compose, profiles)
    : services.dormantRequiredVariables(compose, profiles);

  const environment: Record<string, string> = {};
  for (const name of unanswered) {
    if (!values[name] && !process.env[name]) environment[name] = UNREAD;
  }

  return { profiles: profiles.flatMap((name) => ["--profile", name]), environment };
}

/** The compose file, or nothing — Compose fails on a missing one far better. */
async function composeFile(dir: string): Promise<string> {
  try {
    return await readFile(join(dir, COMPOSE_FILE), "utf8");
  } catch {
    return "";
  }
}

export async function compose(
  { dir, stream = false, profiles: override }: ComposeOptions,
  ...args: string[]
): Promise<Result> {
  const { profiles, environment } = await invocation(dir, override);

  return run("docker", ["compose", "-f", COMPOSE_FILE, ...profiles, ...args], {
    cwd: dir,
    stdio: stream ? "inherit" : "pipe",
    env: environment,
  });
}

/** `compose`, but a non-zero exit is an error rather than a result to inspect. */
export async function composeOrThrow(
  options: ComposeOptions,
  ...args: string[]
): Promise<Result> {
  const result = await compose(options, ...args);

  if (result.exitCode !== 0) {
    throw new DockerError(
      `docker compose ${args.join(" ")} failed`,
      `${result.stderr ?? ""}`.trim() || undefined,
    );
  }

  return result;
}

/**
 * The Compose project name — the namespace for this deployment's containers.
 *
 * Asked of Compose rather than assumed. `deploy/firetower.yml` pins `name:
 * firetower` precisely so it does not follow the directory, and a deployment
 * made before that pin, or one somebody renamed, would answer differently. The
 * label below is the only way to find a container Compose no longer manages,
 * so getting this wrong means finding none.
 */
export async function projectName(options: ComposeOptions): Promise<string | null> {
  const result = await compose(options, "config", "--format", "json");

  if (result.exitCode === 0) {
    try {
      const { name } = JSON.parse(String(result.stdout)) as { name?: string };
      if (name) return name;
    } catch {
      // Fall through to the file.
    }
  }

  // Compose refusing to interpolate the file is not a reason to give up: the
  // project name is a literal in it, and reading it directly is exact.
  const match = /^name:\s*(\S+)\s*$/m.exec(await composeFile(options.dir));
  return match?.[1] ?? null;
}

export interface ProjectContainer {
  name: string;
  /** The service it was created for, or "" once that service is gone. */
  service: string;
  /** Host ports it publishes. */
  ports: number[];
}

/** Every container in this deployment's project, running or not, orphans too. */
export async function projectContainers(options: ComposeOptions): Promise<ProjectContainer[]> {
  const project = await projectName(options);
  if (!project) return [];

  const result = await run("docker", [
    "ps",
    "--all",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--format",
    '{{.Names}}\t{{.Label "com.docker.compose.service"}}\t{{.Ports}}',
  ]);
  if (result.exitCode !== 0) return [];

  return String(result.stdout)
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [name = "", service = "", ports = ""] = line.split("\t");
      return { name, service, ports: hostPorts(ports) };
    });
}

/**
 * The host side of `docker ps`'s port column.
 *
 * `0.0.0.0:80->80/tcp, 443/udp, 2019/tcp` — only the mappings have a host port,
 * and only those hold anything. The rest is what the image exposes, which binds
 * nothing on this machine.
 */
export function hostPorts(column: string): number[] {
  const found = new Set<number>();

  for (const [, port] of column.matchAll(/(?:[\d.]+|\[[^\]]+\]):(\d+)->/g)) {
    if (port) found.add(Number(port));
  }

  return [...found];
}

/**
 * Containers in this project that the compose file no longer accounts for.
 *
 * Compose neither creates nor stops these. A service moved behind a profile is
 * the case that matters: `caddy` went behind `tls`, so an upgrade leaves the
 * old one running and still holding 80 and 443 — and the new control plane
 * fails to bind against a container from the release it just replaced.
 *
 * `expected` is the services that will exist, profiles already applied.
 */
export async function orphans(
  options: ComposeOptions,
  expected: string[],
): Promise<ProjectContainer[]> {
  const wanted = new Set(expected);

  return (await projectContainers(options)).filter(
    (container) => !wanted.has(container.service),
  );
}

export interface Container {
  Service: string;
  State: string;
  Health: string;
}

export async function ps(options: ComposeOptions): Promise<Container[]> {
  const result = await compose(options, "ps", "--format", "json");
  if (result.exitCode !== 0) return [];

  // Compose emits one JSON object per line, not an array.
  return String(result.stdout)
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Container);
}

/**
 * Wait for a service to report healthy.
 *
 * `healthy` and not merely `running`: the control plane runs migrations before
 * it answers, and a caller that continued on `running` would query a database
 * that is still being changed under it.
 */
export async function waitForHealthy(
  options: ComposeOptions,
  service: string,
  timeoutMs = 180_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const container = (await ps(options)).find((c) => c.Service === service);

    if (container?.Health === "healthy") return;
    if (container?.State === "exited") {
      throw new DockerError(`${service} exited while starting`, logsCommand(options, service));
    }

    if (Date.now() > deadline) {
      throw new DockerError(
        `${service} did not become healthy within ${Math.round(timeoutMs / 1000)}s`,
        logsCommand(options, service),
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/**
 * What to type to see why, in a deployment that has just refused to start.
 *
 * `firetower logs` rather than the `docker compose` line this used to print.
 * The CLI's own command works in every shape — including the default one,
 * where a bare `docker compose` in this directory stops on the proxy's
 * required DOMAIN before it reads a single log line. See `invocation`.
 */
function logsCommand({ dir }: ComposeOptions, service: string): string {
  return `firetower --dir ${dir} logs ${service}`;
}

/** What the running control plane says its version is. */
export async function deployedVersion(
  options: ComposeOptions,
  service = "firetower",
): Promise<string | null> {
  const result = await compose(options, "exec", "-T", service, "firetower", "--version");
  if (result.exitCode !== 0) return null;

  // clap prints `firetower 0.4.0`.
  const match = /(\d+\.\d+\.\d+)/.exec(String(result.stdout));
  return match?.[1] ?? null;
}

/** Whether a plain (non-compose) container exists on this machine. */
export async function containerExists(name: string): Promise<boolean> {
  const result = await run("docker", [
    "ps",
    "-a",
    "--filter",
    `name=^/${name}$`,
    "--format",
    "{{.Names}}",
  ]);

  return result.exitCode === 0 && String(result.stdout).trim() === name;
}

export async function docker(...args: string[]): Promise<Result> {
  return run("docker", args);
}

export async function dockerStreaming(...args: string[]): Promise<Result> {
  return run("docker", args, { stdio: "inherit" });
}
