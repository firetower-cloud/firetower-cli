import { randomBytes } from "node:crypto";
import { readFile, writeFile, chmod } from "node:fs/promises";

/**
 * Reading, generating and writing `.env`.
 *
 * The rule this file enforces is about **sealed** values: `FIRETOWER_ROOT_KEY`,
 * `POSTGRES_PASSWORD` and the database identity are never replaced once they
 * exist.
 *
 * `FIRETOWER_ROOT_KEY` is why. Every credential Firetower holds is sealed with
 * it, so writing a new one over an existing database does not fail — it
 * succeeds, and every stored credential becomes undecryptable. Nobody finds out
 * until the next clone. `POSTGRES_PASSWORD` is the same shape of mistake with a
 * louder symptom: it is baked into the data directory at initdb, so rotating it
 * here locks the app out of its own database.
 *
 * Both are recoverable only from a backup, which is why `merge` fills absent
 * keys and does nothing else.
 *
 * **The rule stops there, and used not to.** The other keys this CLI writes —
 * `OWNED` below — are not secrets and not decisions anybody typed. They are
 * derived from the compose file and one answer about reachability, and holding
 * on to them across an upgrade is what turned a re-purposed `HTTP_PORT` into a
 * deployment that would not start: the value survived, its meaning did not, and
 * the control plane inherited a number that had described Caddy's port. So
 * `upgrade` recomputes them from the release it is moving to and writes them
 * over whatever was there. See `reshape`, and `shape.ts` for the derivation.
 */

export type Env = Record<string, string>;

/**
 * Never written over. Losing one of these loses the deployment.
 *
 * `POSTGRES_USER` and `POSTGRES_DB` sit with the two secrets because they are
 * fixed at initdb just as firmly: they name the role and the database inside a
 * data directory that already exists, and changing either leaves the control
 * plane authenticating against something that was never created.
 *
 * The administrator pair is here for a different reason. Both are ignored the
 * moment somebody has signed in, so rewriting them breaks nothing — but a
 * password this CLI generated and printed once is not a value to silently
 * replace with a second one nobody saw.
 */
export const SEALED = [
  "FIRETOWER_ROOT_KEY",
  "POSTGRES_PASSWORD",
  "POSTGRES_USER",
  "POSTGRES_DB",
  "ADMIN_USERNAME",
  "ADMIN_INITIAL_PASSWORD",
] as const;

/**
 * Recomputed on every upgrade, from the compose file being installed.
 *
 * A key in here that the new release has no use for is dropped rather than
 * carried: `HTTPS_PORT` in a deployment with no Caddy is a value nothing reads,
 * and leaving it in the file is how somebody later concludes their certificate
 * is served on a port it has never been served on.
 */
export const OWNED = [
  "DOMAIN",
  "HTTP_PORT",
  "HTTPS_PORT",
  "HTTP_BIND",
  "HTTPS_BIND",
  "COMPOSE_PROFILES",
  "FIRETOWER_PUBLIC_URL",
  "FIRETOWER_PREVIEW_DOMAIN",
] as const;

/**
 * The file as it should be after an upgrade: sealed values kept, owned values
 * replaced wholesale, everything else carried.
 *
 * The clearing step is the point. Assigning over the top would leave behind
 * exactly the keys that have stopped meaning anything — the ones the new
 * release does not read, which are also the ones most likely to be read back
 * later by a person and believed.
 */
export function reshape(existing: Env, owned: Env): Env {
  const next: Env = { ...existing };

  for (const key of OWNED) delete next[key];

  // Sealed values win over anything derived, which should never collide with
  // them, and this is cheaper than trusting that it never will.
  for (const [key, value] of Object.entries(owned)) {
    if ((SEALED as readonly string[]).includes(key) && existing[key]) continue;
    next[key] = value;
  }

  return next;
}

export interface Change {
  key: string;
  before?: string;
  after?: string;
}

/**
 * What `reshape` did, for printing before it is written.
 *
 * An upgrade that rewrites values is only acceptable if it says which ones, so
 * this is not a debugging aid — it is the part of the plan block that makes
 * overwriting somebody's file a thing they watched happen.
 */
