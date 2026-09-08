import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { propagationSettings, providerBlock } from "./providers.js";

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
  /**
   * The Dockerfile that builds Caddy with one DNS provider module in it.
   *
   * Not optional, even though only the `tls` profile builds anything: the
   * compose file's `caddy` service names it as its `dockerfile`, so a
   * deployment directory without it fails at `up` — with a build error about a
   * missing file rather than anything about certificates.
   */
  dockerfile: string;
  /**
   * Whether `dockerfile` is the bundled copy rather than the release's.
   *
   * True for a release that predates the file — which is not a failure, and so
   * must not be reported as the offline fallback that `tag: null` means.
   */
  dockerfileIsBundled: boolean;
}

interface Release {
  tag_name: string;
}

export async function latestTag(signal?: AbortSignal): Promise<string> {
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
    dockerfile: await bundledDockerfile(),
    dockerfileIsBundled: true,
  };
}

function bundledDockerfile(): Promise<string> {
  return readFile(join(fallbackDir(), "Caddyfile.dockerfile"), "utf8");
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

    const [compose, caddyfile, dockerfile] = await Promise.all([
      raw(tag, "deploy/firetower.yml", controller.signal),
      raw(tag, "deploy/Caddyfile", controller.signal),
      // Added to the main repository later than the other two, and a release
      // that predates it has no build section that needs one. A 404 here is
      // that release rather than a network failure, so it must not drag the
      // two files that *did* come back into the offline fallback — which would
      // install a stale compose file and blame GitHub for it.
      //
      // The bundled copy is harmless against such a release: nothing
      // references it. Whether that release can obtain a certificate at all is
      // a separate question, and `services.obtainsCertificates` is what asks
      // it.
      raw(tag, "deploy/Caddyfile.dockerfile", controller.signal)
        .then((text) => ({ text, bundled: false }))
        .catch(async () => ({ text: await bundledDockerfile(), bundled: true })),
    ]);

    return {
      tag,
      compose,
      caddyfile,
      dockerfile: dockerfile.text,
      dockerfileIsBundled: dockerfile.bundled,
    };
  } catch {
    return bundled();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The Caddyfile with the provider's own `dns` shape in it.
 *
 * The shipped file carries the one-line form, which is right for the providers
 * that take a single token and a parse error for the ones that do not. This is
 * the one edit the CLI makes to that file — and it is made once, at write time,
 * so what lands on disk is what Caddy will read and what the operator will edit
 * afterwards. `upgrade` never touches the Caddyfile, so both survive.
 *
 * Returns the file unchanged when the shape already matches, which is the
 * common case and also what happens against a release whose Caddyfile does not
 * carry that line at all.
 */
export function withProviderBlock(caddyfile: string, provider: string): string {
  const oneLine = "dns {$DNS_PROVIDER} {env.DNS_API_TOKEN}";
  if (!caddyfile.includes(oneLine)) return caddyfile;

  // Both edits land in the same place and are made together, so that what is
  // on disk after `install` is what Caddy reads and what the operator edits
  // afterwards. `upgrade` never touches this file, so both survive.
  const written = [providerBlock(provider), ...propagationSettings(provider)].join("\n");
  if (written === oneLine) return caddyfile;

  return caddyfile.replace(oneLine, written);
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

/**
 * What the current release demands of this CLI.
 *
 * Lives at `deploy/cli.json` in the main repository, so the repository that
 * makes a breaking change is the one that declares it:
 *
 *     { "minimumCli": "0.5.0", "reason": "the compose file now needs …" }
 *
 * Absent — which it is today — means no requirement. That has to stay true:
 * every release before the file existed must keep working, and a CLI that
 * treated a 404 as a failure would refuse to install perfectly good versions.
 */
export interface Requirements {
  minimumCli?: string;
  reason?: string;
}

export async function requirements(): Promise<Requirements | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      const tag = await latestTag(controller.signal);
      const url = `https://raw.githubusercontent.com/${REPO}/${tag}/deploy/cli.json`;
      const response = await fetch(url, { signal: controller.signal });

      // 404 is the normal answer until the main repository adds the file.
      if (!response.ok) return null;

      return (await response.json()) as Requirements;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}
