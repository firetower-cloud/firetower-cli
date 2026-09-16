#!/usr/bin/env node
import { Command, Option, InvalidArgumentError } from "commander";
import * as docker from "./docker.js";
import { findDeployment } from "./config.js";
import { cliVersion } from "./version.js";
import { gate } from "./selfcheck.js";
import { install } from "./commands/install.js";
import { domain } from "./commands/domain.js";
import { upgrade } from "./commands/upgrade.js";
import { status } from "./commands/status.js";
import { doctor } from "./commands/doctor.js";
import * as lifecycle from "./commands/lifecycle.js";
import { resolveProvider } from "./shape.js";
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
  .option("--skip-version-check", "do not ask whether this CLI is current")
  .helpOption("-h, --help", "show this")
  .addHelpText(
    "after",
    `
Docs: https://usefiretower.com/docs`,
  );

/** Global flags belong to the program, not to each subcommand. */
const globals = () =>
  program.opts<{
    dir?: string;
    json?: boolean;
    yes?: boolean;
    skipVersionCheck?: boolean;
  }>();

/**
 * Before anything that writes or upgrades a deployment.
 *
 * Not before `status`, `logs` or `doctor`: those answer questions about what is
 * already there, and an old CLI reading a deployment is a far smaller problem
 * than an old CLI writing one.
 */
const checkVersion = () =>
  gate({ yes: globals().yes, skip: globals().skipVersionCheck });

/** A port, refused here rather than three screens into an install. */
const port = (value: string): number => {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new InvalidArgumentError("a port between 1 and 65535");
  }

  return parsed;
};

/**
 * A provider name, checked before commander hands it on.
 *
 * The value is compiled into Caddy, so an unchecked typo is not a bad
 * credential — it is `go: module github.com/caddy-dns/cloudflares: not found`,
 * minutes into a build. `resolveProvider` knows every caddy-dns module and
 * suggests the closest one.
 */
const dnsProvider = (value: string): string => {
  const resolved = resolveProvider(value);
  if ("problem" in resolved) throw new InvalidArgumentError(resolved.problem);

  return resolved.provider;
};

program
  .command("install")
  .description("install the control plane on this machine")
  .option("--domain <domain>", "serve on this name, over HTTPS")
  .option(
    "--dns-provider <module>",
    "obtain the certificate over DNS-01 with this caddy-dns module, e.g. cloudflare",
    dnsProvider,
  )
  .option("--dns-token <token>", "API token for --dns-provider")
  .option("--https-bind <address>", "the address Caddy listens on, with --domain")
  .option(
    "--advertise <address>",
    "the address people reach it on, when it is not the one it listens on — behind NAT, a floating IP or a load balancer",
  )
  .option("--http-port <port>", "publish the control plane here instead of 8080", port)
  .option("--https-port <port>", "publish Caddy here instead of 443, with --domain", port)
  .option("--admin-username <name>", "the first administrator", "admin")
  .option("--acme-email <email>", "contact address recorded for the proxy")
  // Hidden: installing an old release on purpose is not something to offer, but
  // it is the only way to test an upgrade *from* one. See upgrade.e2e.test.ts.
  .addOption(new Option("--tag <tag>", "install this release instead of the latest").hideHelp())
  .action(async (options) => {
    await checkVersion();
    const { dir, yes } = globals();
    await install({
      dir,
      yes,
      domain: options.domain,
      httpPort: options.httpPort,
      httpsPort: options.httpsPort,
      adminUsername: options.adminUsername,
      acmeEmail: options.acmeEmail,
      dnsProvider: options.dnsProvider,
      dnsToken: options.dnsToken,
      httpsBind: options.httpsBind,
      advertise: options.advertise,
      tag: options.tag,
    });
  });

/**
 * Gone, and named rather than merely absent.
 *
 * It forwarded a control plane published on loopback, which is no longer a
 * shape this CLI installs. Removing the command outright would meet anybody
 * with it in a script or an ssh alias as `error: unknown command`, which says
 * nothing about what happened or what to do instead. Kept as a refusal for a
 * release or two.
 */
program
  .command("tunnel", { hidden: true })
  .argument("[destination]")
  .allowUnknownOption()
  .action(() => {
    ui.blank();
    ui.fail(
      "`firetower tunnel` is gone",
      "it forwarded a control plane on loopback, and that shape no longer installs. Reach this deployment on its domain.",
    );
    ui.blank();
    process.exit(1);
  });

program
  .command("domain")
  .description("change how an existing deployment is reached")
  .argument("[domain]", "serve on this name, over HTTPS")
  .option(
    "--dns-provider <module>",
    "obtain the certificate over DNS-01 with this caddy-dns module, e.g. cloudflare",
    dnsProvider,
  )
  .option("--dns-token <token>", "API token for --dns-provider")
  .option("--https-bind <address>", "the address Caddy listens on")
  .option(
    "--advertise <address>",
    "the address people reach it on, when it is not the one it listens on",
  )
  .action(async (name, options) => {
    const { dir, yes } = globals();
    await domain({
      dir,
      yes,
      domain: name,
      dnsProvider: options.dnsProvider,
      dnsToken: options.dnsToken,
      httpsBind: options.httpsBind,
      advertise: options.advertise,
    });
  });

program
  .command("upgrade")
  .description("upgrade the control plane, then report which workers lag")
  .option("--no-backup", "skip the database backup")
  // `upgrade` re-derives which port the control plane is published on, the
  // same way `install` chooses one. This is for the machine where the derived
  // answer is wrong and there is nobody there to answer the prompt.
  .option("--http-port <port>", "publish the control plane here instead of 8080", port)
  .action(async (options) => {
    await checkVersion();
    const { dir, yes } = globals();
    await upgrade({ dir, yes, backup: options.backup, httpPort: options.httpPort });
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
