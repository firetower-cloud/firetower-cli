import * as prompts from "@clack/prompts";
import * as docker from "./docker.js";
import * as env from "./env.js";
import * as services from "./services.js";
import * as machine from "./checks/machine.js";
import {
  COMMON,
  KNOWN_REPLACE,
  MULTI_FIELD,
  TOKEN_HINT,
  isKnownProvider,
  keyUrl,
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
      /**
       * The address people reach this on — what both DNS records point at, and
       * what every screen that names an address prints.
       */
      address: string;
      /**
       * The address Caddy listens on. Written to `HTTPS_BIND`.
       *
       * The same as `address` whenever this machine holds it, which is every
       * deployment on a tailnet and every one on its own LAN. It is `0.0.0.0`
       * on a machine *reached* at an address it does not *have*: Google Cloud,
       * AWS and Azure each implement an external IP as NAT outside the guest,
       * so `os.networkInterfaces()` shows only the internal one and there is
       * nothing else to bind. A floating IP or a load balancer in front has
       * the same shape.
       *
       * They were one field until that case turned up, on the grounds that a
       * name is only useful if it resolves to where Caddy is listening. That
       * is still true — it is just not always expressible as one address.
       */
      bind: string;
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
  /** Which address Caddy listens on. See `Reach.bind`. */
  httpsBind?: string;
  /**
   * The address people reach it on, when that is not the address it listens
   * on. See `Reach.bind` — this is the flag for the machine behind NAT.
   */
  advertise?: string;
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
 * Two answers, and the difference between them is only who chooses the
 * address. **Mesh** detects it; **advanced** takes what is typed and checks
 * nothing.
 *
 * Checking nothing is the deliberate part. It used to classify the answer as
 * mesh, private or public and warn accordingly, which cannot be made correct:
 * on a Google Cloud VM `10.128.0.2` is an RFC1918 address that the whole
 * internet reaches through an external IP the guest never sees. A "private"
 * address that is publicly reachable. Since the two cannot be told apart from
 * here, advanced states the consequence once, before the prompt, and believes
 * the answer.
 *
 * Loopback is not one of the answers any more. It was the default for a year,
 * and `infer` still recognises it so that a deployment which has one keeps
 * upgrading — the refusal is about *choosing* it, exactly as with `proxy`.
 *
 * Both answers obtain the certificate over **DNS-01**: the challenge is
 * answered by writing a TXT record through the provider's API, so every
 * connection is outbound, the name never has to be reachable, and one wildcard
 * covers every preview hostname without naming any of them in a public
 * Certificate Transparency log.
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

    const { address, bind } = addressFromFlags(options);

    return {
      kind: "domain",
      domain: options.domain.trim(),
      dnsProvider: resolved.provider,
      dnsToken: MULTI_FIELD.has(resolved.provider) ? "" : (options.dnsToken ?? ""),
      address,
      bind,
    };
  }
  if (options.publicUrl) refuseProxy();

  // Both used to mean the loopback shape, which no longer installs. Said as a
  // refusal naming the flag rather than as a menu nobody is there to read: a
  // script written against the old meaning must fail loudly, not quietly
  // install something else.
  if (options.domain === "" || options.yes) {
    stop(
      "a domain is required",
      "pass --domain, --dns-provider and --dns-token. Installing on loopback is no longer a shape — see the README.",
    );
  }

  const choice = await prompts.select({
    message: "How will people reach this Firetower?",
    options: [
      {
        value: "mesh",
        label: "Tailscale or another mesh VPN",
        hint: "recommended — free, and takes 5 min",
      },
      {
        value: "custom",
        label: "Advanced (type my own IP)",
        hint: "public, your LAN, or a VPN you run",
      },
    ],
  });
  if (cancelled(choice)) stop("Nothing was written.");

  // Asked before the domain, and that order is the point. Somebody with no
  // reachable address has nothing to gain from typing a name and choosing a
  // certificate provider first, and this is the question that decides whether
  // the rest of it can work at all.
  const { address, bind } = choice === "mesh" ? await askMeshAddress() : await askCustomAddress();

  const answer = await prompts.text({
    message: "Domain",
    placeholder: "firetower.example.com",
    validate: (value) => (value.trim() ? undefined : "A domain — previews need one too"),
  });
  if (cancelled(answer)) stop("Nothing was written.");

  const domain = String(answer).trim();

  // The provider comes before the records, because the records screen names it
  // — "create these in GoDaddy" — and because the condition that actually
  // gates the certificate is about the provider, so it cannot be stated before
  // there is one.
  const { dnsProvider, dnsToken } = await askCertificate(domain);

  await showRecords(domain, address, dnsProvider);

  return { kind: "domain", domain, dnsProvider, dnsToken, address, bind };
}

