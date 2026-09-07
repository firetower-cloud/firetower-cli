import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import * as prompts from "@clack/prompts";
import * as docker from "../docker.js";
import * as env from "../env.js";
import * as upstream from "../upstream.js";
import { machineChecks } from "../checks/machine.js";
import { runChecks, worst } from "../checks/index.js";
import { defaultInstallDir, rememberDir } from "../config.js";
import { invent } from "../password.js";
import * as services from "../services.js";
import { missingVariables } from "../deployment.js";
import {
  cancelled,
  certificate,
  choosePorts,
  derive,
  published,
  publicUrl,
  stop,
  tunnelCommand,
  type Ports,
  type Reach,
} from "../shape.js";
import { ui, pc } from "../ui.js";

/**
 * `install` asks the questions; `shape.ts` turns the answers into a `.env`.
 *
 * Re-exported because `upgrade` derives the same values without asking
 * anything, and the two commands agreeing about what a deployment looks like is
 * the whole reason that module exists.
 */
export { publicUrl, certificate, published, tunnelCommand, type Reach };

export interface InstallOptions {
  dir?: string;
  domain?: string;
  publicUrl?: string;
  httpPort?: number;
  httpsPort?: number;
  adminUsername?: string;
  acmeEmail?: string;
  yes?: boolean;
  /** Install this release rather than the latest. For reproducing a report. */
  tag?: string;
}

export async function install(options: InstallOptions): Promise<void> {
  ui.title("Firetower");

  const dir = options.dir ?? (options.yes ? defaultInstallDir() : null);

  // Before anything is asked, so a machine that cannot host this says so
  // before the operator has answered a page of questions.
  if (dir && (await exists(join(dir, docker.COMPOSE_FILE)))) {
    stop(`Firetower is already installed in ${dir}. Use \`firetower upgrade\`.`);
  }

  const reach = await askReach(options);

  // Fetched before the machine is checked, rather than after. Which ports to
  // check is the next question, and this file is what says whether they can be
  // moved at all.
  ui.blank();
  ui.step("Fetching the deployment files");
  const files = await upstream.deployment({ tag: options.tag });

  if (files.tag) {
    ui.ok("firetower.yml", `firetower-cloud/firetower @ ${files.tag}`);
    ui.ok("Caddyfile", `firetower-cloud/firetower @ ${files.tag}`);
  } else {
    ui.warn("using the bundled deployment files", "github was unreachable; they may be older");
  }

  const ports = await choosePorts(reach, files.compose, options);

  ui.blank();
  ui.step("Checking this machine");
  const results = await runChecks(
    machineChecks.filter((c) => c.preflight),
    {
      dir: dir ?? process.cwd(),
      domain: reach.kind === "domain" ? reach.domain : null,
      httpPort: ports.http,
      httpsPort: ports.https,
    },
  );

  for (const result of results) {
    if (result.status === "ok") ui.ok(result.name, result.detail);
    else if (result.status === "warn") ui.warn(`${result.name}  ${result.detail}`, result.remedy);
    else ui.fail(`${result.name}  ${result.detail}`, result.remedy);
  }

  if (worst(results) === "fail" && !options.yes) {
    const proceed = await prompts.confirm({
      message: "Some checks failed. Install anyway?",
      initialValue: false,
    });
    if (cancelled(proceed) || !proceed) stop("Nothing was written.");
  }

  const directory = dir ?? (await askDirectory());
  const admin = await askAdmin(options);

  ui.blank();
  ui.step("Generating secrets");
  const secrets = {
    POSTGRES_PASSWORD: env.generatePassword(),
    FIRETOWER_ROOT_KEY: env.generateRootKey(),
  };
  ui.ok("database password");
  ui.ok("root key", "32 bytes, base64");

  const values: env.Env = {
    // The shape — reach, ports, profiles, the URL — from the one place that
    // knows how to work it out. `upgrade` calls the same function against the
    // release it is moving to, which is what keeps the two from drifting.
    ...derive(reach, ports),
    ...secrets,
    ADMIN_USERNAME: admin.username,
    ADMIN_INITIAL_PASSWORD: admin.password,
  };

  ui.blank();
  ui.step("Here is what I will do:");
  ui.blank();
  ui.dim(`directory     ${directory}`);
  ui.dim(`url           ${values.FIRETOWER_PUBLIC_URL}`);
  ui.dim(`published     ${published(reach, ports)}`);
  ui.dim(`certificate   ${certificate(reach)}`);
  ui.dim(`admin         ${admin.username}, with the password shown once below`);
  ui.dim(`root key      generated, written to ${join(directory, ".env")}`);
  ui.blank();

  // Compose refuses to start without these, with an error naming a variable
  // the operator has never heard of. Say it properly instead.
  const missing = missingVariables(files.compose, values);
  if (missing.length > 0) {
    ui.blank();
    ui.fail(
      `this release needs ${missing.join(", ")}, which this CLI does not write`,
      "upgrade the CLI: npm i -g @firetower/cli@latest",
    );
    ui.blank();
    process.exit(1);
  }

  if (!options.yes) {
    const proceed = await prompts.confirm({ message: "Continue?" });
    if (cancelled(proceed) || !proceed) stop("Nothing was written.");
  }

  await write(directory, files, values, options.acmeEmail ?? null);
  await requireCertificate(directory, reach);
  await start(directory, files.compose);
  await backUpTheKey(secrets.FIRETOWER_ROOT_KEY, directory, options);
  await rememberDir(directory);

  finish(values, admin, reach, ports);
}

