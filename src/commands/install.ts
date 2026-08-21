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
import { ui, pc } from "../ui.js";

export interface InstallOptions {
  dir?: string;
  domain?: string;
  adminUsername?: string;
  acmeEmail?: string;
  yes?: boolean;
}

const cancelled = (value: unknown): boolean => prompts.isCancel(value);

function stop(message: string): never {
  ui.blank();
  ui.fail(message);
  ui.blank();
  process.exit(1);
}

export async function install(options: InstallOptions): Promise<void> {
  ui.title("Firetower");

  const dir = options.dir ?? (options.yes ? defaultInstallDir() : null);

  // Before anything is asked, so a machine that cannot host this says so
  // before the operator has answered four questions.
  if (dir && (await exists(join(dir, docker.COMPOSE_FILE)))) {
    stop(`Firetower is already installed in ${dir}. Use \`firetower upgrade\`.`);
  }

  const domain = await askDomain(options);

  ui.step("Checking this machine");
  const results = await runChecks(
    machineChecks.filter((c) => c.preflight),
    { dir: dir ?? process.cwd(), domain },
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

  // Fetched rather than carried, so the compose file matches the images about
  // to be pulled rather than whatever this CLI was published with.
  ui.blank();
  ui.step("Fetching the deployment files");
  const files = await upstream.deployment();

  if (files.tag) {
    ui.ok("firetower.yml", `firetower-cloud/firetower @ ${files.tag}`);
    ui.ok("Caddyfile", `firetower-cloud/firetower @ ${files.tag}`);
  } else {
    ui.warn("using the bundled deployment files", "github was unreachable; they may be older");
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
    DOMAIN: domain ?? "",
    FIRETOWER_PUBLIC_URL: domain ? `https://${domain}` : "http://localhost",
    ...secrets,
    ADMIN_USERNAME: admin.username,
    ADMIN_INITIAL_PASSWORD: admin.password,
  };

  ui.blank();
  ui.step("Here is what I will do:");
  ui.blank();
  ui.dim(`directory     ${directory}`);
  ui.dim(`url           ${values.FIRETOWER_PUBLIC_URL}`);
  ui.dim(
    `certificate   ${domain ? "Caddy, automatic, from Let's Encrypt" : "none — plain HTTP on port 80"}`,
  );
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
  await start(directory, files.compose);
  await backUpTheKey(secrets.FIRETOWER_ROOT_KEY, directory, options);
  await rememberDir(directory);

  finish(values, admin);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function askDomain(options: InstallOptions): Promise<string | null> {
  if (options.domain !== undefined) return options.domain || null;
  if (options.yes) return null;

  const usesDomain = await prompts.confirm({
    message: "Will you reach this over a public domain?",
  });
  if (cancelled(usesDomain)) stop("Nothing was written.");
  if (!usesDomain) return null;

  const domain = await prompts.text({
    message: "Domain",
    placeholder: "firetower.example.com",
    validate: (value) => (value.trim() ? undefined : "A domain, or go back and answer no"),
  });
  if (cancelled(domain)) stop("Nothing was written.");

  return String(domain).trim();
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

function finish(values: env.Env, admin: { username: string; password: string }): void {
  ui.blank();
  ui.step(pc.bold("Firetower is running."));
  ui.blank();
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
