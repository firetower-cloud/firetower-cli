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
  publicUrl?: string;
  httpPort?: number;
  httpsPort?: number;
  adminUsername?: string;
  acmeEmail?: string;
  yes?: boolean;
}

/**
 * How people get to this Firetower.
 *
 * The first question, because everything else follows from it: whether Caddy
 * asks for a certificate, whether the published ports can move, and what the
 * URL at the end says.
 */
export type Reach =
  | { kind: "local" }
  | { kind: "domain"; domain: string }
  | { kind: "proxy"; publicUrl: string };

interface Ports {
  http: number;
  https: number;
  /** Whether the release being installed reads them at all. */
  configurable: boolean;
}

const STANDARD = { http: 80, https: 443 };
const ALTERNATE = { http: 8080, https: 8443 };

const cancelled = (value: unknown): boolean => prompts.isCancel(value);

function stop(message: string, remedy?: string): never {
  ui.blank();
  ui.fail(message, remedy);
  ui.blank();
  process.exit(1);
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
  const files = await upstream.deployment();

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
    DOMAIN: reach.kind === "domain" ? reach.domain : "",
    FIRETOWER_PUBLIC_URL: publicUrl(reach, ports),
    // Only when the release reads them. Writing a value nothing honours is how
    // somebody ends up sure they changed a port that never moved.
    ...(ports.configurable
      ? { HTTP_PORT: String(ports.http), HTTPS_PORT: String(ports.https) }
      : {}),
    ...secrets,
    ADMIN_USERNAME: admin.username,
    ADMIN_INITIAL_PASSWORD: admin.password,
  };

  ui.blank();
  ui.step("Here is what I will do:");
  ui.blank();
  ui.dim(`directory     ${directory}`);
  ui.dim(`url           ${values.FIRETOWER_PUBLIC_URL}`);
  ui.dim(`ports         ${ports.http} and ${ports.https}`);
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

/**
 * The first question, and the one the rest of the install reads.
 *
 * Three answers rather than yes-or-no, because "yes, a domain" used to mean two
 * things that need different deployments. Somebody who already runs nginx on 80
 * has a domain *and* cannot give Caddy the ports a certificate needs, and until
 * there was a third answer this CLI had nothing to offer them.
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
      { value: "local", label: "Only from this machine (http://localhost)" },
      { value: "domain", label: "On a public domain — Firetower gets the certificate" },
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

/**
 * Which ports Caddy publishes on this machine.
 *
 * A certificate is the thing that takes the choice away: Let's Encrypt answers
 * the challenge on 80 and 443 specifically — HTTP-01 on one, TLS-ALPN on the
 * other — so a domain pins both, and a challenge that keeps failing earns a
 * rate limit measured in days. Every other shape is free to move.
 */
async function choosePorts(
  reach: Reach,
  compose: string,
  options: InstallOptions,
): Promise<Ports> {
  const configurable = services.portsAreConfigurable(compose);
  const asked = options.httpPort !== undefined || options.httpsPort !== undefined;

  if (reach.kind === "domain") {
    if (asked) {
      stop(
        "--http-port and --https-port cannot be combined with --domain",
        "Let's Encrypt answers the certificate challenge on 80 and 443. Use --public-url instead, and put your own proxy in front.",
      );
    }

    ui.blank();
    ui.warn(
      "ports 80 and 443, and they cannot be moved",
      "Let's Encrypt answers the certificate challenge on those two",
    );

    return { ...STANDARD, configurable };
  }

  // The compose file comes from the release, not from this CLI, and one older
  // than HTTP_PORT hardcodes 80. Offering the choice anyway would write a value
  // into `.env` that nothing reads.
  if (!configurable) {
    if (asked) {
      stop(
        "this Firetower release always publishes 80 and 443",
        "--http-port needs a release that reads HTTP_PORT",
      );
    }

    ui.blank();
    ui.warn("this release always publishes 80 and 443", "upgrade Firetower to choose the ports");

    return { ...STANDARD, configurable };
  }

  const chosen = asked
    ? { http: options.httpPort ?? STANDARD.http, https: options.httpsPort ?? STANDARD.https }
    : options.yes
      ? STANDARD
      : await askPorts();

  if (reach.kind === "proxy") {
    ui.ok(`point your proxy at http://127.0.0.1:${chosen.http}`);
  }

  return { ...chosen, configurable };
}

