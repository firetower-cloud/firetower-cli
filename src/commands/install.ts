import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { hostname, userInfo } from "node:os";
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
  /** Whether it reads `HTTP_BIND` — see `bindIsConfigurable`. */
  bindable: boolean;
}

/**
 * Which interface the control plane's port is published on.
 *
 * Loopback, in all three shapes, because the thing being published holds every
 * credential Firetower has. None of the three needs more:
 *
 *   * a tunnel terminates on this machine and connects to 127.0.0.1 from here;
 *   * `domain` puts Caddy in front, and Caddy reaches 4400 over Compose's own
 *     network rather than through the published port;
 *   * a reverse proxy somebody already runs is on this machine — the one case
 *     where it might not be is rare enough to be worth setting HTTP_BIND by
 *     hand, and worth thinking about while doing it.
 *
 * Not a parameter, then, but not a literal either: it is written down here so
 * that the day a shape needs something else, this is where the argument for it
 * has to go.
 */
const LOOPBACK = "127.0.0.1";

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
    // Creates the `caddy` service, which is behind a compose profile and is
    // not created otherwise. Only the shape that has a certificate to
    // terminate wants it: the control plane serves its own interface, its own
    // API and its own preview routing, so with no TLS in the picture a proxy
    // would be a pass-through in front of a server that is already whole.
    ...(reach.kind === "domain" ? { COMPOSE_PROFILES: "tls" } : {}),
    // What preview hostnames hang off. Unset means `localhost`, which is what
    // a tunnel wants and needs no DNS at all. With a name, it is that name —
    // and without this line the server would go on minting `*.localhost`
    // previews that resolve to the browser's own machine.
    ...(reach.kind === "domain" ? { FIRETOWER_PREVIEW_DOMAIN: reach.domain } : {}),
    // Only when the release reads them. Writing a value nothing honours is how
    // somebody ends up sure they changed a port that never moved.
    ...(ports.configurable
      ? {
          HTTP_PORT: String(ports.http),
          // Caddy's, and Caddy only exists in the shape that has a
          // certificate. Writing it otherwise would be a value nothing reads.
          ...(reach.kind === "domain" ? { HTTPS_PORT: String(ports.https) } : {}),
        }
      : {}),
    ...(ports.bindable ? { HTTP_BIND: LOOPBACK } : {}),
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

/**
 * Which ports this machine publishes.
 *
 * Two different things, and they moved apart when Caddy stopped being created
 * for every install:
 *
 *   * `HTTP_PORT` is the control plane's own, published on loopback in every
 *     shape. This is the one an ssh tunnel forwards.
 *   * `HTTPS_PORT` is Caddy's, and only exists in the `domain` shape, where it
 *     is the address other people actually open.
 *
 * The control plane's port wants to be a high one. A tunnel is easiest when
 * both sides are the same number — that way the address in the browser matches
 * FIRETOWER_PUBLIC_URL — and a forward onto a port below 1024 needs root on the
 * *operator's* machine, which is a strange thing to make somebody do to read a
 * dashboard. In the `domain` shape it is not merely preferable: Caddy publishes
 * 80 there, so leaving the control plane on 80 would collide.
 */
async function choosePorts(
  reach: Reach,
  compose: string,
  options: InstallOptions,
): Promise<Ports> {
  const configurable = services.portsAreConfigurable(compose);
  const bindable = services.bindIsConfigurable(compose);
  const asked = options.httpPort !== undefined || options.httpsPort !== undefined;

  // A release older than HTTP_BIND publishes on every interface, and there is
  // no value to write that changes it. Never promise loopback in that case:
  // the whole point of this shape is that nothing is on the network.
  if (!bindable) {
    ui.blank();
    ui.warn(
      "this Firetower release publishes on every interface",
      "upgrade Firetower — this one cannot be held to loopback, and the control plane holds the vault",
    );
  }

  // The compose file comes from the release, not from this CLI, and one older
  // than HTTP_PORT hardcodes its ports. Offering the choice anyway would write
  // a value into `.env` that nothing reads.
  if (!configurable) {
    if (asked) {
      stop(
        "this Firetower release always publishes 80 and 443",
        "--http-port needs a release that reads HTTP_PORT",
      );
    }

    ui.blank();
    ui.warn("this release always publishes 80 and 443", "upgrade Firetower to choose the ports");

    return { ...STANDARD, configurable, bindable };
  }

  if (reach.kind === "domain") {
    const https = options.httpsPort ?? STANDARD.https;
    // Caddy is the front door here and 443 is where people will look for it.
    // The control plane's own port stays out of the way behind it.
    const http = options.httpPort ?? ALTERNATE.http;

    if (http === STANDARD.http) {
      stop(
        "the control plane cannot be on 80 with a certificate in front",
        "Caddy publishes 80 to redirect to 443. Give --http-port something else, or leave it out.",
      );
    }

    return { http, https, configurable, bindable };
  }

  const chosen = asked
    ? { http: options.httpPort ?? ALTERNATE.http, https: options.httpsPort ?? ALTERNATE.https }
    : options.yes
      ? ALTERNATE
      : await askPorts();

  if (reach.kind === "proxy") {
    ui.ok(`point your proxy at http://${LOOPBACK}:${chosen.http}`);
  }

  return { ...chosen, configurable, bindable };
}

