import { parse as parseYaml } from "yaml";
import type { Env } from "./env.js";

/**
 * What is in the compose file, worked out rather than assumed.
 *
 * Everything here used to be a hardcoded string. `waitForHealthy(…, "postgres")`
 * is correct right up until the release that renames the service, and then it
 * spins for three minutes and fails an install of a stack that came up fine.
 *
 * Since the compose file is fetched anyway, read it. Services are identified by
 * the **image** they run, not by what they are called: an image can be renamed
 * too, but not without the thing it points at changing, and then a break is
 * honest rather than silent.
 */

interface ComposeFile {
  services?: Record<string, ComposeService | null>;
}

interface ComposeService {
  image?: string;
  environment?: Record<string, string | null> | string[];
  ports?: unknown;
  profiles?: unknown;
}

export interface Services {
  /** The control plane. */
  control: string;
  /** Postgres. */
  database: string;
  /** Whatever terminates TLS in front, when there is one. */
  proxy: string | null;
  /** Everything, in the order the file lists it. */
  all: string[];
}

/** Conventional names, for a file we could not read. */
const FALLBACK: Services = {
  control: "firetower",
  database: "postgres",
  proxy: "caddy",
  all: ["firetower", "postgres", "caddy"],
};

function parseServices(compose: string): Record<string, ComposeService> {
  const document = parseYaml(compose) as ComposeFile | null;
  const services = document?.services ?? {};

  return Object.fromEntries(
    Object.entries(services).map(([name, service]) => [name, service ?? {}]),
  );
}

export function resolve(compose: string): Services {
  let services: Record<string, ComposeService>;

  try {
    services = parseServices(compose);
  } catch {
    return FALLBACK;
  }

  const names = Object.keys(services);
  if (names.length === 0) return FALLBACK;

  const by = (predicate: (image: string) => boolean): string | null =>
    names.find((name) => {
      const image = services[name]?.image;
      return typeof image === "string" && predicate(image);
    }) ?? null;

  // The worker image contains the control plane's name as a prefix, so the
  // order of these two tests matters.
  const control =
    by((image) => image.includes("firetower") && !image.includes("firetower-worker")) ??
    FALLBACK.control;

  return {
    control,
    database: by((image) => /(^|\/)postgres[:@]/.test(image)) ?? FALLBACK.database,
    // A tag is optional here, unlike the two above, because the proxy is the
    // one service that is **built** rather than pulled: Caddy resolves DNS
    // providers as compiled-in modules, so the `tls` profile builds its own
    // image and names it `firetower-caddy` — no registry, and no tag unless
    // somebody adds one. Anchoring on `[:@]` alone found nothing there, and a
    // null proxy is a `doctor` that quietly stops reporting the certificate.
    proxy: by((image) => /(^|[/-])(caddy|nginx|traefik)([:@]|$)/.test(image)),
    all: names,
  };
}

/**
 * Every `ports:` entry in the file, as strings.
 *
 * Which service publishes has moved once already — Caddy used to hold the
 * published port, and now the control plane publishes its own and Caddy is
 * only created when there is TLS to terminate. The questions below are about
 * whether a variable is honoured *anywhere* that publishing happens, so they
 * ask the file rather than a service picked in advance.
 */
function publishedPorts(compose: string): string[] {
  let services: Record<string, ComposeService>;

  try {
    services = parseServices(compose);
  } catch {
    return [];
  }

  return Object.values(services)
    .flatMap((service) => (Array.isArray(service.ports) ? service.ports : []))
    .filter((entry): entry is string => typeof entry === "string");
}

/**
 * Which service publishes a variable's port, or nothing if none does.
 *
 * This is how a re-purposed name is *detected* rather than guessed at. When
 * `HTTP_PORT` moved from Caddy to the control plane it kept its name, kept its
 * syntax, and changed what it described — and the only trace of that in the two
 * files is which service's `ports:` entry mentions it.
 *
 * So an upgrade compares the answer before and after. Same service, and the
 * operator's number still means what they chose; a different one, and it is a
 * number about something else that must not be carried forward.
 */
export function portOwner(compose: string, variable: string): string | null {
  let services: Record<string, ComposeService>;
  try {
    services = parseServices(compose);
  } catch {
    return null;
  }

  for (const [name, service] of Object.entries(services)) {
    const entries = Array.isArray(service.ports) ? service.ports : [];

    if (entries.some((entry) => typeof entry === "string" && entry.includes(`\${${variable}`))) {
      return name;
    }
  }

  return null;
}