interface Pair {
  http: number;
  https: number;
}

/** Whether each of a pair is free, as one question. */
async function probe(pair: Pair): Promise<{ http: boolean; https: boolean }> {
  const [http, https] = await Promise.all([
    docker.portIsFree(pair.http),
    docker.portIsFree(pair.https),
  ]);

  return { http, https };
}

function describe(pair: Pair, free: { http: boolean; https: boolean }): string {
  if (free.http && free.https) return "both free";
  if (!free.http && !free.https) return "both in use";

  return `${free.http ? pair.https : pair.http} is in use`;
}

/**
 * One prompt, showing what was found rather than asking a question the operator
 * has no way to answer.
 *
 * Always asked, even when 80 is free — somebody may want a different port for a
 * reason this CLI cannot see. What it does not do is make them guess: the
 * recommendation is a fact about this machine, read a moment ago.
 */
async function askPorts(): Promise<Pair> {
  const standard = await probe(STANDARD);

  const choices = [
    {
      value: "standard",
      label: `${STANDARD.http} and ${STANDARD.https} — ${describe(STANDARD, standard)}`,
    },
  ];

  let recommended = "standard";

  if (!standard.http || !standard.https) {
    const alternate = await probe(ALTERNATE);
    choices.push({
      value: "alternate",
      label: `${ALTERNATE.http} and ${ALTERNATE.https} — ${describe(ALTERNATE, alternate)}`,
    });
    recommended = alternate.http && alternate.https ? "alternate" : "choose";
  }

  choices.push({ value: "choose", label: "Let me choose" });

  const suggested = choices.find((choice) => choice.value === recommended);
  if (suggested) suggested.label += "  (recommended)";

  const choice = await prompts.select({
    message: "Which ports should Firetower publish?",
    options: choices,
    initialValue: recommended,
  });
  if (cancelled(choice)) stop("Nothing was written.");

  if (choice === "standard") return STANDARD;
  if (choice === "alternate") return ALTERNATE;

  const http = await askPort("HTTP port", ALTERNATE.http);
  const https = await askPort("HTTPS port", ALTERNATE.https, http);

  return { http, https };
}

async function askPort(message: string, initial: number, taken?: number): Promise<number> {
  const busy = new Set<number>();

  for (;;) {
    const answer = await prompts.text({
      message,
      initialValue: String(initial),
      validate: (value) => {
        const port = Number(value.trim());
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return "A port between 1 and 65535";
        }
        if (port === taken) return "The other one is already using it";
        if (busy.has(port)) return `something already answers on ${port}`;
        return undefined;
      },
    });
    if (cancelled(answer)) stop("Nothing was written.");

    const port = Number(String(answer).trim());
    if (await docker.portIsFree(port)) return port;

    // `validate` cannot open a socket, so the first refusal happens out here —
    // and is remembered, so typing the same port again is refused at the prompt
    // rather than after another round trip.
    busy.add(port);
    ui.warn(`something already answers on ${port}`);
  }
}

/**
 * The address to print, which is the one thing here that must not be guessed.
 *
 * Exported because it is the join between two answers that are collected pages
 * apart — how this is reached, and on which port — and getting it wrong prints a
 * link that goes nowhere while everything else looks like it worked.
 */
export function publicUrl(reach: Reach, ports: Pick<Ports, "http">): string {
  if (reach.kind === "domain") return `https://${reach.domain}`;
  if (reach.kind === "proxy") return reach.publicUrl;

  return ports.http === 80 ? "http://localhost" : `http://localhost:${ports.http}`;
}

export function certificate(reach: Reach): string {
  if (reach.kind === "domain") return "Caddy, automatic, from Let's Encrypt";
  if (reach.kind === "proxy") return "yours — Firetower serves plain HTTP";

  return "none — plain HTTP";
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
