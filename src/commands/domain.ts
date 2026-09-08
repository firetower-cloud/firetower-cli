import { writeFile, readFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import * as prompts from "@clack/prompts";
import * as docker from "../docker.js";
import * as env from "../env.js";
import * as services from "../services.js";
import * as upstream from "../upstream.js";
import { requireDeployment } from "./shared.js";
import { open as openDeployment } from "../deployment.js";
import { domainResolves } from "../checks/machine.js";
import { MULTI_FIELD } from "../providers.js";
import {
  askReach,
  cancelled,
  certificate,
  choosePorts,
  derive,
  describe,
  infer,
  published,
  showRecords,
  stop,
  suppliesOwnCertificate,
  tunnelCommand,
  type Reach,
  type ReachOptions,
} from "../shape.js";
import { ui, pc } from "../ui.js";

/**
 * Change how an existing deployment is reached.
 *
 * The gap this fills is the ordinary one: somebody installs on loopback,
 * reaches it over a tunnel for a month, and then a second person needs it.
 * Until now there was nothing to run. `install` refuses a directory that
 * already has a deployment — rightly, because it generates secrets — and
 * `upgrade` deliberately re-derives the shape from `.env` rather than asking,
 * so it can only ever preserve the answer that is already there.
 *
 * This asks the one question again and recomputes everything downstream of it,
 * which is exactly what `shape.ts` is for. Nothing about the release moves: no
 * images are pulled, no migrations run, no database is touched. The only things
 * that change are the values in `.env` that follow from the answer, and the
 * containers that have to be recreated to read them.
 *
 * It goes both ways. Naming a domain adds the proxy and the certificate;
 * `--none` takes them away again and puts the deployment back on loopback.
 */
export interface DomainOptions extends ReachOptions {
  dir?: string;
  httpPort?: number;
  httpsPort?: number;
  /** Remove the domain and go back to loopback. */
  none?: boolean;
}

export async function domain(options: DomainOptions): Promise<void> {
  const dir = await requireDeployment(options.dir);

  ui.title("Firetower");

  const deployment = await openDeployment(dir);
  const before = infer(deployment.env);

  // Unattended, "no arguments" is not an answer — and the answer it would fall
  // to is the destructive one. `askReach` reads `--yes` with no domain as the
  // loopback shape, which is right for `install` onto a bare machine and would
  // mean "remove the domain" here.
  if (options.yes && !options.none && options.domain === undefined && !options.publicUrl) {
    const adjusting = options.dnsProvider !== undefined || options.dnsToken !== undefined;

    if (!adjusting || before.kind !== "domain") {
      stop(
        "say what to change it to",
        "a domain, or --public-url for your own proxy, or --none to go back to loopback",
      );
    }
  }

  ui.dim(`deployment    ${dir}`);
  ui.dim(`reached by    ${describe(before)}`);
  ui.blank();

  // `--none` is the way back, and it is a different answer rather than an
  // absent one: `askReach` reads a missing `--domain` as "ask me".
  const reach = options.none
    ? ({ kind: "local" } as Reach)
    : await askReach(carryForward(options, before));

  refuseIfItCannotIssue(reach, deployment.compose);

  // The same check `install` runs, for the same reason and at the same point:
  // before anything is written. It is where a missing wildcard record gets
  // caught, which is the mistake that leaves the interface working and every
  // preview broken.
  if (reach.kind === "domain") {
    ui.blank();
    ui.step("Checking DNS");

    const result = await domainResolves.run({ dir, domain: reach.domain });
    if (result.status === "ok") ui.ok(result.name, result.detail);
    else if (result.status === "warn") ui.warn(`${result.name}  ${result.detail}`, result.remedy);
    else ui.fail(`${result.name}  ${result.detail}`, result.remedy);
  }

  const held = new Set(
    (await docker.projectContainers({ dir })).flatMap((container) => container.ports),
  );
  const ports = await choosePorts(
    reach,
    deployment.compose,
    keepPorts(deployment.env, reach, options),
    held,
  );

  const next = env.reshape(deployment.env, derive(reach, ports));
  const changes = env.changes(deployment.env, next);

  if (changes.length === 0) {
    ui.blank();
    ui.ok("nothing to change", `already reached by ${describe(reach)}`);
    ui.blank();
    return;
  }

  // Before the confirm: needing a hand-edit is something to know while
  // deciding, not after.
  const shape = await providerShapeChange(dir, reach);

  report(reach, ports, next, changes);

  if (shape?.next) {
    ui.step(`${shape.path} will gain the ${reach.kind === "domain" ? reach.dnsProvider : ""} block,`);
    ui.step("which takes several values and has to be filled in by hand.");
    ui.blank();
  }

  if (!options.yes) {
    const proceed = await prompts.confirm({ message: "Continue?" });
    if (cancelled(proceed) || !proceed) stop("Nothing was changed.");
  }

  ui.blank();
  ui.step("Writing");

  await ensureProxyFiles(dir, deployment.compose, reach);

  if (shape?.next) {
    await writeFile(shape.path, shape.next, "utf8");
    ui.ok(shape.path, "now carries the provider block, for you to fill in");
  }

  const path = join(dir, ".env");
  await writeFile(join(dir, ".env.backup"), await readFile(path, "utf8"), { mode: 0o600 });
  await env.write(path, next);
  ui.ok(path, "previous kept as .env.backup");

  await restart(dir, deployment.compose, next, reach);

  finish(dir, reach, ports, next);
}

/**
 * Fill the parts of the answer the caller did not restate.
 *
 * Three flags that each mean something on their own, and would mean something
 * destructive if the missing ones were read as "no":
 *
 *   * `--dns-token X` alone is rotating a credential. Without this it goes
 *     through `askReach`'s `--domain` branch, where an unnamed provider means
 *     "a certificate I supply" — so rotating a token would quietly turn a
 *     working DNS-01 deployment into one waiting for a file in ./certs.
 *   * `--dns-provider hetzner` alone is moving zones. It needs the name the
 *     deployment already has, or there is no domain to move.
 *   * renaming with `firetower domain new.example.com` should keep obtaining
 *     certificates the way it already does, not silently stop.
 *
 * Only for a deployment that already has a domain, and only for values not
 * given. `--none` is handled before this, and the interactive path ignores all
 * of it: `askReach` only reads these when `--domain` was passed.
 */
function carryForward(options: DomainOptions, before: Reach): DomainOptions {
  if (before.kind !== "domain") return options;

  const naming = options.domain !== undefined || options.publicUrl !== undefined;
  const adjusting = options.dnsProvider !== undefined || options.dnsToken !== undefined;

  return {
    ...options,
    domain: options.domain ?? (adjusting && !naming ? before.domain : undefined),
    dnsProvider: options.dnsProvider ?? before.dnsProvider,
    dnsToken: options.dnsToken ?? before.dnsToken,
  };
}

/**
 * Keep the ports this deployment already publishes.
 *
 * This command is about how Firetower is reached, not about where it is
 * published, and moving somebody's port because they added a name would be the
 * kind of silent change the whole of `env.ts` exists to prevent. Passing the
 * current values also means `choosePorts` treats them as answered and does not
 * ask a question nobody came here for.
 *
 * The exception is a control plane on 80 that is gaining a certificate. Caddy
 * publishes 80 there to redirect, so the two would collide — `choosePorts`
 * refuses that pair outright. Letting it fall through to the default moves the
 * control plane to 8080 instead, which is what `install` would have done.
 */
function keepPorts(values: env.Env, reach: Reach, options: DomainOptions): DomainOptions {
  const http = Number(values.HTTP_PORT) || undefined;
  const https = Number(values.HTTPS_PORT) || undefined;
  const collides = reach.kind === "domain" && http === 80;

  return {
    ...options,
    httpPort: options.httpPort ?? (collides ? undefined : http),
    httpsPort: options.httpsPort ?? https,
  };
}

/**
 * The same refusal `install` makes, for the same reason.
 *
 * A compose file from before DNS-01 reads no DNS_PROVIDER anywhere, so writing
 * one — and a token beside it — would leave somebody certain they had
 * configured automatic renewal that was never going to happen. Unlike
 * `install`, there is a good answer here: the release is what is out of date,
 * and `upgrade` is what moves it.
 */
function refuseIfItCannotIssue(reach: Reach, compose: string): void {
  if (reach.kind !== "domain" || suppliesOwnCertificate(reach)) return;
  if (services.obtainsCertificates(compose)) return;

  stop(
    "this deployment's release cannot obtain a certificate",
    "run `firetower upgrade` first — this compose file has no DNS_PROVIDER to read. Or supply your own certificate: answer `I already have a certificate`.",
  );
}

/**
 * The files the `tls` profile needs, for a deployment that has never had one.
 *
 * A loopback install writes them anyway, so this is usually a no-op. It is not
 * for a deployment made by a CLI old enough to have written only the compose
 * file and the Caddyfile — which is every deployment that predates the build,
 * and exactly the population this command exists to serve.
 */
async function ensureProxyFiles(dir: string, compose: string, reach: Reach): Promise<void> {
  if (reach.kind !== "domain") return;

  // `certs/` matters only on the bring-your-own path, but making it is free and
  // a bind mount whose source does not exist is created by the daemon, owned by
  // root — which then reads as a Firetower bug rather than a missing step.
  await mkdir(join(dir, "certs"), { recursive: true });

  const wanted: string[] = ["Caddyfile"];
  if (compose.includes("Caddyfile.dockerfile")) wanted.push("Caddyfile.dockerfile");

  const missing: string[] = [];
  for (const file of wanted) {
    if (!(await exists(join(dir, file)))) missing.push(file);
  }

  if (missing.length > 0) {
    const files = await upstream.deployment();

    for (const file of missing) {
      const body = file === "Caddyfile" ? files.caddyfile : files.dockerfile;
      await writeFile(join(dir, file), body, "utf8");
      ui.ok(join(dir, file), "written — this deployment had never had a proxy");
    }
  }

}

/**
 * Keep the Caddyfile's `dns` directive in the shape the chosen provider needs.
 *
 * The two shapes are not interchangeable, and getting it wrong is not a
 * degraded deployment — it is a Caddy that cannot parse its config and restarts
 * for ever. `caddy-dns/route53` answers any inline argument with `d.ArgErr()`,
 * so switching a deployment from Cloudflare to Route 53 and leaving
 * `dns {$DNS_PROVIDER} {env.DNS_API_TOKEN}` behind stops the proxy dead.
 *
 * Only the untouched one-line form is ever rewritten — `withProviderBlock`
 * matches that exact text and nothing else — so a Caddyfile somebody has edited
 * is left alone and reported instead. Silently reformatting a file the operator
 * owns would be worse than the failure it prevents.
 */
interface ShapeChange {
  path: string;
  next?: string;
}

/**
 * Worked out before the operator is asked to confirm, applied after.
 *
 * The warning is the point of the split. It says the deployment needs an edit
 * by hand before it will start, and that is something to know while deciding
 * rather than after deciding.
 */
async function providerShapeChange(dir: string, reach: Reach): Promise<ShapeChange | null> {
  if (reach.kind !== "domain") return null;

  const path = join(dir, "Caddyfile");
  const current = await readFile(path, "utf8").catch(() => null);
  if (current === null) return null;

  const next = upstream.withProviderBlock(current, reach.dnsProvider);
  if (next !== current) return { path, next };

  // Unchanged for one of two reasons: it is already right, or it is a file this
  // will not touch. Only the second is worth saying anything about.
  const oneLine = "dns {$DNS_PROVIDER} {env.DNS_API_TOKEN}";

  if (!MULTI_FIELD.has(reach.dnsProvider) && !current.includes(oneLine)) {
    ui.blank();
    ui.warn(
      `${path} does not use the single-token form, and ${reach.dnsProvider} wants it`,
      `its \`dns\` directive was written for another provider, or edited by hand. Make it read \`${oneLine}\` before restarting — Caddy will not start otherwise.`,
    );
    ui.blank();
  }

  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function report(
  reach: Reach,
  ports: Parameters<typeof published>[1],
  next: env.Env,
  changes: env.Change[],
): void {
  ui.blank();
  ui.step("Here is what I will do:");
  ui.blank();
  ui.dim(`reached by    ${describe(reach)}`);
  ui.dim(`published     ${published(reach, ports)}`);
  ui.dim(`certificate   ${certificate(reach)}`);
  ui.dim(`url           ${next.FIRETOWER_PUBLIC_URL}`);
  ui.blank();
  ui.step(".env:");
  ui.blank();

  // Through `env.display`, which is what keeps DNS_API_TOKEN out of the
  // scrollback. It is the one value here that is a credential.
  for (const { key, before, after } of changes) {
    ui.dim(`  ${key.padEnd(24)} ${env.display(key, before)} → ${env.display(key, after)}`);
  }

  ui.blank();
}

/**
 * Down, then up — not `restart`, and not `up -d` on its own.
 *
 * Turning the `tls` profile off leaves a Caddy that Compose has stopped
 * selecting: not an orphan, just unselected, so neither `--remove-orphans` nor a
 * plain `up` touches it and it stays running on 443. Selecting every profile the
 * file defines is what makes the `down` reach it. Turning the profile *on* needs
 * the build, which is what `--build` is for.
 */
async function restart(
  dir: string,
  compose: string,
  next: env.Env,
  reach: Reach,
): Promise<void> {
  ui.blank();
  ui.step("Restarting");

  await docker.composeOrThrow(
    { dir, profiles: services.allProfiles(compose) },
    "down",
    "--remove-orphans",
  );

  const building = services.activeProfiles(next).includes("tls");
  if (building && !suppliesOwnCertificate(reach)) {
    ui.blank();
    ui.step("Building Caddy with the DNS provider compiled in.");
    ui.step("The first one takes a few minutes; after that it is cached.");
    ui.blank();
  }

  await docker.composeOrThrow(
    { dir, stream: building },
    "up",
    "-d",
    ...(building ? ["--build"] : []),
  );

  const named = services.resolve(compose);
  await docker.waitForHealthy({ dir }, named.database);
  await docker.waitForHealthy({ dir }, named.control);
  ui.ok("healthy");
}

function finish(
  dir: string,
  reach: Reach,
  ports: Parameters<typeof published>[1],
  next: env.Env,
): void {
  ui.blank();
  ui.step(pc.bold(`Firetower is reached by ${describe(reach)}.`));
  ui.blank();

  if (reach.kind === "domain") {
    // Repeated at the end as well as before the write, because this is the step
    // that is done somewhere else — in a DNS console — and the one most likely
    // to be missing when somebody reports that it does not work.
    showRecords(reach.domain);

    if (!suppliesOwnCertificate(reach)) {
      ui.step("Caddy is asking Let's Encrypt for the certificate now. It takes");
      ui.step("a minute or so, and needs those records in place first:");
      ui.blank();
      ui.dim(`  firetower --dir ${dir} logs caddy`);
      ui.blank();
    }
  }

  if (reach.kind === "local") {
    ui.step("It is on loopback again, so reach it with a tunnel:");
    ui.blank();
    ui.dim(`  ${tunnelCommand(ports.http)}`);
    ui.blank();
  }

  ui.dim(`  ${next.FIRETOWER_PUBLIC_URL}`);
  ui.blank();
}
