import { execa } from "execa";
import * as prompts from "@clack/prompts";
import { fileURLToPath } from "node:url";
import * as upstream from "./upstream.js";
import { cliVersion, compare } from "./version.js";
import { ui, pc } from "./ui.js";

/**
 * Is this CLI new enough to be doing this?
 *
 * The CLI fetches the compose file from the latest release rather than
 * carrying one, so a release can change what a deployment needs without any
 * commit here. Almost always that is fine — the file is written verbatim. When
 * it is not, the release says so in `deploy/cli.json`, and this refuses to go
 * on.
 *
 * The refusal is the point. A CLI one version behind a breaking change does
 * not fail cleanly: it writes a `.env` missing a variable Compose now requires,
 * or waits on a service that has been renamed, and the operator reads an error
 * about neither.
 */

const PACKAGE = "@firetower/cli";

/** Set on the child after a self-upgrade, so a failed upgrade cannot loop. */
const REENTRY = "FIRETOWER_CLI_UPGRADED";

async function publishedVersion(): Promise<string | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;

    return ((await response.json()) as { version?: string }).version ?? null;
  } catch {
    // Offline is not a reason to refuse to work.
    return null;
  }
}

/**
 * How this was installed, so the upgrade command is the one that will work.
 *
 * `npm i -g` into a pnpm-managed global directory produces two installs and a
 * confusing `--version`.
 */
function upgradeCommand(): { command: string; args: string[] } {
  const here = fileURLToPath(import.meta.url);

  if (here.includes("/pnpm/") || here.includes("\\pnpm\\")) {
    return { command: "pnpm", args: ["add", "-g", `${PACKAGE}@latest`] };
  }

  if (here.includes("/.bun/") || here.includes("/yarn/")) {
    return { command: "npm", args: ["i", "-g", `${PACKAGE}@latest`] };
  }

  return { command: "npm", args: ["i", "-g", `${PACKAGE}@latest`] };
}

export function upgradeLine(): string {
  const { command, args } = upgradeCommand();
  return `${command} ${args.join(" ")}`;
}

/**
 * Upgrade, then run what was asked for on the new version.
 *
 * Re-executing rather than continuing: the code that would carry on is the old
 * code, which is the thing we just decided was too old.
 */
async function upgradeAndRerun(): Promise<never> {
  const { command, args } = upgradeCommand();

  ui.step(`Running ${pc.bold(`${command} ${args.join(" ")}`)}`);
  const install = await execa(command, args, { stdio: "inherit", reject: false });

  if (install.exitCode !== 0) {
    ui.blank();
    ui.fail(
      "the upgrade failed",
      `run it yourself: ${upgradeLine()}${
        install.exitCode === 243 || `${install.stderr ?? ""}`.includes("EACCES")
          ? " (this global directory needs sudo)"
          : ""
      }`,
    );
    ui.blank();
    process.exit(1);
  }

  ui.blank();
  ui.ok("upgraded", "re-running your command");
  ui.blank();

  const rerun = await execa("firetower", process.argv.slice(2), {
    stdio: "inherit",
    reject: false,
    env: { ...process.env, [REENTRY]: "1" },
  });

  process.exit(rerun.exitCode ?? 1);
}

export type Verdict =
  | { kind: "ok" }
  | { kind: "behind"; published: string }
  | { kind: "blocked"; minimum: string; reason?: string };

/**
 * The decision, with no network and no process in it.
 *
 * Separated from `gate` so the interesting part — what counts as too old — is
 * testable without a registry, a release, or a global install to upgrade.
 */
export function decide(
  current: string,
  published: string | null,
  required: upstream.Requirements | null,
): Verdict {
  const minimum = required?.minimumCli;

  // The hard stop wins: being behind the registry matters less than being
  // behind what the release you are about to install actually requires.
  if (minimum && compare(current, minimum) < 0) {
    return { kind: "blocked", minimum, reason: required?.reason };
  }

  if (published && compare(current, published) < 0) {
    return { kind: "behind", published };
  }

  return { kind: "ok" };
}

export interface GateOptions {
  /** Ask nothing. A blocked run still fails; it just does not offer. */
  yes?: boolean;
  /** For working offline, and for developing this. */
  skip?: boolean;
}

/**
 * Run before anything that writes or upgrades a deployment.
 *
 * Two outcomes and no third: blocked, or a note that there is a newer version.
 * Being unable to reach either the registry or GitHub is neither — it says
 * nothing and carries on.
 */
export async function gate(options: GateOptions = {}): Promise<void> {
  if (options.skip || process.env[REENTRY] === "1") return;

  const [current, published, required] = await Promise.all([
    cliVersion(),
    publishedVersion(),
    upstream.requirements(),
  ]);

  const verdict = decide(current, published, required);

  if (verdict.kind === "blocked") {
    ui.notice([
      pc.yellow(`This CLI is ${current}. The current Firetower release needs ${verdict.minimum}.`),
      "",
      ...(verdict.reason ? [verdict.reason, ""] : []),
      "Going on would write a deployment this CLI does not understand, and",
      "the error you got would be about neither.",
      "",
      `  ${pc.bold(upgradeLine())}`,
    ]);

    if (options.yes) process.exit(1);

    const upgrade = await prompts.confirm({ message: "Upgrade now?" });
    if (prompts.isCancel(upgrade) || !upgrade) process.exit(1);

    await upgradeAndRerun();
  }

  if (verdict.kind === "behind") {
    ui.warn(`${PACKAGE} ${verdict.published} is out; this is ${current}`, upgradeLine());
    ui.blank();
  }
}