/**
 * Whether this compose file lets the operator choose the ports it publishes.
 *
 * Asked rather than assumed, because the CLI writes whatever compose file the
 * current release publishes and a release older than `HTTP_PORT` hardcodes
 * `"80:80"`. Offering the choice against one of those would write a value into
 * `.env` that nothing reads, and the install would fail on the very port
 * conflict the question was asked to avoid.
 *
 * The variable has to be in a `ports` entry, not merely somewhere in the file:
 * that is the only place publishing it changes anything.
 */
export function portsAreConfigurable(compose: string): boolean {
  return publishedPorts(compose).some((entry) => entry.includes("${HTTP_PORT"));
}

/**
 * Whether this compose file lets the operator choose *which interface* the
 * control plane is published on.
 *
 * The same shape of question as `portsAreConfigurable`, and a much more
 * important one to get right. A release older than `HTTP_BIND` writes no host
 * address into its `ports` entry, so Docker binds `0.0.0.0` and the control
 * plane — which holds every credential Firetower has — is on every interface
 * the machine owns.
 *
 * When this is false the answer is never to promise loopback anyway. It is to
 * say plainly that this release publishes on all of them.
 */
export function bindIsConfigurable(compose: string): boolean {
  return publishedPorts(compose).some((entry) => entry.includes("${HTTP_BIND"));
}

/**
 * Whether this compose file can obtain a certificate at all.
 *
 * The same shape of question as `portsAreConfigurable`, and asked for the same
 * reason: the CLI writes whatever compose file the current release publishes,
 * and one from before DNS-01 terminates TLS with a certificate the operator
 * supplies and reads no DNS_PROVIDER anywhere. Answering the provider question
 * against such a file would write a module name and an API token into `.env`
 * that nothing reads, and leave somebody certain they had configured automatic
 * renewal that was never going to happen.
 */
export function obtainsCertificates(compose: string): boolean {
  let services: Record<string, ComposeService>;
  try {
    services = parseServices(compose);
  } catch {
    // Unreadable is not evidence either way, and the honest answer is the one
    // that does not claim a capability. `install` treats this as "cannot".
    return false;
  }

  return Object.values(services).some((service) =>
    JSON.stringify(service).includes("${DNS_PROVIDER"),
  );
}

/**
 * `${VAR:?message}` — the variables Compose refuses to start without.
 *
 * Read so that a release which adds one produces "this needs FIRETOWER_X;
 * upgrade the CLI" instead of Compose's error about a variable the operator
 * has never heard of.
 */
export function requiredVariables(compose: string, activeProfiles: string[] = []): string[] {
  const active = new Set(activeProfiles);

  let services: Record<string, ComposeService>;
  try {
    services = parseServices(compose);
  } catch {
    // A file we cannot parse is one we cannot reason about. Scanning all of it
    // over-reports rather than under-reports, and over-reporting here means
    // "set this variable" against a file that may not need it — annoying,
    // where the other way round is Compose failing with its own error about a
    // variable the operator has never heard of.
    return [...new Set(scanForRequired(compose))];
  }

  const required = new Set<string>();

  for (const service of Object.values(services)) {
    // A service behind a profile that is not turned on is not created, so
    // nothing it asks for is required. This is what lets the proxy insist on
    // DOMAIN without every tunnel install being told to set one.
    if (!willBeCreated(service, active)) continue;

    for (const name of scanForRequired(JSON.stringify(service))) required.add(name);
  }

  return [...required];
}

/**
 * The variables Compose *demands* that this deployment has no answer for.
 *
 * The other half of the question above, and the one Compose itself asks.
 * Profiles decide which containers are created; they do not decide which
 * variables are interpolated. The whole file is interpolated first, so the
 * proxy's `DOMAIN: ${DOMAIN:?…}` stops `docker compose pull` in a deployment
 * that has no proxy — an error about a container that was never going to
 * exist, in the shape this CLI installs by default.
 *
 * There is no honest value to write for one of these: the answer to "which
 * domain" is that there is not one. So nothing here goes into `.env`, where
 * `doctor` would read a name back as a certificate to check and `install`
 * would have invented a decision the operator never made. `docker.ts` passes
 * them to the one command that needs them past interpolation, and nothing
 * that runs is given them at all.
 */
export function dormantRequiredVariables(compose: string, activeProfiles: string[] = []): string[] {
  const active = new Set(activeProfiles);

  let services: Record<string, ComposeService>;
  try {
    services = parseServices(compose);
  } catch {
    // No profiles to read means no way to tell a dormant service from a live
    // one, and `requiredVariables` has already over-reported the same file to
    // the operator. Answering one of those with a placeholder would be
    // answering a question that may well be real.
    return [];
  }

  const dormant = new Set<string>();

  for (const service of Object.values(services)) {
    if (willBeCreated(service, active)) continue;

    for (const name of scanForRequired(JSON.stringify(service))) dormant.add(name);
  }

  // One a live service also insists on is not dormant, whatever else asks for
  // it: that one needs a real value, and `missingVariables` is what says so.
  for (const name of requiredVariables(compose, activeProfiles)) dormant.delete(name);

  return [...dormant];
}

