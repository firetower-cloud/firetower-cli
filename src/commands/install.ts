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
import { MULTI_FIELD } from "../providers.js";
import {
  askReach,
  cancelled,
  certificate,
  choosePorts,
  derive,
  published,
  publicUrl,
  stop,
  suppliesOwnCertificate,
  tunnelCommand,
  type Ports,
  type Reach,
  type ReachOptions,
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

export interface InstallOptions extends ReachOptions {
  dir?: string;
  httpPort?: number;
  httpsPort?: number;
  adminUsername?: string;
  acmeEmail?: string;
  /** Install this release rather than the latest. For reproducing a report. */
  tag?: string;
}

export async function install(options: InstallOptions): Promise<void> {
  ui.title("Firetower");

  const dir = options.dir ?? (options.yes ? defaultInstallDir() : null);

  // Before anything is asked, so a machine that cannot host this says so
  // before the operator has answered a page of questions.
  if (dir) await refuseIfInstalled(dir);

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
    ui.ok(
      "Caddyfile.dockerfile",
      files.dockerfileIsBundled
        ? "bundled — this release does not publish one"
        : `firetower-cloud/firetower @ ${files.tag}`,
    );
  } else {
    ui.warn("using the bundled deployment files", "github was unreachable; they may be older");
  }

  refuseIfItCannotIssue(reach, files.compose);

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

  // Again, because the check above only had a directory to test when one was
  // given. Interactively there is none until the question is answered — and
  // without this, `install` into a directory that already holds a deployment
  // walked straight past it and half-reconfigured the thing: `env.merge` fills
  // empty keys, so a loopback install would silently acquire the domain,
  // profile and token just answered, while keeping ports and secrets from the
  // install it was pretending not to be replacing.
  await refuseIfInstalled(directory);
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
    // Optional, and only meaningful where something issues a certificate. It
    // reaches Caddy's global options through the compose file's environment,
    // which is why nothing rewrites the Caddyfile to carry it any more.
    ...(options.acmeEmail && reach.kind === "domain" && !suppliesOwnCertificate(reach)
      ? { ACME_EMAIL: options.acmeEmail }
      : {}),
  };

  ui.blank();
  ui.step("Here is what I will do:");
  ui.blank();
  ui.dim(`directory     ${directory}`);
  ui.dim(`url           ${values.FIRETOWER_PUBLIC_URL}`);
  ui.dim(`published     ${published(reach, ports)}`);
  ui.dim(`certificate   ${certificate(reach)}`);
  // The provider, never the token. This block is what people paste into an
  // issue when an install goes wrong.
  if (reach.kind === "domain" && !suppliesOwnCertificate(reach)) {
    ui.dim(`dns           ${reach.dnsProvider}, with the token you gave (not shown)`);
  }
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

  await write(directory, files, values, reach);
  await requireCertificate(directory, reach);
  await start(directory, files.compose, reach);
  await backUpTheKey(secrets.FIRETOWER_ROOT_KEY, directory, options);
  await rememberDir(directory);

  finish(values, admin, reach, ports);
}

/**
 * The one thing the bring-your-own-certificate shape needs that this CLI
 * cannot generate.
 *
 * Checked after the files are written, so the operator has somewhere to put
 * the certificate and a Caddyfile explaining where to get one — and before
 * anything is pulled or started, so the failure is a sentence rather than a
 * container restarting forever.
 *
 * **It no longer runs for every `domain` install**, and that is the point of
 * this pass. Caddy obtains the certificate itself over DNS-01, so demanding
 * `certs/fullchain.pem` from a deployment that is about to be issued one —
 * and exiting non-zero when it is absent — would refuse every install of the
 * shape this release exists to add.
 */
async function requireCertificate(directory: string, reach: Reach): Promise<void> {
  if (!suppliesOwnCertificate(reach)) return;

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
    "you chose to supply the certificate yourself, and Caddy will not start without it. It has to cover both the name and *.the-name — see the Caddyfile, which also has the `tls` line to uncomment.",
  );
  ui.blank();
  ui.step("Everything is written. Put the two files in place, then:");
  ui.blank();
  ui.dim(
    `  cd ${directory} && docker compose -f ${docker.COMPOSE_FILE} --profile tls up -d --build`,
  );
  ui.blank();

  process.exit(1);
}

/**
 * `install` makes a deployment; it does not edit one.
 *
 * It generates a root key and a database password, and the whole of `env.ts`
 * exists to stop those landing on top of an existing database. So a directory
 * that already has a compose file is refused — and pointed at the command that
 * does want to change something, which since this pass is a real one.
 */