/** An address and the interface it is served on. See `Reach.bind`. */
export interface Addressing {
  address: string;
  bind: string;
}

/**
 * The reverse-proxy shape, which is not a shape you can choose any more.
 *
 * It was never finished. Firetower serves preview hostnames itself, on the
 * `Host` header, and `FIRETOWER_PREVIEW_DOMAIN` is only written by the shape
 * that has a domain — so choosing this one left the server minting
 * `*.localhost` previews behind a proxy that could not route them. An interface
 * that works and previews that do not.
 *
 * Kept in the menu rather than deleted, because a removed option teaches
 * nobody anything and takes the signal that somebody wanted it with it.
 *
 * `infer` still returns this shape for a deployment that already has one, so
 * `upgrade` on such a deployment goes on working. The refusal is about
 * *choosing* it, not about having chosen it.
 */
function refuseProxy(): never {
  ui.blank();
  ui.step("Firetower serves preview hostnames itself, and routing those through");
  ui.step("a proxy you already run does not work today.");
  ui.blank();
  ui.step("If you want it, say so and it moves up the list:");
  ui.blank();
  ui.dim("  https://github.com/firetower-cloud/firetower/issues");
  ui.blank();

  return stop("Not supported yet. Nothing was written.");
}

/**
 * The mesh address, detected.
 *
 * A tailnet address is always configured on an interface of this machine, so
 * there is nothing to type and `bind` is always the address itself. That is
 * the whole reason this path is the recommended one: it is the only shape
 * where the CLI can be sure of the answer.
 *
 * Detection is still a heuristic — a WireGuard link somebody named `corp0` is
 * a good answer that no pattern will spot — so a single hit is named and
 * confirmed rather than pre-selected, and anybody whose mesh is not recognised
 * has the advanced path.
 */
export async function askMeshAddress(): Promise<Addressing> {
  const mesh = machine.candidateAddresses().filter((candidate) => candidate.kind === "mesh");

  if (mesh.length === 0) noMeshFound();

  const chosen = mesh.length === 1 && mesh[0] ? await confirmMesh(mesh[0]) : await pickMesh(mesh);

  ui.blank();
  ui.step(`Your domain will point at ${chosen}, and Firetower answers there`);
  ui.step("and nowhere else.");
  ui.blank();
  ui.step("Everyone who needs access has to be on the same tailnet — Tailscale");
  ui.step("installed on their laptop and added to your network. Without it the");
  ui.step("domain resolves and nothing answers.");
  ui.blank();

  return { address: chosen, bind: chosen };
}

/**
 * One mesh address, named and confirmed.
 *
 * A pre-selected answer is taken by anybody pressing Enter, and `tailscale0`
 * being the *right* address is still a guess — a machine can be on a tailnet
 * and be meant to serve its LAN. Naming it and taking a yes costs one
 * keystroke and removes the class of "it chose something and I did not
 * notice".
 */
async function confirmMesh(only: machine.Candidate): Promise<string> {
  // The reason goes above the prompt, not inside it. Clack wraps a long
  // message or hint to the left margin, which breaks the alignment of the
  // whole list and reads as a rendering fault.
  ui.blank();
  ui.ok("Mesh network detected", `${only.address} (${only.iface})`);
  ui.blank();

  const answer = await prompts.select({
    message: `Reach Firetower on ${only.address}?`,
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No — stop here" },
    ],
  });
  if (cancelled(answer)) stop("Nothing was written.");
  if (answer === "no") {
    stop("Nothing was written.", "run `firetower install` again and choose Advanced to type one");
  }

  return only.address;
}

