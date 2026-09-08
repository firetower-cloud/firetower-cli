import { hostname, userInfo } from "node:os";
import * as prompts from "@clack/prompts";
import * as docker from "./docker.js";
import * as env from "./env.js";
import * as services from "./services.js";
import { localAddresses } from "./checks/machine.js";
import {
  COMMON,
  KNOWN_REPLACE,
  MULTI_FIELD,
  TOKEN_HINT,
  isKnownProvider,
  isModulePath,
  suggest,
} from "./providers.js";
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
  | {
      kind: "domain";
      domain: string;
      /**
       * The `github.com/caddy-dns` module Caddy is built with, and the name it
       * resolves the provider by at run time. `OWN_CERTIFICATE` for the
       * operator who supplies their own.
       */
      dnsProvider: string;
      /** A credential for that provider's API. Empty with `OWN_CERTIFICATE`. */
      dnsToken: string;
    }
  | { kind: "proxy"; publicUrl: string };

/**
 * The `domain` shape that does not want a certificate obtained for it.
 *
 * Spelled as a provider rather than as a fourth `Reach`, because that is what
 * the deployment reads it as: `DNS_PROVIDER=none` builds a Caddy with no DNS
 * module in it, and the Caddyfile's commented `tls /certs/…` line is the other
 * half. Making it a separate kind would mean every place that asks "is there a
 * domain" having to ask twice.
 *
 * It is the answer for a corporate CA, for a provider with no Caddy module, and
 * for a machine that cannot reach a Go module proxy to build one.
 */
export const OWN_CERTIFICATE = "none";

/** Whether this deployment supplies its own certificate rather than obtaining one. */
export function suppliesOwnCertificate(reach: Reach): boolean {
  return reach.kind === "domain" && reach.dnsProvider === OWN_CERTIFICATE;
}

/**
 * What `askReach` needs, which is the reach half of `InstallOptions`.
 *
 * Its own type so that `domain` — which changes the shape of a deployment that
 * already exists — can ask the same question without pretending to be an
 * install.
 */
export interface ReachOptions {
  domain?: string;
  publicUrl?: string;
  dnsProvider?: string;
  dnsToken?: string;
  yes?: boolean;
}

/**
 * A provider name, checked before anything is built with it.
 *
 * The check matters more here than the shape of it suggests. `DNS_PROVIDER` is
 * interpolated into a Go module path and compiled into Caddy, so `cloudflares`
 * survives every prompt, every write and every container start, and fails
 * minutes later inside a Go build with an error about a module nobody typed.
 *
 * Returns the name, or a message to show. A full module path is always allowed:
 * it is the documented escape for a provider that is not under caddy-dns, or
 * one added since this CLI was published.
 */
export function resolveProvider(raw: string): { provider: string } | { problem: string } {
  const name = raw.trim();

  if (!name) return { problem: "The module name, from https://github.com/caddy-dns" };
  if (name === OWN_CERTIFICATE) return { provider: OWN_CERTIFICATE };
  if (isModulePath(name)) return { provider: name };
  if (isKnownProvider(name)) return { provider: name };

  const closest = suggest(name);

  return {
    problem: closest
      ? `no caddy-dns module called ${name} — did you mean ${closest}?`
      : `no caddy-dns module called ${name}. See https://github.com/caddy-dns, or give a full module path.`,
  };
}

/**
 * How this deployment is reached.
 *
 * Three answers rather than yes-or-no, because "yes, a domain" used to mean two
 * things that need different deployments. Somebody who already runs nginx on 80
 * has a domain *and* cannot give Caddy the ports a certificate needs, and until
 * there was a third answer this CLI had nothing to offer them.
 *
 * None of the three publishes the control plane to the internet, and that is
 * not an omission. It holds every git token, every agent credential and the
 * root key; whoever reaches it can erase the codebase of the company that
 * installed it.
 *
 * `domain` used to mean "let Caddy get a certificate from Let's Encrypt", which
 * required exactly that exposure — and issued one certificate per preview
 * hostname, publishing each to Certificate Transparency logs even though a
 * preview hostname *is* the credential for that preview. It now means a
 * certificate obtained over **DNS-01**: the challenge is answered by writing a
 * TXT record through the provider's API, so every connection is outbound, the
 * name never has to be reachable, and one wildcard covers every preview without
 * naming any of them.
 */
