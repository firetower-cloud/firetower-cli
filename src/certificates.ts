import { connect, type PeerCertificate } from "node:tls";
import { randomBytes } from "node:crypto";
import * as prompts from "@clack/prompts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as docker from "./docker.js";
import { MULTI_FIELD } from "./providers.js";
import { servesWildcard, withBothNames } from "./upstream.js";
import { suppliesOwnCertificate, type Reach } from "./shape.js";
import { ui } from "./ui.js";

/**
 * Waiting for Caddy to have a certificate, before saying the deployment is up.
 *
 * `install` used to finish the moment the containers were healthy, which is
 * true and useless: Caddy is healthy long before Let's Encrypt has answered,
 * and the URL printed beside "Firetower is running" gives a browser
 * `ERR_SSL_PROTOCOL_ERROR` until it has. That is a bad first thirty seconds on
 * every provider, and on some it is minutes.
 *
 * **Why it can be minutes.** A deployment needs two certificates — the name and
 * `*.the-name`, because a wildcard does not cover the bare name — and Caddy
 * asks for both at once. ACME proves both at the *same* record,
 * `_acme-challenge.<domain>`, and a provider whose API replaces the records at
 * a name rather than adding to them (GoDaddy does) loses one of the two values
 * when the second write lands. One certificate is issued, the other fails and
 * retries a minute later, alone, and succeeds.
 *
 * So the wait is not an error path. It is the ordinary shape of a first
 * install on such a provider, and the only thing wrong with it was that
 * nothing said so.
 */

/**
 * How the certificate is checked, and why it is not the files on disk.
 *
 * `/data/caddy/certificates/` is tempting and wrong twice over: the directory
 * is named after whichever CA answered, so it is `acme-v02…` or
 * `acme-staging-v02…` depending on a fallback that happens silently, and a file
 * being written is not the same as Caddy serving it.
 *
 * So ask Caddy the way a browser does — connect, send the name in SNI, look at
 * what comes back. That answers the question actually being asked, which is not
 * "has a certificate been obtained" but "will somebody's browser be happy".
 */
async function certificateFor(
  host: string,
  port: number,
  servername: string,
): Promise<PeerCertificate | null> {
  return new Promise((resolve) => {
    const socket = connect({
      host,
      port,
      servername,
      // The point is to *read* the certificate, including the placeholder one
      // that would fail validation. Rejecting it here would throw away the
      // answer.
      rejectUnauthorized: false,
      timeout: 5000,
    });

    const done = (value: PeerCertificate | null) => {
      socket.destroy();
      resolve(value);
    };

    socket.once("secureConnect", () => done(socket.getPeerCertificate()));
    // Caddy not up yet, the port not published yet, a handshake that fails —
    // all of them mean "not ready", none of them mean "stop".
    socket.once("error", () => done(null));
    socket.once("timeout", () => done(null));
  });
}

/**
 * What Caddy serves before it has a real certificate.
 *
 * Not an error and not a failure state: Caddy answers TLS from the moment it
 * starts, with a certificate from its own internal CA, so a handshake succeeds
 * throughout. Telling the two apart is the whole check.
 */
const PLACEHOLDER = /caddy local authority/i;

/** Whether a name is covered, wildcards included. */
function covers(certificate: PeerCertificate, name: string): boolean {
  const names = (certificate.subjectaltname ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/^DNS:/, ""))
    .filter(Boolean);

  return names.some((candidate) => {
    if (candidate === name) return true;
    if (!candidate.startsWith("*.")) return false;

    // One label, and only one: `*.example.com` covers `a.example.com` and
    // neither `example.com` nor `a.b.example.com`.
    const suffix = candidate.slice(1);
    return name.endsWith(suffix) && !name.slice(0, -suffix.length).includes(".");
  });
}

async function isReady(host: string, port: number, name: string): Promise<boolean> {
  const certificate = await certificateFor(host, port, name);
  if (!certificate || !certificate.subjectaltname) return false;
  // `CN` is typed as string | string[]: a certificate may carry more than one,
  // and one of Caddy's placeholders would still be one of them.
  const issuedBy = certificate.issuer?.CN ?? "";
  const issuers = Array.isArray(issuedBy) ? issuedBy : [issuedBy];
  if (issuers.some((name) => PLACEHOLDER.test(name))) return false;

  return covers(certificate, name);
}

/**
 * Whether this deployment will ever have a certificate to wait for.
 *
 * Three shapes where waiting would be eight minutes spent on something that is
 * never going to happen:
 *
 *   * loopback and the proxy shape, which create no Caddy at all;
 *   * the operator's own certificate, which Caddy loads at start-up — there is
 *     nothing to obtain, and checking that the files parse is a different job;
 *   * a provider taking several values, whose Caddyfile block is deliberately
 *     written empty for the operator to fill in. `install` has just said so;
 *     waiting after that would be waiting for the thing it explained will not
 *     happen yet.
 */
export function willObtainCertificate(reach: Reach): boolean {
  if (reach.kind !== "domain") return false;
  if (suppliesOwnCertificate(reach)) return false;

  return !MULTI_FIELD.has(reach.dnsProvider);
}