/**
 * The one thing the `domain` shape needs that this CLI cannot generate.
 *
 * Checked after the files are written, so the operator has somewhere to put
 * the certificate and a Caddyfile explaining where to get one — and before
 * anything is pulled or started, so the failure is a sentence rather than a
 * container restarting forever.
 */
async function requireCertificate(directory: string, reach: Reach): Promise<void> {
  if (reach.kind !== "domain") return;

  const certs = join(directory, "certs");
  const wanted = ["fullchain.pem", "privkey.pem"];
  const missing: string[] = [];

  for (const file of wanted) {
    if (!(await exists(join(certs, file)))) missing.push(file);
  }

  if (missing.length === 0) {
    ui.ok("certificate", `${wanted.join(" and ")} in ${certs}`);
    return;
  }

  ui.blank();
  ui.warn(
    `${certs} has no ${missing.join(" or ")}`,
    "Caddy will not start without them. See the Caddyfile for how to get a certificate for a name the internet cannot reach — it has to cover both the name and *.the-name.",
  );
  ui.blank();
  ui.step("Everything is written. Put the two files in place, then:");
  ui.blank();
  ui.dim(`  cd ${directory} && docker compose -f ${docker.COMPOSE_FILE} --profile tls up -d`);
  ui.blank();

  process.exit(1);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first question, and the one the rest of the install reads.
 *
 * Three answers rather than yes-or-no, because "yes, a domain" used to mean two
 * things that need different deployments. Somebody who already runs nginx on 80
 * has a domain *and* cannot give Caddy the ports a certificate needs, and until
 * there was a third answer this CLI had nothing to offer them.
 *
 * None of the three publishes the control plane to the internet, and that is
 * not an omission. It holds every git token, every agent credential and the
 * root key; whoever reaches it can erase the codebase of the company that
 * installed it. `domain` used to mean "let Caddy get a certificate from Let's
 * Encrypt", which required exactly that exposure — and issued one certificate
 * per preview hostname, publishing each to Certificate Transparency logs even
 * though a preview hostname *is* the credential for that preview. It now means
 * a certificate the operator supplies, for a name the internet need never
 * reach.
 *
 * Each flag names exactly one of the three, so there is no combination to
 * reconcile.
 */
async function askReach(options: InstallOptions): Promise<Reach> {
  if (options.domain) return { kind: "domain", domain: options.domain.trim() };
  if (options.publicUrl) return { kind: "proxy", publicUrl: trimUrl(options.publicUrl) };

  // `--domain ""` is how a script says "no domain", and has always meant that.
  if (options.domain === "" || options.yes) return { kind: "local" };

  const choice = await prompts.select({
    message: "How will people reach this Firetower?",
    options: [
      {
        value: "local",
        label: "Only from this machine, over an ssh tunnel  (recommended)",
      },
      {
        value: "domain",
        label: "On a name, over HTTPS — with a certificate I supply",
      },
      { value: "proxy", label: "Behind a reverse proxy I already run" },
    ],
  });
  if (cancelled(choice)) stop("Nothing was written.");

  if (choice === "local") return { kind: "local" };

  if (choice === "domain") {
    const domain = await prompts.text({
      message: "Domain",
      placeholder: "firetower.example.com",
      validate: (value) =>
        value.trim() ? undefined : "A domain, or go back and choose another answer",
    });
    if (cancelled(domain)) stop("Nothing was written.");

    return { kind: "domain", domain: String(domain).trim() };
  }

  // Asked rather than worked out. With their proxy in front, nothing here can
  // know what it serves — and this is the URL printed at the end and carried in
  // every notification.
  const url = await prompts.text({
    message: "What address will people open?",
    placeholder: "https://firetower.example.com",
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return "The address your proxy serves";
      if (!/^https?:\/\/[^/]+/.test(trimmed)) return "Starting with http:// or https://";
      return undefined;
    },
  });
  if (cancelled(url)) stop("Nothing was written.");

  return { kind: "proxy", publicUrl: trimUrl(String(url)) };
}

