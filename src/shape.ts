import { hostname, userInfo } from "node:os";
import * as prompts from "@clack/prompts";
import * as docker from "./docker.js";
import * as env from "./env.js";
import * as services from "./services.js";
import { ui } from "./ui.js";

/**
 * The shape of a deployment: how it is reached, on which ports, and the `.env`
 * values that follow from those two answers.
 *
 * Split out of `install` because `upgrade` needs the same derivation. It used
 * to live only in `install`, and that is the whole reason a stale `HTTP_PORT`
 * survived an upgrade into a release that had re-purposed the name: `upgrade`
 * had no code that could work out what the value should be, so it kept the one
 * it had.
 *
 * **Everything here is derived, never migrated.** Given a compose file and one
 * answer about reachability, these functions say what the owned half of `.env`
 * has to contain. A release that renames a variable, or gives an existing one a
 * new meaning, costs nothing: the next `upgrade` recomputes it under the new
 * meaning rather than translating the old value forward.
 */

export type Reach =
  | { kind: "local" }
  | { kind: "domain"; domain: string }
  | { kind: "proxy"; publicUrl: string };

export interface Ports {
  http: number;
  https: number;
  /** Whether the release being written reads them at all. */
  configurable: boolean;
  /** Whether it reads `HTTP_BIND` — see `services.bindIsConfigurable`. */
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
export const LOOPBACK = "127.0.0.1";

export const STANDARD = { http: 80, https: 443 };
export const ALTERNATE = { http: 8080, https: 8443 };

export const cancelled = (value: unknown): boolean => prompts.isCancel(value);

export function stop(message: string, remedy?: string): never {
  ui.blank();
  ui.fail(message, remedy);
  ui.blank();
  process.exit(1);
}

/**
 * How this deployment is reached, read back out of a `.env` that already
 * exists.
 *
 * `upgrade` needs the answer `install` asked for, and asking again would be a
 * question with a right answer already on disk. The three shapes are
 * distinguishable without guessing:
 *
 *   * `DOMAIN` is only ever set by the shape that puts Caddy in front;
 *   * a `FIRETOWER_PUBLIC_URL` pointing anywhere but this machine is an
 *     address somebody else's proxy serves — nothing else writes one;
 *   * everything else is the loopback shape, which is also what an empty file
 *     means, and the safe answer to land on when in doubt.
 */
export function infer(values: env.Env): Reach {
  const domain = (values.DOMAIN ?? "").trim();
  if (domain) return { kind: "domain", domain };

  const url = (values.FIRETOWER_PUBLIC_URL ?? "").trim();
  if (url && !isLocal(url)) return { kind: "proxy", publicUrl: url };

  return { kind: "local" };
}

/** Whether a URL points at the machine it is written on. */
function isLocal(url: string): boolean {
  try {
    const { hostname: host } = new URL(url);
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    // Not a URL we can parse is not evidence of a proxy.
    return true;
  }
}

/**
 * The half of `.env` that this CLI owns, from the two answers above.
 *
 * Everything here is a consequence of `reach` and `ports`, which is what makes
 * it safe to overwrite: none of it is a secret, and none of it is a decision
 * that is not being re-made right now. `env.SEALED` is the other half, and it
 * is never touched.
 */
export function derive(reach: Reach, ports: Ports): env.Env {
  return {
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
  };
}

export interface PortOptions {
  httpPort?: number;
  httpsPort?: number;
  yes?: boolean;
}

/**
 * Ports this deployment's own containers already publish.
 *
 * Passed to `choosePorts` so they read as free. During an upgrade the running
 * stack holds the very port it is about to be restarted on, and without this
 * every deployment already on 8080 would be told 8080 was busy and steered off
 * it — by its own container.
 */
export type Held = ReadonlySet<number>;

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
export async function choosePorts(
  reach: Reach,
  compose: string,
  options: PortOptions,
  held: Held = new Set(),
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
      ? await firstFree(held)
      : await askPorts(held);

  if (reach.kind === "proxy") {
    ui.ok(`point your proxy at http://${LOOPBACK}:${chosen.http}`);
  }

  return { ...chosen, configurable, bindable };
}

export interface Pair {
  http: number;
  https: number;
}

/**
 * The unattended answer.
 *
 * `--yes` used to take ALTERNATE unconditionally, which is right for an
 * install onto a bare machine and wrong for an upgrade: a scripted upgrade on
 * a machine where 8080 belongs to something else would write a port the stack
 * then fails to bind, with nobody there to be asked. Walking up from 8080 is
 * the same answer a person would give at the prompt.
 */
async function firstFree(held: Held): Promise<Pair> {
  for (let http = ALTERNATE.http; http < ALTERNATE.http + 64; http++) {
    if (await isFree(http, held)) return { http, https: ALTERNATE.https };
  }

  // Sixty-four consecutive busy ports is not a port conflict, it is a machine
  // with something very wrong on it. Say the first one and let Compose's error
  // be about the port that was actually chosen.
  return ALTERNATE;
}

/** Free, or held by this deployment and about to be released. */
async function isFree(port: number, held: Held): Promise<boolean> {
  return held.has(port) || (await docker.portIsFree(port));
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
async function askPorts(held: Held): Promise<Pair> {
  const alternateIsFree = await isFree(ALTERNATE.http, held);

  const choices = [
    {
      value: "alternate",
      label: `${ALTERNATE.http} — ${alternateIsFree ? "free" : "in use"}`,
    },
  ];

  let recommended = "alternate";

  if (!alternateIsFree) {
    const standardIsFree = await isFree(STANDARD.http, held);
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
  const http = await askPort("Port", ALTERNATE.http, held);

  return { http, https: ALTERNATE.https };
}

async function askPort(
  message: string,
  initial: number,
  held: Held,
  taken?: number,
): Promise<number> {
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
    if (await isFree(port, held)) return port;

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