interface Pair {
  http: number;
  https: number;
}

/**
 * One prompt, showing what was found rather than asking a question the operator
 * has no way to answer.
 *
 * Always asked, even when the recommendation is free — somebody may want a
 * different port for a reason this CLI cannot see. What it does not do is make
 * them guess: what is free is a fact about this machine, read a moment ago.
 *
 * A high port leads, and 80 is the fallback rather than the other way round.
 * This is the port an ssh tunnel forwards, and forwarding onto a port under
 * 1024 needs root on the operator's own machine — so recommending 80 quietly
 * makes the next step harder than it has to be.
 */
async function askPorts(): Promise<Pair> {
  const alternateIsFree = await docker.portIsFree(ALTERNATE.http);

  const choices = [
    {
      value: "alternate",
      label: `${ALTERNATE.http} — ${alternateIsFree ? "free" : "in use"}`,
    },
  ];

  let recommended = "alternate";

  if (!alternateIsFree) {
    const standardIsFree = await docker.portIsFree(STANDARD.http);
    choices.push({
      value: "standard",
      label: `${STANDARD.http} — ${standardIsFree ? "free" : "in use"}`,
    });
    recommended = standardIsFree ? "standard" : "choose";
  }

  choices.push({ value: "choose", label: "Let me choose" });

  const suggested = choices.find((choice) => choice.value === recommended);
  if (suggested) suggested.label += "  (recommended)";

  const choice = await prompts.select({
    message: "Which port should Firetower publish?",
    options: choices,
    initialValue: recommended,
  });
  if (cancelled(choice)) stop("Nothing was written.");

  if (choice === "alternate") return ALTERNATE;
  if (choice === "standard") return STANDARD;

  // The HTTPS port travels with it rather than being asked for: nothing
  // answers on it in this shape — Caddy is what publishes 443, and Caddy is
  // not created without a certificate to terminate.
  const http = await askPort("Port", ALTERNATE.http);

  return { http, https: ALTERNATE.https };
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
export function publicUrl(reach: Reach, ports: Pick<Ports, "http" | "https">): string {
  if (reach.kind === "domain") {
    // Caddy's port, not the control plane's — this is the address other people
    // open, and they reach the certificate rather than the loopback listener.
    return ports.https === 443
      ? `https://${reach.domain}`
      : `https://${reach.domain}:${ports.https}`;
  }
  if (reach.kind === "proxy") return reach.publicUrl;

  // The port is not optional here. Over a tunnel the browser is at
  // `localhost:8080`, and a notification linking to `localhost` sends whoever
  // clicks it to port 80 on their own machine.
  return ports.http === 80 ? "http://localhost" : `http://localhost:${ports.http}`;
}

/**
 * The command that actually reaches a loopback install.
 *
 * Both sides on the same number on purpose: it is what makes the address in
 * the browser match FIRETOWER_PUBLIC_URL, and every preview link along with
 * it. The three options are not decoration —
 *
 *   * ServerAliveInterval/CountMax notice a dead forward in about a minute,
 *     instead of leaving a tunnel that looks up and answers nothing;
 *   * ExitOnForwardFailure makes "that port is already taken here" an error
 *     rather than an ssh session that connected and forwarded nothing.
 */
export function tunnelCommand(port: number, destination?: string): string {
  const target = destination ?? `${userOnThisMachine()}@${hostname()}`;

  return (
    `ssh -N -L ${port}:${LOOPBACK}:${port} ` +
    `-o ServerAliveInterval=20 -o ServerAliveCountMax=3 ` +
    `-o ExitOnForwardFailure=yes ${target}`
  );
}

/**
 * A best guess at what to type, rather than a placeholder to fill in.
 *
 * Usually right on a VPS, and wrong in a way that is obvious when it is wrong
 * — which is better than `<user>@<host>`, because that has to be edited even
 * when the guess would have been correct.
 */
function userOnThisMachine(): string {
  return process.env.SUDO_USER ?? process.env.USER ?? userInfo().username;
}

export function certificate(reach: Reach): string {
  if (reach.kind === "domain") return "yours, from ./certs — see the Caddyfile";
  if (reach.kind === "proxy") return "yours — Firetower serves plain HTTP";

  return "none — plain HTTP, on loopback only";
}

/**
 * What will actually be listening, and where.
 *
 * The bind is in the summary because it is the line that says whether this
 * machine's public address answers. It used to be neither shown nor chosen,
 * and "only from this machine" published on every interface.
 */
export function published(reach: Reach, ports: Ports): string {
  const control = ports.bindable
    ? `${LOOPBACK}:${ports.http}`
    : `every interface, on ${ports.http}`;

  if (reach.kind === "domain") {
    return `${control} — and Caddy on ${ports.https} and 80, for everyone else`;
  }

  return control;
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
