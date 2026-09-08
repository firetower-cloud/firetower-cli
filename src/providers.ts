/**
 * Every DNS provider Caddy has a module for, by name.
 *
 * The list exists to stop a typo becoming a five-minute failure. `DNS_PROVIDER`
 * is interpolated into a Go module path and **compiled into Caddy**, so
 * `cloudflares` is not caught by a config parse or a bad-credential response —
 * it is caught by `go: module github.com/caddy-dns/cloudflares: not found`,
 * minutes into a build, after the operator has answered every other question.
 *
 * Taken from the repositories under https://github.com/caddy-dns, archived and
 * template ones left out. It will go out of date, which is why an unknown name
 * is a question rather than a refusal — see `resolveProvider`.
 */
export const PROVIDERS = [
  "acmedns",
  "acmeproxy",
  "alidns",
  "all-inkl",
  "arvancloud",
  "autodns",
  "azure",
  "bluecat",
  "bunny",
  "civo",
  "cloudflare",
  "cloudns",
  "conoha",
  "ddnss",
  "desec",
  "digitalocean",
  "dinahosting",
  "directadmin",
  "dnsexit",
  "dnsimple",
  "dnsmadeeasy",
  "dnspod",
  "dode",
  "domainnameshop",
  "dreamhost",
  "duckdns",
  "dynu",
  "dynv6",
  "easydns",
  "edgeone",
  "ednsde",
  "exoscale",
  "gandi",
  "gcore",
  "glesys",
  "godaddy",
  "googleclouddns",
  "he",
  "hetzner",
  "hexonet",
  "hosttech",
  "httpnet",
  "huaweicloud",
  "infomaniak",
  "inwx",
  "ionos",
  "katapult",
  "leaseweb",
  "liara",
  "linode",
  "loopia",
  "luadns",
  "mailinabox",
  "metaname",
  "mijnhost",
  "mythicbeasts",
  "namecheap",
  "namedotcom",
  "namesilo",
  "nanelo",
  "neoserv",
  "netcup",
  "netlify",
  "netnod",
  "nfsn",
  "nicrudns",
  "njalla",
  "openstack-designate",
  "oraclecloud",
  "ovh",
  "parspack",
  "porkbun",
  "powerdns",
  "pph",
  "regery",
  "regfish",
  "rfc2136",
  "route53",
  "scaleway",
  "selectel",
  "servercow",
  "simplydotcom",
  "spaceship",
  "tecnocratica",
  "tencentcloud",
  "thelittlehost",
  "timeweb",
  "totaluptime",
  "transip",
  "unifi",
  "vercel",
  "volcengine",
  "vultr",
  "websupport",
  "wedos",
  "westcn"
] as const;

/**
 * The ones offered as a list rather than typed.
 *
 * Not a judgement about which are good — it is which need **exactly one
 * credential**, because that is what the Caddyfile's one-line
 * `dns {$DNS_PROVIDER} {env.DNS_API_TOKEN}` can carry. Read out of each
 * module's own `UnmarshalCaddyfile`: a provider exposing `api_key` *and*
 * `api_secret_key` cannot be configured by a single token however willing it
 * is to accept one, and offering it here would produce a deployment that
 * parses, starts, and never gets a certificate.
 *
 * That is not hypothetical — namecheap, porkbun and ovh were on this list
 * until their sources were read. Everything else in PROVIDERS still works, and
 * still gets its module compiled in; it is typed rather than picked, and
 * `MULTI_FIELD` is what warns that its block has to be written by hand.
 */
export const COMMON: readonly { value: string; label: string }[] = [
  { value: "cloudflare", label: "Cloudflare" },
  { value: "digitalocean", label: "DigitalOcean" },
  { value: "hetzner", label: "Hetzner" },
  { value: "vercel", label: "Vercel" },
  { value: "godaddy", label: "GoDaddy" },
  { value: "desec", label: "deSEC" },
  { value: "gandi", label: "Gandi" },
  { value: "linode", label: "Linode" },
  { value: "vultr", label: "Vultr" },
  { value: "duckdns", label: "DuckDNS" },
];

/**
 * Where one token is not enough.
 *
 * Derived from each module's subdirectives rather than guessed: two or more of
 * them naming a credential — `api_key` and `api_secret_key`, or a client id, a
 * client secret and a tenant — means the one-line form cannot express it. The
 * module is still built and still chosen; the warning is that the provider
 * block has to be written into the Caddyfile by hand, which is a file
 * `firetower upgrade` leaves alone.
 *
 * Cloudflare is deliberately not here despite exposing two. `zone_token` is
 * optional — a single `api_token` is the ordinary configuration, and it is the
 * one this CLI has been end-to-end tested against.
 */