/** Several mesh addresses, which is a real choice and needs no confirmation. */
async function pickMesh(mesh: machine.Candidate[]): Promise<string> {
  const choice = await prompts.select({
    message: "Which address will people reach this on?",
    options: mesh.map((candidate) => ({
      value: candidate.address,
      label: `${candidate.address}   ${candidate.iface}`,
      hint: "looks like a mesh VPN",
    })),
    initialValue: mesh[0]?.address,
  });
  if (cancelled(choice)) stop("Nothing was written.");

  return String(choice);
}

/**
 * The address, typed, with nothing checked.
 *
 * **Why nothing is checked.** Classifying the answer cannot be made correct.
 * On a Google Cloud VM the only address the guest holds is `10.128.0.2` — an
 * RFC1918 address that the entire internet reaches through an external IP
 * configured outside the guest. Calling that "private" would be a reassurance
 * about a public deployment. AWS and Azure are the same, and the reverse case
 * exists too: a routable address behind a firewall that answers nobody.
 *
 * So the consequence is stated once, before the prompt, and the answer is
 * believed. The only validation is that it parses as an IPv4 address —
 * loopback included, because this mode is named for knowing what you are
 * doing.
 */
export async function askCustomAddress(): Promise<Addressing> {
  ui.notice([
    "Firetower will be reached at the address you type, and will not",
    "check it. We assume you know what you are doing.",
    "",
    "If that address is reachable from the internet, so are:",
    "",
    "  - The control plane (protected by login only)",
    "      [holds your github secrets, your subscriptions,",
    "       your worker ssh keys]",
    "",
    "  - Every preview you open from the Desktop client (no protection)",
    "",
    "A mesh VPN avoids all of it — Tailscale is free and takes 5 minutes.",
  ]);

  const typed = await prompts.text({
    message: "Which address will people reach this on?",
    placeholder: "34.79.12.180",
    validate: (value) => (isIpv4(value) ? undefined : "not an IPv4 address"),
  });
  if (cancelled(typed)) stop("Nothing was written.");

  const address = String(typed).trim();

  // The one thing worth saying, and it is a fact about this machine rather
  // than a judgement about the address: Caddy cannot listen on an address that
  // is not here, so somebody has to say what it should listen on instead.
  if (machine.localAddresses().includes(address)) {
    ui.blank();
    ui.ok(`Firetower will bind ${address}, and answer there and nowhere else.`);
    ui.blank();

    return { address, bind: address };
  }

  ui.blank();
  ui.warn(`${address} is not an address of this machine`);
  ui.step("A machine behind NAT, a floating IP or a load balancer is reached at");
  ui.step("an address it does not hold — the traffic arrives on a different one.");
  ui.step("Firetower cannot listen on an address that is not here.");
  ui.blank();

  const listen = await prompts.text({
    message: "Which address should Firetower listen on?",
    initialValue: ANY_INTERFACE,
    validate: (value) => (isIpv4(value) ? undefined : "not an IPv4 address"),
  });
  if (cancelled(listen)) stop("Nothing was written.");

  return { address, bind: String(listen).trim() };
}

/** Every interface — what a machine behind NAT has to bind. */
export const ANY_INTERFACE = "0.0.0.0";

/**
 * Four decimal octets, and nothing more.
 *
 * Deliberately not a reachability test or a range check: see
 * `askCustomAddress`. This exists so that a domain name typed into the address
 * prompt is caught here rather than becoming an A record pointing at nothing.
 */
export function isIpv4(value: string): boolean {
  const parts = value.trim().split(".");

  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  );
}

/**
 * Nothing here looks like a mesh VPN, and mesh is what was asked for.
 *
 * Stopping rather than falling through to the advanced path: they are
 * different answers to a question that has just been asked, and quietly
 * turning one into the other is how somebody ends up with a deployment on an
 * address they did not choose.
 */
