import { randomBytes } from "node:crypto";
import { readFile, writeFile, chmod } from "node:fs/promises";

/**
 * Reading, generating and writing `.env`.
 *
 * The whole file exists to enforce one rule, stated here because everything
 * else is in service of it: **a value already in `.env` is never replaced.**
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
 */

export type Env = Record<string, string>;

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
 * The file, with the comments that explain each decision.
 *
 * Written rather than templated from `deploy/.env.example`: that file is
 * addressed to somebody filling it in by hand, and half of it is instructions
 * for decisions this CLI has already made.
 */
export function format(values: Env): string {
  const line = (key: string) =>
    values[key] === undefined ? "" : `${key}=${render(values[key] ?? "")}\n`;

  return `# Firetower, written by @firetower/cli. Keep it beside firetower.yml.
#
# Everything here is a secret or a decision. Nothing regenerates it: re-running
# \`firetower install\` reads this file first and fills only what is missing.

# Where you reach Firetower. Blank serves plain HTTP on port 80.
${line("DOMAIN")}
# Only used for the URL printed on the first start — Firetower listens on 4400
# inside its container and cannot know what Caddy answers on.
${line("FIRETOWER_PUBLIC_URL")}
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
${line("ADMIN_USERNAME")}${line("ADMIN_INITIAL_PASSWORD")}`;
}

/** Write it, and make it unreadable to anyone else on the machine. */
export async function write(path: string, values: Env): Promise<void> {
  await writeFile(path, format(values), { mode: 0o600 });
  await chmod(path, 0o600);
}