export interface WaitOptions {
  /** The address Caddy is published on — `HTTPS_BIND`. */
  host: string;
  /** Its port — `HTTPS_PORT`. */
  port: number;
  domain: string;
  /** `--json`, where a spinner would be noise and the wait is unwanted. */
  quiet?: boolean;
  /** Overridden by the tests, which have no fifteen minutes to spare. */
  timeoutMs?: number;
  intervalMs?: number;
  /**
   * Which of the two to wait for.
   *
   * `install` waits for the bare name first, while that is the only one the
   * Caddyfile names, and for both once the wildcard has been put back. Waiting
   * for both in the first phase would be waiting for a certificate Caddy has
   * not been asked to obtain.
   */
  want?: "bare" | "both";
}

/**
 * Long enough for the retries, which is longer than it first looks.
 *
 * Eight minutes was the first guess and it was short. Each attempt takes about
 * 125 seconds — `propagation_delay` and then the check — and Caddy backs off
 * 60s, 120s, 240s between them. So a third attempt does not finish until about
 * nine minutes in, and a wildcard that needed one was reported missing by a
 * deployment that went on to obtain it two minutes later.
 *
 * Fifteen costs nothing in the ordinary case, because the wait ends the moment
 * both certificates answer — a Cloudflare install is out in seconds either way.
 * It is only spent where something is genuinely slow, and there the alternative
 * was a warning that resolved itself unattended.
 */
const TIMEOUT_MS = 15 * 60 * 1000;
const INTERVAL_MS = 3000;

/** Where the spinner starts saying *why* rather than just spinning. */
const EXPLAIN_AFTER_MS = 90 * 1000;

/**
 * Where it starts saying that leaving is allowed.
 *
 * Waiting fifteen minutes at a prompt is only tolerable if it is clear nothing
 * is riding on it. Caddy is retrying inside its own container and does not care
 * whether this process is still watching.
 */
const RELEASE_AFTER_MS = 5 * 60 * 1000;

export interface Waited {
  /** Both certificates are being served. */
  ready: boolean;
  /** The ones that are not, for the message that follows. */
  missing: string[];
}

/**
 * Wait for both certificates, saying which is outstanding.
 *
 * Never throws and never exits. A certificate that has not arrived is not a
 * broken deployment — it is one Caddy is still working on, and failing here
 * would invite somebody to re-run `install` over a deployment that is fine.
 */