function noMeshFound(): never {
  const candidates = machine.candidateAddresses();

  ui.blank();
  ui.warn("No mesh network detected (Tailscale, WireGuard, …)");
  if (candidates.length > 0) {
    ui.step(`This machine has ${candidates.map((c) => c.address).join(", ")}.`);
  }
  ui.blank();
  ui.step("Install Tailscale, then run `firetower install` again:");
  ui.blank();
  ui.dim("  curl -fsSL https://tailscale.com/install.sh | sh");
  ui.dim("  sudo tailscale up");
  ui.blank();

  return stop("Nothing was written.", "or run `firetower install` again and choose Advanced");
}

/**
 * The addressing for the flag path, where nobody can be asked.
 *
 * `--https-bind` is what Caddy listens on; `--advertise` is what people reach,
 * for the machine behind NAT where those differ. Given neither, the single
 * mesh address, because that is the one case with nothing to decide.
 *
 * Everything else is a refusal naming the flag. Unattended is exactly where a
 * wrong answer goes unnoticed: the install finishes, the certificate is
 * issued, and the failure arrives days later as a browser that hangs.
 */
function addressFromFlags(options: ReachOptions): Addressing {
  const bound = options.httpsBind?.trim();
  const advertised = options.advertise?.trim();

  if (bound) return { address: advertised || bound, bind: bound };

  // Advertising without binding is answerable — bind everything — but only
  // because the address was named deliberately. Guessing the bind from the
  // interfaces here would pick the internal address on the exact machines this
  // flag exists for.
  if (advertised) return { address: advertised, bind: ANY_INTERFACE };

  const candidates = machine.candidateAddresses();
  const mesh = candidates.filter((candidate) => candidate.kind === "mesh");

  if (mesh.length === 1 && mesh[0]) return { address: mesh[0].address, bind: mesh[0].address };

  if (mesh.length === 0) {
    return stop(
      candidates.length > 0
        ? `nothing on this machine looks like a mesh VPN — only ${candidates.map((c) => c.address).join(", ")}`
        : "nothing on this machine looks like a mesh VPN",
      "name the address people will reach it on with --https-bind, or --advertise it and bind 0.0.0.0",
    );
  }

  return stop(
    `this machine has several mesh addresses — ${mesh.map((c) => c.address).join(", ")}`,
    "name the one people will reach it on with --https-bind",
  );
}

export const trimUrl = (value: string): string => value.trim().replace(/\/+$/, "");

/**
 * The two records, and a gate in front of writing anything.
 *
 * The address is the one just chosen rather than a guess off the first
 * interface, and the provider is named because by here it is known — which is
 * the reason the certificate question moved ahead of this one.
 *
 * The gate is not ceremony. Neither record blocks the *certificate*: DNS-01
 * proves control by writing `_acme-challenge` as TXT, and Let's Encrypt reads
 * back that and nothing else, so a certificate issues happily for a name with
 * no A record at all. What the records block is anybody reaching the thing —
 * and the wildcard blocks previews specifically, which is the half people
 * forget, because the interface works without it.
 */
export function printRecords(domain: string, address: string, provider: string): void {
  const where = provider === OWN_CERTIFICATE ? "your DNS provider" : providerLabel(provider);

  ui.blank();
  ui.step(`Create these DNS records in ${where}:`);
  ui.blank();
  ui.dim(`  ${domain}      A   ${address}`);
  ui.dim(`  *.${domain}    A   ${address}`);
  ui.blank();
  ui.step("The wildcard is not optional — previews are served on subdomains, and");
  ui.step("without it you get an interface that works and previews that do not.");
  ui.blank();
}

/** `printRecords`, and a gate. Split because the closing screen repeats the
 * records after everything is written, where there is nothing left to gate. */
export async function showRecords(
  domain: string,
  address: string,
  provider: string,
): Promise<void> {
  printRecords(domain, address, provider);

  const done = await prompts.select({
    message: "Done?",
    options: [
      { value: "yes", label: "Yes, continue" },
      { value: "no", label: "Not yet — stop, and I will run this again" },
    ],
  });
  if (cancelled(done) || done === "no") stop("Nothing was written.");
}

