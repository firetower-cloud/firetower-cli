import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The deployment files, from the repository that owns them.
 *
 * `firetower.yml` is interpolated by Compose at runtime, so there is nothing to
 * template — the CLI writes it unchanged. That means it should not carry a copy
 * either: a vendored compose file goes stale the moment the main repository
 * changes one, and nothing here would know. So it is fetched, at the tag that
 * matches the images about to be pulled.
 *
 * This adds no constraint that `install` did not already have. A machine that
 * cannot reach github.com cannot reach ghcr.io, and the next step pulls several
 * hundred megabytes from there.
 *
 * The bundled copies under `fallback/` exist for the day GitHub is unreachable
 * and the images are cached. They are a safety net rather than a source, which
 * is why a stale one is harmless — and why the CLI says so when it uses one.
 */

const REPO = "firetower-cloud/firetower";

export interface Deployment {
  /** The release these files came from, or `null` when the fallback was used. */
  tag: string | null;
  compose: string;
  caddyfile: string;
}

interface Release {
  tag_name: string;
}

async function latestTag(signal: AbortSignal): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json" },
    signal,
  });

  if (!response.ok) {
    throw new Error(`github said ${response.status} asking for the latest release`);
  }

  const release = (await response.json()) as Release;
  if (!release.tag_name) throw new Error("the latest release has no tag");

  return release.tag_name;
}

async function raw(tag: string, path: string, signal: AbortSignal): Promise<string> {
  const url = `https://raw.githubusercontent.com/${REPO}/${tag}/${path}`;
  const response = await fetch(url, { signal });

  if (!response.ok) throw new Error(`github said ${response.status} fetching ${path}`);

  return response.text();
}

/** Where the bundled copies live, relative to the built `dist/`. */
function fallbackDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "fallback");
}

async function bundled(): Promise<Deployment> {
  const dir = fallbackDir();

  return {
    tag: null,
    compose: await readFile(join(dir, "firetower.yml"), "utf8"),
    caddyfile: await readFile(join(dir, "Caddyfile"), "utf8"),
  };
}

export interface FetchOptions {
  /** Pin to a tag instead of asking for the latest. For reproducing a report. */
  tag?: string;
  timeoutMs?: number;
}

/**
 * Fetch the deployment files, falling back to the bundled copies.
 *
 * Never throws on a network failure — an install that can reach a warm image
 * cache but not GitHub should still work, loudly. It throws only when the
 * fallback is also unreadable, which means a broken package.
 */
export async function deployment(options: FetchOptions = {}): Promise<Deployment> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

  try {
    const tag = options.tag ?? (await latestTag(controller.signal));

    const [compose, caddyfile] = await Promise.all([
      raw(tag, "deploy/firetower.yml", controller.signal),
      raw(tag, "deploy/Caddyfile", controller.signal),
    ]);

    return { tag, compose, caddyfile };
  } catch {
    return bundled();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Caddy refuses an empty `email`, which is why the file in the main repository
 * leaves the block out entirely — a config that will not start is a worse
 * default than a missing warning. Having a value, we can add it, and Let's
 * Encrypt will warn before a renewal that has started failing.
 */
export function withAcmeEmail(caddyfile: string, email: string | null): string {
  if (!email) return caddyfile;

  return `{\n\temail ${email}\n}\n\n${caddyfile}`;
}

/**
 * The postgres image the compose file asks for, so `upgrade` can refuse to
 * cross a major version.
 *
 * Recreating a Postgres container on a new major does not fail loudly: it
 * starts, finds a data directory it cannot read, and the deployment is down
 * until somebody runs pg_upgrade by hand.
 */
export function postgresMajor(compose: string): number | null {
  const match = /image:\s*postgres:(\d+)/.exec(compose);
  return match?.[1] ? Number(match[1]) : null;
}