const trimUrl = (value: string): string => value.trim().replace(/\/+$/, "");

async function askDirectory(): Promise<string> {
  const directory = await prompts.text({
    message: "Where should Firetower live?",
    initialValue: defaultInstallDir(),
  });
  if (cancelled(directory)) stop("Nothing was written.");

  return String(directory).trim();
}

async function askAdmin(
  options: InstallOptions,
): Promise<{ username: string; password: string; generated: boolean }> {
  if (options.yes) {
    return { username: options.adminUsername ?? "admin", password: invent(), generated: true };
  }

  const username = await prompts.text({
    message: "Administrator username",
    initialValue: options.adminUsername ?? "admin",
  });
  if (cancelled(username)) stop("Nothing was written.");

  const choice = await prompts.select({
    message: "Administrator password",
    options: [
      { value: "generate", label: "Generate one for me" },
      { value: "type", label: "Let me type it" },
    ],
  });
  if (cancelled(choice)) stop("Nothing was written.");

  if (choice === "generate") {
    return { username: String(username).trim(), password: invent(), generated: true };
  }

  // Whatever they write is accepted, however short. This one is temporary by
  // construction — the account can do nothing but replace it — and refusing
  // over a value in a file is a worse failure than the weak password it would
  // be guarding against. The server warns for the same reason.
  const password = await prompts.password({
    message: "Administrator password",
    validate: (value) => (value ? undefined : "It cannot be empty"),
  });
  if (cancelled(password)) stop("Nothing was written.");

  return { username: String(username).trim(), password: String(password), generated: false };
}

async function write(
  directory: string,
  files: upstream.Deployment,
  values: env.Env,
  acmeEmail: string | null,
): Promise<void> {
  ui.blank();
  ui.step("Writing");

  await mkdir(directory, { recursive: true });

  const composePath = join(directory, docker.COMPOSE_FILE);
  await writeFile(composePath, files.compose);
  ui.ok(composePath);

  const caddyPath = join(directory, "Caddyfile");
  await writeFile(caddyPath, upstream.withAcmeEmail(files.caddyfile, acmeEmail));
  ui.ok(caddyPath);

  // Made here rather than left to Docker. A bind mount whose source does not
  // exist is created by the daemon, owned by root, and then Caddy fails to
  // find a certificate in it — which reads as a Firetower bug rather than as
  // the missing step it is.
  await mkdir(join(directory, "certs"), { recursive: true });

  // Read first, merge second. A directory that already holds a `.env` keeps
  // every value in it — see env.ts for why this is the one rule here.
  const envPath = join(directory, ".env");
  const existing = (await env.read(envPath)) ?? {};
  const merged = env.merge(existing, values);

  const untouched = env.kept(existing, values);
  await env.write(envPath, merged);
  ui.ok(envPath, "chmod 600");

  if (untouched.length > 0) {
    ui.warn(`kept the existing ${untouched.join(", ")}`, "nothing here regenerates a secret");
  }
}