/** A provider's display name, falling back to the module name. */
function providerLabel(provider: string): string {
  return COMMON.find((entry) => entry.value === provider)?.label ?? provider;
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

  // Said here rather than earlier, because here is the first point at which it
  // can be said: the condition is about the provider, and until now there was
  // not one. This is also the thing that actually stops a certificate being
  // issued — the API accepts the write, the record never appears in DNS, and
  // the challenge fails with `No TXT record found` for a record that was
  // written successfully.
  ui.blank();
  ui.step(`Firetower gets the certificate by writing a record through`);
  ui.step(`${providerLabel(provider)}'s API, so ${domain} has to be hosted there. If its`);
  ui.step("DNS lives somewhere else the write succeeds and the record never appears.");
  ui.blank();
  ui.step("Create a key:");
  ui.blank();
  ui.dim(`  ${keyUrl(provider)}`);
  ui.blank();

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
 * Loopback, in every shape, because the thing being published holds every
 * credential Firetower has. Nothing needs more than that:
 *
 *   * Caddy is in front, and reaches 4400 over Compose's own network rather
 *     than through the published port;
 *   * the two shapes that are no longer installed but still upgrade — a
 *     loopback deployment reached over an ssh tunnel, and one behind a proxy
 *     somebody already runs — both terminate on this machine as well;
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
      // Same round trip, and for the same reason: both are in `env.OWNED`, so
      // `upgrade` clears them and writes back whatever `derive` is given. Not
      // reading them here would delete the bind from a working deployment on
      // an upgrade that changed nothing else — which is exactly what happened
      // before it was derived at all.
      //
      // `HTTPS_ADVERTISE` is absent on every deployment written before it
      // existed, and on every one where the two are the same — so the bind is
      // the fallback, which is what those deployments meant.
      address: (values.HTTPS_ADVERTISE || values.HTTPS_BIND || "").trim(),
      bind: (values.HTTPS_BIND ?? "").trim(),
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
    // Caddy's interface. Derived rather than left to the operator: it is in
    // `env.OWNED`, so a value written by hand was deleted by the next
    // `upgrade` or `domain` and never written back — silently rebinding Caddy
    // to 0.0.0.0, which on a machine with a public IP is the whole front door.
    ...(reach.kind === "domain" && reach.bind ? { HTTPS_BIND: reach.bind } : {}),
    // The address people reach it on, and the only value this CLI writes that
    // no container reads. It is here because it is not re-derivable: on a
    // machine behind NAT the address in the DNS records is on a router
    // somewhere, and nothing on this box remembers it. `doctor` compares
    // against it and `domain` reprints the records from it, and having them
    // each work it out separately is how the two come to disagree.
    //
    // Written only when it differs from the bind, so the ordinary deployment's
    // `.env` does not grow a line that restates the one above it.
    ...(reach.kind === "domain" && reach.address && reach.address !== reach.bind
      ? { HTTPS_ADVERTISE: reach.address }
      : {}),
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
 * Which ports this machine publishes. Two different things:
 *
 *   * `HTTP_PORT` is the control plane's own, published on loopback. Nothing
 *     outside this machine reaches it directly.
 *   * `HTTPS_PORT` is Caddy's, and it is the one other people actually open.
 *
 * The control plane's port has to be a high one, and in the shape that
 * installs today that is not a preference: Caddy publishes 80 to redirect, so
 * leaving the control plane there would collide. 8080 also keeps the older
 * loopback deployments — which still upgrade — forwardable without root on the
 * far end, a forward onto a port below 1024 needing it.
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
    // The bind, not the advertised address, and not just the ports. This is
    // the line people read to check what is actually listening — so on a
    // machine behind NAT it has to say `0.0.0.0` rather than the friendlier
    // address in the DNS records.
    const where = !reach.bind || reach.bind === ANY_INTERFACE ? "every interface" : reach.bind;
    const reached = reach.address && reach.address !== reach.bind ? `, reached at ${reach.address}` : "";

    return `${control} — and Caddy on ${where}${reached}, ports ${ports.https} and 80`;
  }

  return control;
}