export const MULTI_FIELD = new Set([
  "acmedns",
  "acmeproxy",
  "alidns",
  "azure",
  "bluecat",
  "cloudns",
  "conoha",
  "ddnss",
  "dinahosting",
  "directadmin",
  "dnsimple",
  "dnsmadeeasy",
  "domainnameshop",
  "easydns",
  "edgeone",
  "exoscale",
  "hexonet",
  "huaweicloud",
  "inwx",
  "loopia",
  "mailinabox",
  "mythicbeasts",
  "namecheap",
  "namedotcom",
  "neoserv",
  "netcup",
  "oraclecloud",
  "ovh",
  "porkbun",
  "powerdns",
  "regery",
  "regfish",
  "rfc2136",
  "route53",
  "scaleway",
  "selectel",
  "servercow",
  "spaceship",
  "tencentcloud",
  "transip",
  "unifi",
  "websupport",
  "wedos",
  "westcn"
]);

/**
 * What the token actually is, where "API token" would send somebody looking for
 * the wrong thing.
 *
 * GoDaddy is the one that bites: `libdns/godaddy` takes a single string, but
 * that string is the key and the secret joined by a colon. Pasting the key
 * alone is accepted by every prompt, every file and every container start, and
 * fails at issuance with an authentication error that says nothing about the
 * format.
 */
export const TOKEN_HINT: Record<string, string> = {
  godaddy: "your key and secret joined by a colon — KEY:SECRET",
  gandi: "a Personal Access Token, not the older API key",
  desec: "the token from desec.io → Token Management",
  duckdns: "the token on your DuckDNS account page",
  vercel: "a Vercel access token, from Account Settings → Tokens",
  linode: "a Personal Access Token with read/write on Domains",
};

/**
 * Modules held back by something they depend on, and what to substitute.
 *
 * `caddy-dns/vercel` has only ever tagged v0.0.2, which pins
 * `libdns/vercel@v0.0.2` — written against the `libdns.Record` **struct**, from
 * before libdns v1 made it an interface. It does not compile against a current
 * Caddy: `r.Type undefined (type libdns.Record has no field or method Type)`,
 * three minutes into a Go build, naming a package the operator never chose.
 * `libdns/vercel@v0.1.0` is the updated one; caddy-dns simply has not tagged a
 * release using it.
 *
 * So the substitution is applied for them, and written into `.env` where it can
 * be seen and removed. **Delete the entry when upstream tags a release** — at
 * that point this pins an older dependency than the module asks for, which is
 * the opposite of helping.
 *
 * Verified by building it: `xcaddy --replace` produces a working Caddy 2.11.4
 * with `dns.providers.vercel` registered.
 */
export const KNOWN_REPLACE: Record<string, string> = {
  vercel: "github.com/libdns/vercel=github.com/libdns/vercel@v0.1.0",
};

/**
 * The Caddyfile `tls` body for a provider, which is not the same shape for all
 * of them.
 *
 * One credential fits the one-line form the shipped Caddyfile carries. Several
 * do not, and the difference is not cosmetic: `caddy-dns/route53` answers any
 * inline argument with `d.ArgErr()`, so `dns route53 <anything>` is a parse
 * error and Caddy never loads its config at all — it restarts for ever, having
 * logged one line about a token nobody meant to give it.
 *
 * So a multi-field provider gets the block form, empty, with a pointer. Empty
 * is a real configuration for several of them — the AWS and Azure SDKs read
 * their own environment variables — and it is a config that *parses*, which is
 * the difference between "finish this one step" and a container in a restart
 * loop.
 */
export function providerBlock(provider: string): string {
  if (!MULTI_FIELD.has(provider)) {
    return "dns {$DNS_PROVIDER} {env.DNS_API_TOKEN}";
  }

  return [
    "dns {$DNS_PROVIDER} {",
    `\t\t\t# ${provider} takes more than one value, so it cannot use the`,
    "\t\t\t# one-line form. Its settings go here:",
    "\t\t\t#",
    `\t\t\t#     https://github.com/caddy-dns/${provider}`,
    "\t\t\t#",
    "\t\t\t# Several of these read their own environment variables instead",
    "\t\t\t# (AWS_*, AZURE_*, GOOGLE_*), which belong on the caddy service in",
    "\t\t\t# firetower.yml. An empty block is valid, and is the right answer",
    "\t\t\t# when the SDK is already finding its credentials.",
    "\t\t}",
  ].join("\n");
}

export const isKnownProvider = (name: string): boolean =>
  (PROVIDERS as readonly string[]).includes(name);

/**
 * A full Go module path, which is the documented escape from this list.
 *
 * `Caddyfile.dockerfile` passes anything containing a slash through untouched,
 * so a provider that does not live under caddy-dns — or one added since this
 * CLI was published — is reachable without waiting for a release.
 */
export const isModulePath = (name: string): boolean => name.includes("/");

/**
 * The closest known name, for "did you mean". Levenshtein, capped at two edits
 * so that a genuinely different word does not get a confident wrong suggestion.
 */
export function suggest(name: string): string | null {
  let best: string | null = null;
  let bestDistance = 3;

  for (const candidate of PROVIDERS) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

function editDistance(a: string, b: string): number {
  // One row at a time: the strings here are short and the whole list is walked
  // for every check, so the allocation is worth avoiding.
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[b.length] ?? 0;
}
