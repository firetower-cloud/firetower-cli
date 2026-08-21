#!/usr/bin/env node
import { Command, Option } from "commander";
import * as docker from "./docker.js";
import { findDeployment } from "./config.js";
import { cliVersion } from "./version.js";
import { install } from "./commands/install.js";
import { upgrade } from "./commands/upgrade.js";
import { status } from "./commands/status.js";
import { doctor } from "./commands/doctor.js";
import * as lifecycle from "./commands/lifecycle.js";
import * as worker from "./commands/worker/index.js";
import { ui, pc } from "./ui.js";

const program = new Command();

program
  .name("firetower")
  .description("Install, upgrade and inspect a Firetower deployment.")
  .addOption(
    new Option("--dir <path>", "the deployment directory").env("FIRETOWER_DIR"),
  )
  .option("--json", "machine-readable output on stdout")
  .option("-y, --yes", "take the defaults and ask nothing")
  .helpOption("-h, --help", "show this")
  .addHelpText(
    "after",
    `
Docs: https://usefiretower.com/docs`,
  );

/** Global flags belong to the program, not to each subcommand. */
const globals = () => program.opts<{ dir?: string; json?: boolean; yes?: boolean }>();

program
  .command("install")
  .description("install the control plane on this machine")
  .option("--domain <domain>", "the domain to serve on; omit for plain HTTP on port 80")
  .option("--admin-username <name>", "the first administrator", "admin")
  .option("--acme-email <email>", "where Let's Encrypt sends renewal warnings")
  .action(async (options) => {
    const { dir, yes } = globals();
    await install({
      dir,
      yes,
      domain: options.domain,
      adminUsername: options.adminUsername,
      acmeEmail: options.acmeEmail,
    });
  });

program
  .command("upgrade")
  .description("upgrade the control plane, then report which workers lag")
  .option("--no-backup", "skip the database backup")
  .action(async (options) => {
    const { dir, yes } = globals();
    await upgrade({ dir, yes, backup: options.backup });
  });

program
  .command("status")
  .description("version, health, hosts and worker drift")
  .action(async () => {
    const { dir, json } = globals();
    await status({ dir, json });
  });

program
  .command("doctor")
  .description("diagnose a deployment that isn't working")
  .action(async () => {
    const { dir, json } = globals();
    await doctor({ dir, json });
  });

program
  .command("logs")
  .description("tail the control plane")
  .argument("[service]", "one service, or all of them")
  .option("-f, --follow", "keep printing")
  .action(async (service, options) => {
    await lifecycle.logs({ dir: globals().dir, follow: options.follow, service });
  });

program.command("start").description("start a stopped deployment")
  .action(async () => lifecycle.start({ dir: globals().dir }));

program.command("stop").description("stop it, keeping every volume")
  .action(async () => lifecycle.stop({ dir: globals().dir }));

program.command("restart").description("restart it")
  .action(async () => lifecycle.restart({ dir: globals().dir }));

program
  .command("backup")
  .description("pg_dump plus the root key")
  .option("--out <dir>", "where to write it")
  .action(async (options) => lifecycle.backup({ dir: globals().dir, out: options.out }));

program
  .command("uninstall")
  .description("tear it down, asking separately about the volumes")
  .action(async () => lifecycle.uninstall({ dir: globals().dir, yes: globals().yes }));

const workers = program
  .command("worker")
  .description("the worker, on the machine it runs on");

workers
  .command("install")
  .description("install a worker on this machine")
  .option("--container <name>", "what to call it", "firetower-worker")
  .action(async (options) => worker.install({ container: options.container }));

workers
  .command("upgrade")
  .description("upgrade this machine's worker, once its host is drained")
  .option("--container <name>", "which container", "firetower-worker")
  .action(async (options) =>
    worker.upgrade({ container: options.container, yes: globals().yes }),
  );

workers
  .command("status")
  .description("what this machine's worker is running")
  .option("--container <name>", "which container", "firetower-worker")
  .action(async (options) =>
    worker.status({ container: options.container, json: globals().json }),
  );

/**
 * `--version` answers two questions, because there are two versions and
 * confusing them is how somebody upgrades the CLI and wonders why nothing
 * changed.
 *
 * Both a flag and a command: `--version` is what people type, and `version` is
 * what they type when the flag did not occur to them.
 */
program.option("-v, --version", "this CLI's version, and the deployed one");

program
  .command("version")
  .description("this CLI's version, and the deployed one")
  .action(printVersion);

/** Reached when no subcommand was given — either `--version`, or nothing. */
program.action(async () => {
  if (program.opts().version) await printVersion();
  else program.help();
});

async function printVersion(): Promise<void> {
  const cli = await cliVersion();
  const dir = await findDeployment(globals().dir);
  const deployed = dir ? await docker.deployedVersion({ dir }) : null;

  if (globals().json) {
    ui.json({ cli, deployment: deployed, dir });
    return;
  }

  ui.blank();
  ui.step(`${pc.bold("@firetower/cli")}  ${cli}`);

  if (deployed) ui.step(`${pc.bold("firetower")}       ${deployed}   ${pc.dim(dir ?? "")}`);
  else ui.dim("no deployment found on this machine");

  ui.blank();
}

async function main(): Promise<void> {
  await program.parseAsync();
}

main().catch((error: unknown) => {
  ui.blank();

  if (error instanceof docker.DockerError) {
    ui.fail(error.message, error.remedy);
  } else {
    ui.fail((error as Error).message ?? String(error));
  }

  ui.blank();
  process.exit(1);
});