export async function askReach(options: ReachOptions): Promise<Reach> {
  if (options.domain) {
    const named = options.dnsProvider?.trim();
    // `--domain` on its own has always meant "a certificate I supply", and a
    // script written against that must not silently start asking Let's Encrypt
    // for one — nor fail for want of a credential it was never written to
    // pass. Obtaining a certificate is opt-in, by naming a provider.
    const resolved = resolveProvider(named || OWN_CERTIFICATE);
    if ("problem" in resolved) stop(resolved.problem, "--dns-provider");

    // Said out loud rather than dropped quietly. A script passing --dns-token
    // to one of these has a credential it believes is in use.
    if (MULTI_FIELD.has(resolved.provider) && options.dnsToken) {
      ui.warn(
        `${resolved.provider} takes no single token, so --dns-token is not used`,
        `its settings go in a block in the Caddyfile — see https://github.com/caddy-dns/${resolved.provider}`,
      );
    }

    return {
      kind: "domain",
      domain: options.domain.trim(),
      dnsProvider: resolved.provider,
      dnsToken: MULTI_FIELD.has(resolved.provider) ? "" : (options.dnsToken ?? ""),
    };
  }
  if (options.publicUrl) return { kind: "proxy", publicUrl: trimUrl(options.publicUrl) };

  // `--domain ""` is how a script says "no domain", and has always meant that.
  if (options.domain === "" || options.yes) return { kind: "local" };

  const choice = await prompts.select({
    message: "How will people reach this Firetower?",
    options: [
      { value: "local", label: "Only from this machine, over an ssh tunnel  (recommended)" },
      { value: "domain", label: "On a name, over HTTPS" },
      { value: "proxy", label: "Behind a reverse proxy I already run" },
    ],
  });
  if (cancelled(choice)) stop("Nothing was written.");

  if (choice === "local") return { kind: "local" };

  if (choice === "domain") {
    const answer = await prompts.text({
      message: "Domain",
      placeholder: "firetower.example.com",
      validate: (value) =>
        value.trim() ? undefined : "A domain, or go back and choose another answer",
    });
    if (cancelled(answer)) stop("Nothing was written.");

    const domain = String(answer).trim();

    // Printed here, before the provider is chosen and long before anything is
    // written: both records have to exist for this to work, one of them is easy
    // to forget, and the moment to say so is while the operator is still in
    // their DNS console rather than after a failed install.
    showRecords(domain);

    const { dnsProvider, dnsToken } = await askCertificate(domain);

    return { kind: "domain", domain, dnsProvider, dnsToken };
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

export const trimUrl = (value: string): string => value.trim().replace(/\/+$/, "");

/**
 * The two records, with this machine's own address filled in where there is one.
 *
 * A real address rather than a placeholder: the whole difficulty of this step is
 * that the right answer is usually a *private* address, which is the opposite of
 * what people expect a public name to point at, and printing `10.0.0.5` from
 * this machine's own interfaces is the fastest way to say so.
 */
export function showRecords(domain: string): void {
  const address = localAddresses().find((value) => value.includes(".")) ?? "this machine";

  ui.blank();
  ui.step("Both of these have to exist, pointing at this machine:");
  ui.blank();
  ui.dim(`  ${domain}      A   ${address}`);
  ui.dim(`  *.${domain}    A   ${address}`);
  ui.blank();
  ui.step("The wildcard is not optional — previews are served on subdomains.");
  ui.step("A private address is the right answer here, and a public one usually");
  ui.step("is not: nothing about this has to be reachable from the internet.");
  ui.blank();
}

/**
 * Where the certificate comes from, which since DNS-01 is a question with a
 * good default rather than a chore.
 *
 * A list of the providers that take a single API token, then "something else"
 * — which is a typed answer checked against every caddy-dns module there is,
 * because this clack version has no autocomplete and ninety-six entries is not
 * a list anybody wants to arrow through.
 *
 * The token is a `password` prompt: it is a credential that can edit DNS for the
 * zone, and it should not sit in a terminal's scrollback the way a `text` answer
 * would.
 */
export async function askCertificate(
  domain: string,
): Promise<{ dnsProvider: string; dnsToken: string }> {
  const choice = await prompts.select({
    message: "Where should the certificate come from?",
    options: [
      ...COMMON.map((provider) => ({
        value: provider.value,
        label: `Let's Encrypt, through ${provider.label}`,
      })),
      { value: "other", label: "Let's Encrypt, through another DNS provider…" },
      { value: OWN_CERTIFICATE, label: "I already have a certificate" },
    ],
    initialValue: "cloudflare",
  });
  if (cancelled(choice)) stop("Nothing was written.");

  if (choice === OWN_CERTIFICATE) {
    ui.blank();
    ui.step(`Put fullchain.pem and privkey.pem in ./certs — covering both ${domain}`);
    ui.step(`and *.${domain}. Nothing will renew them for you.`);

    return { dnsProvider: OWN_CERTIFICATE, dnsToken: "" };
  }

  let provider = String(choice);

  if (provider === "other") {
    const typed = await prompts.text({
      message: "Which DNS provider? (the module name at github.com/caddy-dns)",
      placeholder: "route53",
      validate: (value) => {
        const resolved = resolveProvider(value);
        return "problem" in resolved ? resolved.problem : undefined;
      },
    });
    if (cancelled(typed)) stop("Nothing was written.");

    const resolved = resolveProvider(String(typed));
    if ("problem" in resolved) stop(resolved.problem);
    provider = resolved.provider;
  }

  // No token prompt for a provider that has no token. Asking anyway used to be
  // worse than useless: the answer was written to `.env` where nothing read it,
  // and the Caddyfile's one-line `dns <provider> <token>` was then handed an
  // argument that several of these modules reject outright — `route53` returns
  // `d.ArgErr()` for any inline value at all, so Caddy failed to load its
  // config and restarted for ever.
  if (MULTI_FIELD.has(provider)) {
    ui.blank();
    ui.warn(
      `${provider} needs more than one value, so it cannot use a single token`,
      `the module will be built in and its block written into the Caddyfile for you to fill in — see https://github.com/caddy-dns/${provider}`,
    );
    ui.blank();

    return { dnsProvider: provider, dnsToken: "" };
  }

  // The hint matters most where "API token" would send somebody looking for the
  // wrong string — GoDaddy's is a key and a secret joined by a colon, and
  // pasting the key alone fails only at issuance, with an authentication error
  // that says nothing about the format.
  const hint = TOKEN_HINT[provider];

  const token = await prompts.password({
    message: hint ? `API token for ${provider} — ${hint}` : `API token for ${provider}`,
    validate: (value) => (value ? undefined : "Caddy writes the DNS challenge record with it"),
  });
  if (cancelled(token)) stop("Nothing was written.");

  return { dnsProvider: provider, dnsToken: String(token) };
}

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
  if (domain) {
    // Read back rather than re-derived, and this is load-bearing for `upgrade`:
    // both are in `env.OWNED`, so they are cleared and rewritten from whatever
    // this returns. A token that did not survive this round trip would be
    // deleted from a working deployment by an upgrade that changed nothing
    // else.
    return {
      kind: "domain",
      domain,
      dnsProvider: (values.DNS_PROVIDER ?? "").trim(),
      dnsToken: values.DNS_API_TOKEN ?? "",
    };
  }

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
    // Which provider module Caddy is built with, and the credential it writes
    // the challenge record with. Only in the shape that has a certificate to
    // obtain: writing them otherwise would put a token in a file for a
    // container that is not created.
    ...(reach.kind === "domain"
      ? {
          DNS_PROVIDER: reach.dnsProvider,
          // Omitted rather than written empty for a provider configured by a
          // Caddyfile block: `DNS_API_TOKEN=` in a file somebody reads later is
          // a credential that looks lost rather than one that was never wanted.
          ...(reach.dnsToken ? { DNS_API_TOKEN: reach.dnsToken } : {}),
          // Only for a module whose own dependency will not build. Written out
          // rather than applied invisibly, so it can be found and deleted when
          // upstream catches up — see KNOWN_REPLACE.
          ...(KNOWN_REPLACE[reach.dnsProvider]
            ? { DNS_MODULE_REPLACE: KNOWN_REPLACE[reach.dnsProvider] }
            : {}),
        }
      : {}),
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

/** How this deployment is reached, in one line, for a plan block. */
export function describe(reach: Reach): string {
  if (reach.kind === "domain") return `${reach.domain}, over HTTPS`;
  if (reach.kind === "proxy") return `${reach.publicUrl}, behind your own proxy`;

  return "this machine only, over an ssh tunnel";
}

export function certificate(reach: Reach): string {
  if (reach.kind === "domain") {
    return suppliesOwnCertificate(reach)
      ? "yours, from ./certs — nothing renews it for you"
      : `Let's Encrypt, over DNS-01 through ${reach.dnsProvider} — renewed by Caddy`;
  }
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
