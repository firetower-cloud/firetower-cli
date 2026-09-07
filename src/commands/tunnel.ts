import { execa } from "execa";
import * as env from "../env.js";
import { tunnelCommand } from "../shape.js";
import { ui, pc } from "../ui.js";

/**
 * Reaching a control plane that is on loopback, from the machine you sit at.
 *
 * This is the only command in the CLI that runs somewhere other than the
 * machine Firetower is installed on, and that shapes all of it. There is no
 * install directory here, no `.env` and no Docker — so the port cannot be read
 * locally, and is fetched over the same ssh connection that is about to
 * forward it.
 *
 * It is a convenience and never a requirement. `install` prints the plain ssh
 * command too, because needing Node on your laptop to read a dashboard would
 * be a worse trade than typing one long line.
 */

export interface TunnelOptions {
  /** `user@host`, or anything else ssh understands, including a config alias. */
  destination: string;
  /** When the port is taken on this machine, or the guess is wrong. */
  localPort?: number;
  /** Skip the lookup and use this. */
  remotePort?: number;
  /** Print the ssh config stanza instead of connecting. */
  sshConfig?: boolean;
}

/** Where `install` puts things, in the order it would have chosen them. */
const CANDIDATES = ["/opt/firetower", "~/firetower"];

function stop(message: string, remedy?: string): never {
  ui.blank();
  ui.fail(message, remedy);
  ui.blank();
  process.exit(1);
}

/**
 * The port the remote control plane publishes, read from its own `.env`.
 *
 * `cat`, rather than anything cleverer: this has to work against a machine
 * with no Firetower CLI on it, which is most of them — the CLI is installed
 * where Firetower runs, not where it is read from.
 */
async function remotePortOf(destination: string): Promise<number | null> {
  const script = CANDIDATES.map((dir) => `cat ${dir}/.env 2>/dev/null`).join("; ");

  const result = await execa("ssh", [destination, script], { reject: false });
  if (result.exitCode !== 0) {
    stop(
      `could not reach ${destination}`,
      String(result.stderr).trim().split("\n").at(-1) ?? "check the destination and your key",
    );
  }

  const values = env.parse(String(result.stdout));
  const port = Number(values.HTTP_PORT);

  // An install that took the default writes no HTTP_PORT at all, and the
  // compose file's own default is what is running. Say so rather than guess.
  return Number.isInteger(port) && port > 0 ? port : null;
}

/** The default in the compose file, for an install that never moved it. */
const COMPOSE_DEFAULT_PORT = 8080;

export async function tunnel(options: TunnelOptions): Promise<void> {
  const remote = options.remotePort ?? (await remotePortOf(options.destination));

  if (remote === null) {
    ui.warn(
      `no HTTP_PORT in the .env on ${options.destination}`,
      `assuming ${COMPOSE_DEFAULT_PORT}, which is the compose file's default — use --remote-port if it is not`,
    );
  }

  const remotePort = remote ?? COMPOSE_DEFAULT_PORT;
  const localPort = options.localPort ?? remotePort;

  if (options.sshConfig) {
    printStanza(options.destination, localPort, remotePort);
    return;
  }

  ui.blank();
  ui.ok("control plane", `${options.destination}, on ${remotePort}`);
  ui.blank();
  ui.step(pc.bold(`  http://localhost:${localPort}`));
  ui.blank();
  ui.step("  Ctrl-C to close the tunnel.");
  ui.blank();

  // Inherited rather than captured, and awaited rather than detached: ssh owns
  // the terminal so that a passphrase or a 2FA prompt reaches the operator,
  // and Ctrl-C closes the forward rather than orphaning it.
  const result = await execa(
    "ssh",
    [
      "-N",
      "-L",
      `${localPort}:127.0.0.1:${remotePort}`,
      "-o",
      "ServerAliveInterval=20",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "ExitOnForwardFailure=yes",
      options.destination,
    ],
    { stdio: "inherit", reject: false },
  );

  // Ctrl-C is how this command is *supposed* to end, so it is not a failure.
  // Both spellings, because whether it arrives as a signal or as ssh's own
  // exit status depends on how the terminal delivered it.
  const interrupted =
    result.signal === "SIGINT" || result.signal === "SIGTERM" || result.exitCode === 130;
  if (result.exitCode === 0 || interrupted) return;

  stop(
    "the tunnel closed",
    localPort < 1024
      ? `a forward onto ${localPort} needs root on this machine — try --local-port 8080`
      : `something may already be answering on ${localPort} here — try --local-port`,
  );
}

/**
 * What people actually want once they have done this twice.
 *
 * With this in `~/.ssh/config` the forward comes up with any ordinary `ssh`
 * to that host, and stays out of the way.
 */
function printStanza(destination: string, localPort: number, remotePort: number): void {
  const [user, host] = destination.includes("@")
    ? destination.split("@", 2)
    : [null, destination];

  ui.blank();
  ui.step("Add this to ~/.ssh/config:");
  ui.blank();
  ui.dim(`  Host ${host}`);
  ui.dim(`    HostName ${host}`);
  if (user) ui.dim(`    User ${user}`);
  ui.dim(`    LocalForward ${localPort} 127.0.0.1:${remotePort}`);
  ui.dim(`    ServerAliveInterval 20`);
  ui.dim(`    ServerAliveCountMax 3`);
  ui.dim(`    ExitOnForwardFailure yes`);
  ui.blank();
  ui.step(`Then \`ssh ${host}\` brings up http://localhost:${localPort} with it.`);
  ui.blank();

  // Only when the two sides match: `tunnelCommand` is symmetric by
  // construction, so printing it beside an asymmetric stanza would be
  // printing something that does not do what the stanza above it does.
  if (localPort === remotePort) {
    ui.step("Without this CLI on hand, the one-liner is:");
    ui.blank();
    ui.dim(`  ${tunnelCommand(remotePort, destination)}`);
    ui.blank();
  }
}