export async function awaitCertificates(options: WaitOptions): Promise<Waited> {
  const { host, port, domain } = options;
  const timeout = options.timeoutMs ?? TIMEOUT_MS;
  const interval = options.intervalMs ?? INTERVAL_MS;

  // The wildcard cannot be asked for by name — `*.example.com` is not a
  // hostname — so it is asked for through one. A random label, so that a
  // record somebody happens to have created for a real subdomain cannot answer
  // for it. The same trick `doctor` uses on the DNS side.
  const probe = `probe-${randomBytes(3).toString("hex")}.${domain}`;

  const targets =
    options.want === "bare"
      ? [{ label: domain, servername: domain }]
      : [
          { label: domain, servername: domain },
          { label: `*.${domain}`, servername: probe },
        ];

  const started = Date.now();
  const done = new Set<string>();

  // Which of them this wait is actually for, decided before any of it lands.
  // The phased install calls this twice, and "Certificates obtained" twice over
  // reads as the same line printed by mistake — so each says what it got, and
  // the second does not re-announce the one the first already reported.
  const wanted: string[] = [];
  for (const target of targets) {
    if (await isReady(host, port, target.servername)) done.add(target.label);
    else wanted.push(target.label);
  }

  // No spinner where it cannot repaint. Clack moves the cursor to redraw its
  // line, which a pipe, a CI log or `--json` turns into one line per tick.
  const animated = !options.quiet && process.stderr.isTTY;
  const spinner = animated ? prompts.spinner() : null;

  spinner?.start("Waiting for certificates");
  if (!animated && !options.quiet) {
    ui.step("Waiting for certificates — Let's Encrypt, not us. Up to a few minutes.");
  }

  // The spinner owns the closing line when there is one. Without a TTY there is
  // no spinner, and the wait used to end in silence — a log that says it
  // started and never says how it went.
  const say = (message: string, failed = false) => {
    if (spinner) spinner.stop(message, failed ? 1 : 0);
    else if (!options.quiet && failed) ui.warn(message);
    else if (!options.quiet) ui.ok(message);
  };

  for (;;) {
    for (const target of targets) {
      if (done.has(target.label)) continue;
      if (await isReady(host, port, target.servername)) done.add(target.label);
    }

    const missing = targets.filter((t) => !done.has(t.label)).map((t) => t.label);
    if (missing.length === 0) {
      say(obtained(wanted, targets.map((target) => target.label)));
      return { ready: true, missing: [] };
    }

    const elapsed = Date.now() - started;
    if (elapsed >= timeout) {
      say(`No certificate yet for ${missing.join(" and ")}`, true);
      return { ready: false, missing };
    }

    spinner?.message(progress(missing, elapsed));
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * What was obtained, named.
 *
 * The phased install waits twice, and two lines both reading "Certificates
 * obtained" look like the same line printed by mistake. Each says which one it
 * got, and the second does not re-announce what the first already reported —
 * `wanted` is what was outstanding when that wait began.
 */
export function obtained(wanted: string[], all: string[]): string {
  if (wanted.length === 0) return `Certificate already in place for ${all.join(" and ")}`;
  if (wanted.length === 1) return `Certificate obtained for ${wanted[0]}`;

  return `Certificates obtained for ${wanted.join(" and ")}`;
}

/**
 * One line. Never more.
 *
 * This was a small table, and clack's spinner cannot repaint one: it redraws by
 * moving the cursor up a fixed number of lines, so anything taller than a line
 * scrolls instead of updating and the terminal fills with copies. Whatever is
 * said here has to fit on the line the spinner owns.
 */
export function progress(pending: string[], elapsed: number): string {
  const waiting = `Waiting for certificates (${elapsed >= 60000 ? `${Math.floor(elapsed / 60000)}m${Math.round((elapsed % 60000) / 1000)}s` : `${Math.round(elapsed / 1000)}s`})`;
  const names = pending.join(", ");

  // Held back, because most installs never wait long enough to need it and a
  // sentence about DNS providers on a twelve-second install is noise. Replaced
  // rather than added to once it has been said and the wait continues: by then
  // the useful thing is not the explanation but permission to stop watching.
  const why =
    elapsed >= RELEASE_AFTER_MS
      ? " — still retrying. Safe to Ctrl-C; Caddy carries on without you"
      : elapsed >= EXPLAIN_AFTER_MS
        ? " — both prove themselves at the same DNS record, so one often needs a retry"
        : "";

  return `${waiting} — ${names}${why}`;
}

/** What to say when the wait ran out. Caddy has not given up, so nor do we. */
export function reportMissing(dir: string, missing: string[]): void {
  ui.blank();
  ui.warn(
    `no certificate yet for ${missing.join(" and ")}`,
    "Caddy is still retrying on its own — the deployment is fine, the certificate is not here yet",
  );
  ui.blank();
  ui.dim(`  firetower --dir ${dir} logs caddy -f`);
  ui.blank();
}

/**
 * Put the wildcard back into the Caddyfile and have Caddy pick it up.
 *
 * The second half of the phased install. By here the bare name's certificate
 * is in `caddy_data`, so the reload asks for the wildcard and nothing else —
 * one writer at the challenge record, which is the whole point.
 *
 * **Validated before it is loaded, and never restarted.** `caddy reload` adapts
 * and checks the config before swapping, and keeps the running one if anything
 * is wrong, so the worst it can do is decline. A `restart` has no such
 * property: it reads the file from disk with nothing to fall back on, and a
 * file Caddy will not parse is a proxy that does not come up — `dns_ttl 600`
 * without its unit is enough to do that. So the fallback for a failed reload is
 * to say so, not to try something less safe.
 */
export async function reloadWithWildcard(
  dir: string,
  service: string,
): Promise<{ reloaded: boolean; problem?: string }> {
  const path = join(dir, "Caddyfile");
  const current = await readFile(path, "utf8").catch(() => null);

  if (current === null) return { reloaded: false, problem: "no Caddyfile to rewrite" };
  if (servesWildcard(current)) return { reloaded: true };

  await writeFile(path, withBothNames(current), "utf8");

  const checked = await docker.compose(
    { dir },
    "exec",
    "-T",
    service,
    "caddy",
    "validate",
    "--config",
    "/etc/caddy/Caddyfile",
    "--adapter",
    "caddyfile",
  );

  if (checked.exitCode !== 0) {
    // Put back what was serving. Leaving a file Caddy rejects on disk turns the
    // next ordinary restart — a reboot, `firetower start` — into an outage.
    await writeFile(path, current, "utf8");

    return { reloaded: false, problem: lastLine(checked.stderr) };
  }

  const reloaded = await docker.compose(
    { dir },
    "exec",
    "-T",
    service,
    "caddy",
    "reload",
    "--config",
    "/etc/caddy/Caddyfile",
  );

  // A rejected reload leaves Caddy running what it already had, which is the
  // bare name — a working dashboard and previews that do not resolve. The file
  // stays as written, because it is the one that should be there and `doctor`
  // reads the file rather than the running config.
  return reloaded.exitCode === 0
    ? { reloaded: true }
    : { reloaded: false, problem: lastLine(reloaded.stderr) };
}

function lastLine(stream: unknown): string {
  return String(stream ?? "").trim().split("\n").at(-1) ?? "";
}

/** What to say when the wildcard could not be put back. */
export function reportNotReloaded(dir: string, problem?: string): void {
  ui.blank();
  ui.warn(
    "the wildcard is not being served yet",
    problem || "Caddy declined the config; it is still serving the bare name",
  );
  ui.step("The dashboard works. Previews will not resolve until this is fixed:");
  ui.blank();
  ui.dim(`  firetower --dir ${dir} domain`);
  ui.blank();
}