/**
 * The services this deployment will actually have, profiles applied.
 *
 * The complement is what makes a container an orphan, so this is the list
 * `upgrade` subtracts from what is on the machine. A service behind a profile
 * that is off does not appear, which is the entire point: that is exactly the
 * container Compose will leave running and never mention.
 */
export function createdServices(compose: string, activeProfiles: string[] = []): string[] {
  const active = new Set(activeProfiles);

  let services: Record<string, ComposeService>;
  try {
    services = parseServices(compose);
  } catch {
    // A file we cannot parse gives no basis for calling anything an orphan,
    // and the cost of guessing wrong here is removing somebody's container.
    return [];
  }

  return Object.entries(services)
    .filter(([, service]) => willBeCreated(service, active))
    .map(([name]) => name);
}

/**
 * Every profile named anywhere in the file.
 *
 * For the one operation that has to reach a service the deployment does not
 * want: taking it down. `--remove-orphans` does not, because a profile-gated
 * service is not an orphan — Compose knows it, it is simply not selected — so a
 * `down` that leaves the profiles off walks straight past the Caddy still
 * holding 80. Selecting every profile is what makes `down` mean the whole
 * project.
 */
export function allProfiles(compose: string): string[] {
  let services: Record<string, ComposeService>;
  try {
    services = parseServices(compose);
  } catch {
    return [];
  }

  const found = new Set<string>();

  for (const service of Object.values(services)) {
    const profiles = Array.isArray(service.profiles) ? service.profiles : [];
    for (const name of profiles) found.add(String(name));
  }

  return [...found];
}

/** Whether this deployment's profiles create this service at all. */
function willBeCreated(service: ComposeService, active: Set<string>): boolean {
  const profiles = Array.isArray(service.profiles) ? service.profiles : [];

  return profiles.length === 0 || profiles.some((name) => active.has(String(name)));
}

/**
 * Which optional services this deployment wants, read from `.env`.
 *
 * One reading of `COMPOSE_PROFILES` rather than three: everything that asks
 * "which containers will exist" — the `--profile` flags, the variables Compose
 * requires, the checks — has to get the same answer, or the stack that starts
 * is not the one that was checked.
 */
export function activeProfiles(env: Env): string[] {
  return (env.COMPOSE_PROFILES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

/** `${VAR:?message}` — the form Compose refuses to start without. */
function scanForRequired(text: string): string[] {
  const found: string[] = [];

  for (const [, name] of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):\?[^}]*\}/g)) {
    if (name) found.push(name);
  }

  return found;
}

/**
 * Resolve `${VAR}`, `${VAR:-default}` and `${VAR-default}` against a `.env`,
 * the way Compose would.
 *
 * Only the forms that appear in a compose file we wrote. `:?` resolves to the
 * value or to empty, because the caller has already checked for it.
 */
export function interpolate(value: string, env: Env): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-?]([^}]*))?\}/g,
    (_, name: string, fallback = "") => {
      const held = env[name];
      return held !== undefined && held !== "" ? held : fallback;
    },
  );
}

function environmentOf(service: ComposeService | undefined): Record<string, string> {
  const environment = service?.environment;
  if (!environment) return {};

  // Compose accepts a map or a list of KEY=value. Both appear in the wild.
  if (Array.isArray(environment)) {
    return Object.fromEntries(
      environment.map((entry) => {
        const index = entry.indexOf("=");
        return index === -1 ? [entry, ""] : [entry.slice(0, index), entry.slice(index + 1)];
      }),
    );
  }

  return Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [key, value ?? ""]),
  );
}

export interface DatabaseIdentity {
  user: string;
  database: string;
}

/**
 * Who to connect to Postgres as, and to which database.
 *
 * `pg_dump -U firetower firetower` was hardcoded, and the compose file derives
 * both from `${POSTGRES_USER:-firetower}` and `${POSTGRES_DB:-firetower}`. A
 * changed default upstream would have failed the backup that `upgrade` takes
 * immediately before applying migrations — the one backup that matters.
 */
export function databaseIdentity(
  compose: string,
  services: Services,
  env: Env,
): DatabaseIdentity {
  let environment: Record<string, string> = {};

  try {
    environment = environmentOf(parseServices(compose)[services.database]);
  } catch {
    environment = {};
  }

  const value = (key: string, fallback: string) => {
    const raw = environment[key];
    const resolved = raw ? interpolate(raw, env) : env[key];
    return resolved && resolved !== "" ? resolved : fallback;
  };

  return {
    user: value("POSTGRES_USER", "firetower"),
    database: value("POSTGRES_DB", "firetower"),
  };
}
