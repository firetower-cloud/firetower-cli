import { execa, type Options, type Result } from "execa";
import { createConnection } from "node:net";

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
}

export async function compose(
  { dir, stream = false }: ComposeOptions,
  ...args: string[]
): Promise<Result> {
  return run("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
    cwd: dir,
    stdio: stream ? "inherit" : "pipe",
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
      throw new DockerError(
        `${service} exited while starting`,
        `docker compose -f ${COMPOSE_FILE} logs ${service}`,
      );
    }

    if (Date.now() > deadline) {
      throw new DockerError(
        `${service} did not become healthy within ${Math.round(timeoutMs / 1000)}s`,
        `docker compose -f ${COMPOSE_FILE} logs ${service}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/** What the running control plane says its version is. */
export async function deployedVersion(options: ComposeOptions): Promise<string | null> {
  const result = await compose(options, "exec", "-T", "firetower", "firetower", "--version");
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