async function start(directory: string, compose: string): Promise<void> {
  ui.blank();
  ui.step("Starting");

  // Which services these are is read from the file, not assumed. A release
  // that renames one would otherwise leave the wait below spinning for three
  // minutes against a stack that came up perfectly.
  const named = services.resolve(compose);

  await docker.composeOrThrow({ dir: directory, stream: true }, "pull");
  await docker.composeOrThrow({ dir: directory }, "up", "-d");

  await docker.waitForHealthy({ dir: directory }, named.database);
  ui.ok(`${named.database} healthy`);

  await docker.waitForHealthy({ dir: directory }, named.control);
  ui.ok(`${named.control} healthy`);

  const version = await docker.deployedVersion({ dir: directory }, named.control);
  if (version) ui.ok("version", version);
}

/**
 * The only unrecoverable loss in the product, so it is a prompt rather than a
 * printed line somebody scrolls past.
 */
async function backUpTheKey(
  key: string,
  directory: string,
  options: InstallOptions,
): Promise<void> {
  if (options.yes) {
    const path = join(directory, "firetower-root-key.txt");
    await writeFile(path, `${key}\n`, { mode: 0o600 });
    ui.blank();
    ui.warn(`the root key was written to ${path}`, "move it somewhere safe and delete it");
    return;
  }

  ui.notice([
    "Save this. It is not stored anywhere you can read it back.",
    "",
    `  ${pc.bold("FIRETOWER_ROOT_KEY")}  ${key}`,
    "",
    "Every credential Firetower holds is sealed with it. Back it up",
    "somewhere that is not your database backup — a stolen database",
    "opens nothing on its own, and losing this key means adding every",
    "credential again.",
  ]);

  for (;;) {
    const saved = await prompts.confirm({
      message: "I have saved the root key",
      initialValue: false,
    });
    if (cancelled(saved)) stop("Firetower is running, but the root key was not acknowledged.");
    if (saved) return;

    ui.dim("It is in .env, and in the box above. Take a copy before you go on.");
  }
}

function finish(
  values: env.Env,
  admin: { username: string; password: string },
  reach: Reach,
  ports: Ports,
): void {
  ui.blank();
  ui.step(pc.bold("Firetower is running."));
  ui.blank();

  // Nothing on this machine's network answers in the `local` shape, so the URL
  // on its own is not an instruction — it is the second half of one. The step
  // every operator currently works out for themselves, and gets subtly wrong:
  // without the keepalives the forward dies silently on sleep or a network
  // change and does not come back.
  if (reach.kind === "local") {
    ui.step("It is on loopback, so reach it from your own machine with a tunnel:");
    ui.blank();
    ui.dim(`  ${tunnelCommand(ports.http)}`);
    ui.blank();
    ui.step("Then open");
    ui.blank();
  }

  ui.dim(`  ${values.FIRETOWER_PUBLIC_URL}`);
  ui.blank();
  ui.dim(`  username  ${admin.username}`);
  ui.dim(`  password  ${admin.password}`);
  ui.blank();
  ui.step("You will be asked to replace that password when you sign in,");
  ui.step("and then to delete ADMIN_INITIAL_PASSWORD from .env.");
  ui.blank();
  ui.step("Next: add a machine to run agents on. On that machine,");
  ui.blank();
  ui.dim("  npm i -g @firetower/cli && firetower worker install");
  ui.blank();
  ui.step("Then add it in Firetower under Compute → Add compute.");
  ui.blank();
  ui.dim("Docs: https://usefiretower.com/docs");
  ui.blank();
}
