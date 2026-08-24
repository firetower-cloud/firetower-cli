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
    proxy: by((image) => /(^|\/)(caddy|nginx|traefik)[:@]/.test(image)),
    all: names,
  };
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
 * The variable has to be in the proxy's own `ports`, not merely somewhere in
 * the file: that is the only place publishing it changes anything.
 */
export function portsAreConfigurable(compose: string): boolean {
  let services: Record<string, ComposeService>;

  try {
    services = parseServices(compose);
  } catch {
    return false;
  }

  const proxy = resolve(compose).proxy;
  const ports = proxy ? services[proxy]?.ports : undefined;
  if (!Array.isArray(ports)) return false;

  return ports.some((entry) => typeof entry === "string" && entry.includes("${HTTP_PORT"));
}

/**
 * `${VAR:?message}` — the variables Compose refuses to start without.
 *
 * Read so that a release which adds one produces "this needs FIRETOWER_X;
 * upgrade the CLI" instead of Compose's error about a variable the operator
 * has never heard of.
 */
export function requiredVariables(compose: string): string[] {
  const required = new Set<string>();

  for (const [, name] of compose.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):\?[^}]*\}/g)) {
    if (name) required.add(name);
  }

  return [...required];
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