export function changes(before: Env, after: Env): Change[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();

  return keys
    .filter((key) => before[key] !== after[key])
    .map((key) => ({ key, before: before[key], after: after[key] }));
}

/** A `.env` line: `KEY=value`, ignoring comments and blanks. */
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;

/**
 * Parse the subset of `.env` that Compose itself understands.
 *
 * Deliberately not a full dotenv implementation: this reads files we wrote, and
 * the one case worth handling beyond bare values is a quoted string, because a
 * generated password can contain `#` and a naive parser would treat the rest as
 * a comment.
 */
export function parse(text: string): Env {
  const env: Env = {};

  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const match = LINE.exec(line);
    if (!match) continue;

    const [, key, raw = ""] = match;
    if (!key) continue;

    env[key] = unquote(raw);
  }

  return env;
}

function unquote(raw: string): string {
  const value = raw.trim();

  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }

  // Only strip a comment from an unquoted value, and only when it is preceded
  // by whitespace — `pa#ssword` is a password, ` # note` is a note.
  return value.replace(/\s+#.*$/, "");
}

export async function read(path: string): Promise<Env | null> {
  try {
    return parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Everything in `existing` wins. `incoming` only fills keys that are absent or
 * empty.
 *
 * An empty value counts as absent because that is how `deploy/.env.example`
 * ships several of them — `FIRETOWER_ROOT_KEY=` means "not set", not "set to
 * the empty string", and Compose passes it through as empty either way.
 */
export function merge(existing: Env, incoming: Env): Env {
  const merged: Env = { ...existing };

  for (const [key, value] of Object.entries(incoming)) {
    const held = merged[key];
    if (held === undefined || held === "") merged[key] = value;
  }

  return merged;
}

/** Which keys `merge` refused to touch, so the caller can say so out loud. */
export function kept(existing: Env, incoming: Env): string[] {
  return Object.keys(incoming).filter((key) => {
    const held = existing[key];
    return held !== undefined && held !== "" && held !== incoming[key];
  });
}

/**
 * A password for the database.
 *
 * base64**url**, and the distinction is not cosmetic. The compose file builds
 * `postgres://user:${POSTGRES_PASSWORD}@postgres:5432/firetower`, so a `/` in
 * the password ends the authority section early and the control plane fails to
 * start with `invalid port number` — a message that says nothing about the
 * password that caused it. `+` and `=` are the same class of problem.
 *
 * base64url uses `-` and `_` instead, and dropping the padding leaves an
 * alphabet that survives a URL, a shell, and a YAML file unquoted. 24 bytes is
 * 32 characters of it.
 */
export function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * The key every stored credential is sealed with.
 *
 * Exactly 32 bytes, because that is what the server validates — base64 of 32
 * bytes is 44 characters ending in `=`, and anything else is refused at
 * start-up rather than used.
 */
export function generateRootKey(): string {
  return randomBytes(32).toString("base64");
}

/** What the server will accept. Checked here so a bad key fails before `up`. */
export function looksLikeARootKey(value: string): boolean {
  if (value.length !== 44 || !value.endsWith("=")) return false;

  try {
    return Buffer.from(value, "base64").length === 32;
  } catch {
    return false;
  }
}

/** Values that need quoting to survive Compose's parser. */
function render(value: string): string {
  return /[\s#'"$`\\]/.test(value) ? `"${value.replace(/(["\\$`])/g, "\\$1")}"` : value;
}

export interface Rendered {
  domain: string | null;
  publicUrl: string;
  adminUsername: string;
  adminPassword: string | null;
  env: Env;
}

/**
 * The keys this file knows how to explain, in the order it writes them.
 *
 * Anything else a deployment holds is written after them, untouched — see
 * `format`.
 */
const EXPLAINED = [
  "DOMAIN",
  "COMPOSE_PROFILES",
  "HTTP_BIND",
  "HTTP_PORT",
  "HTTPS_PORT",
  "FIRETOWER_PUBLIC_URL",
  "FIRETOWER_PREVIEW_DOMAIN",
  "POSTGRES_PASSWORD",
  "FIRETOWER_ROOT_KEY",
  "ADMIN_USERNAME",
  "ADMIN_INITIAL_PASSWORD",
];

/**
 * The file, with the comments that explain each decision.
 *
 * Written rather than templated from `deploy/.env.example`: that file is
 * addressed to somebody filling it in by hand, and half of it is instructions
 * for decisions this CLI has already made.
 *
 * Every other key is carried over verbatim at the end. Emitting only the ones
 * above would silently drop `FIRETOWER_TRUSTED_PROXY`, `POSTGRES_USER` and
 * anything a later release adds — from a file this CLI did not write all of,
 * and on a re-run that was only ever meant to fill in what was missing.
 */
export function format(values: Env): string {
  const line = (key: string) =>
    values[key] === undefined ? "" : `${key}=${render(values[key] ?? "")}\n`;

  return `# Firetower, written by @firetower/cli. Keep it beside firetower.yml.
#
# Everything here is a secret or a decision. Nothing regenerates it: re-running
# \`firetower install\` reads this file first and fills only what is missing.

# Where you reach Firetower. Blank serves plain HTTP, which is what you want
# when nothing outside this machine reaches it, and when a reverse proxy you
# already run is the thing holding the certificate.
${line("DOMAIN")}
# Which optional services exist. \`tls\` creates Caddy, which is the only thing
# that terminates a certificate; without it the control plane serves its own
# interface and API directly, and no proxy is created at all.
${line("COMPOSE_PROFILES")}
# Where the control plane is published, and this pair is not cosmetic. It holds
# every git token, every agent credential and the root key, so it goes on
# loopback and is reached over an ssh tunnel:
#
#   ssh -N -L PORT:127.0.0.1:PORT you@this-machine
#
# HTTP_PORT is the control plane's own port, not Caddy's. Widening HTTP_BIND to
# 0.0.0.0 puts the vault on the network, and \`ufw deny\` will not stop it —
# Docker's DNAT rules are consulted before the host's INPUT chain.
${line("HTTP_BIND")}${line("HTTP_PORT")}
# Caddy's, and only read with the tls profile on above. 443 unless something
# else on this machine already holds it.
${line("HTTPS_PORT")}
# Only used for the URL printed on the first start and in notifications —
# Firetower listens on 4400 inside its container and cannot know what is in
# front of it. The port belongs in here: over a tunnel the browser is at
# \`localhost:8080\`, and a URL saying \`localhost\` sends somebody to port 80 on
# their own machine.
${line("FIRETOWER_PUBLIC_URL")}
# What a session's preview hangs off. \`localhost\` needs no DNS at all — every
# browser resolves anything under it to the machine it is running on. With a
# domain, this is that domain, and \`*.that-domain\` needs a DNS record.
#
# **The hostname is the credential**: it carries a signature, and anyone holding
# one reaches that port of that session. Treat one like a share link.
${line("FIRETOWER_PREVIEW_DOMAIN")}
# The database.
${line("POSTGRES_PASSWORD")}
# The key every stored credential is sealed with, base64, 32 bytes.
#
# Back it up somewhere that is not your database backup. That separation is the
# point: a stolen database opens nothing on its own. Losing this key means
# adding every credential again.
${line("FIRETOWER_ROOT_KEY")}
# The administrator, created before anything listens. Once somebody has signed
# in and chosen a password these are ignored — never re-applied, never compared.
#
# Delete the password below once you have replaced it. It is plaintext here, and
# visible in \`docker compose config\`.
${line("ADMIN_USERNAME")}${line("ADMIN_INITIAL_PASSWORD")}${carried(values)}`;
}

/** Whatever else was in the file, kept rather than explained. */
function carried(values: Env): string {
  const rest = Object.keys(values).filter((key) => !EXPLAINED.includes(key));
  if (rest.length === 0) return "";

  return `\n# Kept from the file that was already here.\n${rest
    .map((key) => `${key}=${render(values[key] ?? "")}\n`)
    .join("")}`;
}

/** Write it, and make it unreadable to anyone else on the machine. */
export async function write(path: string, values: Env): Promise<void> {
  await writeFile(path, format(values), { mode: 0o600 });
  await chmod(path, 0o600);
}