async function refuseIfInstalled(directory: string): Promise<void> {
  if (!(await exists(join(directory, docker.COMPOSE_FILE)))) return;

  stop(
    `Firetower is already installed in ${directory}.`,
    "`firetower domain` changes how it is reached — adding a name, or taking one away. `firetower upgrade` moves it to a newer release.",
  );
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
 * Stop before writing a token that nothing is going to read.
 *
 * The compose file comes from the release, not from this CLI, and one from
 * before DNS-01 terminates TLS with a certificate the operator supplies — no
 * DNS_PROVIDER anywhere in it. Carrying on would write the module name and the
 * API token into `.env`, start a Caddy that reads neither, and leave somebody
 * certain they had configured automatic renewal that was never going to
 * happen. The same argument as `choosePorts` makes about `HTTP_PORT`, with a
 * worse failure at the end of it.
 *
 * Only the shape that asked for issuance is affected. Supplying your own
 * certificate works against every release, which is why it is the answer
 * offered here.
 */
function refuseIfItCannotIssue(reach: Reach, compose: string): void {
  if (reach.kind !== "domain" || suppliesOwnCertificate(reach)) return;
  if (services.obtainsCertificates(compose)) return;

  stop(
    "this Firetower release cannot obtain a certificate",
    "it terminates TLS with one you supply. Install without --dns-provider and put fullchain.pem and privkey.pem in ./certs, or wait for a release that reads DNS_PROVIDER.",
  );
}

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
  reach: Reach,
): Promise<void> {
  ui.blank();
  ui.step("Writing");

  await mkdir(directory, { recursive: true });

  const composePath = join(directory, docker.COMPOSE_FILE);
  await writeFile(composePath, files.compose);
  ui.ok(composePath);

  // Written as it comes, where it used to have an `email` block prepended.
  // ACME_EMAIL now reaches Caddy's global options through the compose file's
  // environment, and the Caddyfile already has the one-line block that reads
  // it — prepending a second global block would make the file unparseable.
  //
  // This also keeps the file the operator may hand-edit — a provider that
  // needs more than a token, or the bring-your-own `tls` line — as a file
  // nothing rewrites afterwards.
  const caddyPath = join(directory, "Caddyfile");
  const caddyfile = upstream.withProviderBlock(
    files.caddyfile,
    reach.kind === "domain" ? reach.dnsProvider : "",
  );
  await writeFile(caddyPath, caddyfile);
  ui.ok(caddyPath, caddyfile === files.caddyfile ? undefined : "with the provider block to fill in");

  // The compose file's `caddy` service names this as its `dockerfile`, so it
  // has to be here even in the shapes that never build it: Compose reads the
  // build section whether or not the profile selects the service.
  const dockerfilePath = join(directory, "Caddyfile.dockerfile");
  await writeFile(dockerfilePath, files.dockerfile);
  ui.ok(dockerfilePath);

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

async function start(directory: string, compose: string, reach: Reach): Promise<void> {
  ui.blank();
  ui.step("Starting");

  // Which services these are is read from the file, not assumed. A release
  // that renames one would otherwise leave the wait below spinning for three
  // minutes against a stack that came up perfectly.
  const named = services.resolve(compose);

  await pull(directory);

  // Caddy is built rather than pulled — a DNS provider is a compiled-in module
  // — and the first build pulls a Go toolchain and compiles from source. Said
  // out loud because it is minutes of silence otherwise, on the step where
  // silence reads as a hang.
  const building = reach.kind === "domain";
  if (building) {
    ui.blank();
    ui.step("Building Caddy with the DNS provider compiled in.");
    ui.step("The first one takes a few minutes; after that it is cached.");
    ui.blank();
  }

  // Streamed when it builds, for the same reason.
  await docker.composeOrThrow(
    { dir: directory, stream: building },
    "up",
    "-d",
    ...(building ? ["--build"] : []),
  );

  await docker.waitForHealthy({ dir: directory }, named.database);
  ui.ok(`${named.database} healthy`);

  await docker.waitForHealthy({ dir: directory }, named.control);
  ui.ok(`${named.control} healthy`);

  const version = await docker.deployedVersion({ dir: directory }, named.control);
  if (version) ui.ok("version", version);
}

/**
 * Pull the images, without tripping over the one that is built.
 *
 * A plain `docker compose pull` exits non-zero once a service has a `build`
 * section: it tries to pull `firetower-caddy` from a registry, is told the
 * repository does not exist, and fails the whole command — even though that
 * image was never going to come from a registry. `--ignore-buildable` is the
 * flag for exactly that, and a Compose old enough not to have it rejects the
 * flag itself, so the plain form is tried after.
 *
 * Neither being possible is not fatal. `up` pulls whatever is missing anyway;
 * this runs first only so several hundred megabytes arrive against a progress
 * bar rather than behind a silent `up`, and a failure here is better reported
 * by the command that actually needs the images.
 */
async function pull(directory: string): Promise<void> {
  const ignoringBuildable = await docker.compose(
    { dir: directory, stream: true },
    "pull",
    "--ignore-buildable",
  );
  if (ignoringBuildable.exitCode === 0) return;

  const plain = await docker.compose({ dir: directory, stream: true }, "pull");
  if (plain.exitCode === 0) return;

  ui.warn("could not pull every image up front", "carrying on — `up` pulls what it needs");
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

  // Said at the end as well as at the prompt, because the flag path never sees
  // the prompt — `--dns-provider route53` would otherwise finish with "Firetower
  // is running" and no hint that the proxy cannot get a certificate until a file
  // is edited.
  if (reach.kind === "domain" && MULTI_FIELD.has(reach.dnsProvider)) {
    ui.step(`${reach.dnsProvider} takes several values, so its block in`);
    ui.step("./Caddyfile is empty and has to be filled in before a certificate");
    ui.step("can be issued. `firetower upgrade` never touches that file.");
    ui.blank();
    ui.dim("  https://github.com/caddy-dns/" + reach.dnsProvider);
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
