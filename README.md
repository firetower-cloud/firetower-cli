# @firetower/cli

Install, upgrade and inspect a [Firetower](https://usefiretower.com) deployment.

```sh
npm i -g @firetower/cli
firetower install --domain firetower.example.com
```

## What it does

`firetower install` checks the machine before it writes anything, asks a handful
of questions, generates the two secrets you would otherwise generate by hand, and
brings the stack up. It prints the administrator's password once and makes you
acknowledge the root key, because that key is the only unrecoverable thing here.

`firetower upgrade` pulls, recreates, waits for health — and then tells you which
of your machines are still running an older worker, naming each one and the
command to fix it. The control plane already compares its version against every
worker's on each handshake; this asks it, and turns the answer into something to
paste.

## How people will reach it

The first question, because the rest of the install follows from it:

| Answer | Caddy listens on | DNS records point at |
| --- | --- | --- |
| Tailscale or another mesh VPN | the tailnet address, detected | the same address |
| Advanced — an IP you type | what you type, or `0.0.0.0` | what you type |

Both obtain a Let's Encrypt certificate over DNS-01, and neither needs this
machine to be reachable from the internet to get one.

**There is no loopback install any more.** It was the default for a year, and
what it needed — `firetower tunnel`, one forward per person — stopped being a
reasonable thing to ask of a team. A deployment that already has that shape
keeps upgrading; it is only the choice that is gone, and `firetower domain`
moves one onto a name.

### Tailscale or another mesh VPN

The one to want, and the one where this CLI can be sure of the answer: a
tailnet address is always configured on an interface of this machine, so there
is nothing to type and nothing to get wrong.

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Disable key expiry for the machine in the Tailscale admin console while you are
there. Node keys lapse after 180 days by default, and a server that drops off
the tailnet is a Firetower nobody can reach, with nothing to say why.

Then:

```sh
firetower install --domain firetower.example.com \
  --dns-provider cloudflare --dns-token "$CLOUDFLARE_TOKEN"
```

Interactively it detects the address and confirms it. WireGuard, ZeroTier,
Nebula and anything on a `tun`/`utun` device are recognised too — it is not
Tailscale specifically, it is whatever looks like a network other people are
also on.

### Advanced — an IP you type

For a public address, a LAN, or a VPN whose interface nothing here recognises.
You type the address people will reach it on, and **nothing is checked**:

```sh
firetower install --domain firetower.example.com \
  --dns-provider cloudflare --dns-token "$TOKEN" \
  --https-bind 34.79.12.180
```

Nothing is checked because nothing *can* be. On a Google Cloud VM the only
address the guest holds is something like `10.128.0.2` — an RFC1918 address
that the entire internet reaches through an external IP configured outside the
VM. Calling that "private" would be a reassurance about a public deployment,
and the reverse case exists too: a routable address behind a firewall that
answers nobody. So the CLI states the consequence once, before the prompt, and
believes the answer.

The consequence, in full, is that on a publicly reachable address these are the
front door:

* **the control plane**, behind the login page — and it holds every git token,
  every agent credential and the root key;
* **every preview**, behind nothing at all. A preview hostname carries its own
  signature and that signature is the only thing in front of it.

A mesh VPN avoids both, which is why it is the recommendation rather than a
default somebody can talk themselves out of.

#### Behind NAT, a floating IP, or a load balancer

Google Cloud, AWS and Azure each implement an external address as NAT outside
the guest, so the machine is *reached* at an address it does not *have*. Caddy
cannot listen on an address that is not there, so the two become separate
facts:

```sh
firetower install --domain firetower.example.com \
  --dns-provider cloudflare --dns-token "$TOKEN" \
  --https-bind 0.0.0.0 --advertise 34.79.12.180
```

`--https-bind` is what Caddy listens on; `--advertise` is what the DNS records
point at, and what `firetower doctor` checks them against. Interactively you
are asked for the second one only when the first cannot be it — the prompt
comes prefilled with `0.0.0.0`.

Hetzner, DigitalOcean, Vultr, Linode and bare metal all configure the public
address on the interface itself, so none of them need this.

### Both of them need the two records

```
firetower.example.com     A   100.69.206.104
*.firetower.example.com   A   100.69.206.104
```

Pointing at whichever address you settled on. The wildcard is not optional:
previews are served at `<session>-<port>-<signature>.your-domain`, so a
deployment with the apex record alone gets an interface that works and previews
that do not resolve.

On a mesh those records are public and resolve for everybody — they simply only
*answer* for people on your tailnet.

`install` prints them with your address filled in and waits for you to say they
exist, and `firetower doctor` probes a random label under the domain
afterwards, to tell a wildcard record apart from a single one that happens to
exist.

### Why DNS-01, and what comes with it

The usual ACME challenges have Let's Encrypt connect **to you**, and a machine
Let's Encrypt can reach is a machine anyone can reach. DNS-01 proves control
the other way round: Caddy writes a TXT record through your provider's API and
the authority reads it back out of DNS. Every connection is outbound.

It is also the only challenge that can issue a **wildcard**, which this needs
twice over: previews are served on subdomains, and one wildcard keeps every
preview hostname out of the public Certificate Transparency logs — where a
hostname that *is* the credential for that preview does not belong.

That is why a public deployment needs a DNS provider token exactly as much as a
private one does. Going public does not simplify the install; the wildcard is
what requires DNS-01, and previews are what require the wildcard.

Four things go with it:

1. **DNS_PROVIDER is compiled into Caddy.** Caddy resolves DNS providers as
   compiled-in modules, so the `tls` profile builds its own image. The first
   `up` pulls a Go toolchain and takes a few minutes rather than seconds, and
   needs a reachable Go module proxy at that moment. It is cached afterwards.
2. `install` writes `COMPOSE_PROFILES=tls`, which is what creates the Caddy
   container at all. Without it there is no proxy.
3. **Renewal is Caddy's**, unattended, at about two-thirds of the certificate's
   life. `firetower doctor` reports the expiry and says who is responsible for
   it.
4. **Slow providers.** Some serve a record minutes after their API accepts it,
   and Caddy asks Let's Encrypt to validate within seconds — so the challenge
   fails with `No TXT record found` for a record that was written successfully,
   which reads like a bad token. GoDaddy is the measured case: a wildcard
   failed four times at 12-17 seconds and succeeded at 124. `install` writes
   `propagation_delay`, `propagation_timeout`, `dns_ttl` and `resolvers` into
   the `Caddyfile` for the providers known to need it, so there is nothing to
   do. For one that is not on that list, the file says which lines to add.

**Every** module under [github.com/caddy-dns](https://github.com/caddy-dns)
works — all ninety-odd of them — and the CLI knows their names. The interactive
prompt lists the dozen that take a single API token and lets you type any of
the rest; both the prompt and `--dns-provider` reject a name that is not one of
them, and suggest the closest:

```
$ firetower install --domain ft.example.com --dns-provider cloudflares
error: option '--dns-provider <module>' argument 'cloudflares' is invalid.
       no caddy-dns module called cloudflares — did you mean cloudflare?
```

That check earns its keep because the value is *compiled in*: an unchecked typo
does not fail at start-up with a bad credential, it fails several minutes into a
Go build, after every other question has been answered.

A full module path — `github.com/libdns/something` — is always accepted, for a
provider that is not under caddy-dns or one added since your CLI was published.

One caveat worth stating plainly: the CLI validates provider **names**, not that
a module currently compiles. A caddy-dns module can be held back by something it
depends on — `caddy-dns/vercel` is, today — and that surfaces as a Go build
error minutes in. `DNS_MODULE_REPLACE` in `.env` is the way past it, and the CLI
fills it in for the cases it knows about:

```
DNS_MODULE_REPLACE=github.com/libdns/vercel=github.com/libdns/vercel@v0.1.0
```

Delete that line once the module's maintainer tags a release.

Route 53, Azure, Google Cloud, Namecheap, Porkbun, OVH and about forty others
need several values and cannot be expressed by the Caddyfile's one-line form.
Choose them anyway, so the right module is built in, and write the provider
block by hand in the `Caddyfile`; the CLI warns when you pick one.
`firetower upgrade` rewrites `firetower.yml` and never touches the `Caddyfile`,
so the edit survives.


#### Bringing your own certificate

For a corporate CA, a provider with no Caddy module, or a machine that cannot
reach a Go module proxy:

```sh
firetower install --domain firetower.example.com
```

`--domain` without `--dns-provider` means exactly what it always did — a
certificate you supply. Put `fullchain.pem` and `privkey.pem` in `certs/`,
covering both the name and `*.the-name`, and uncomment the `tls` line in the
`Caddyfile`. Nothing renews it for you, and `firetower doctor` warns when there
are under three weeks left.

### Behind a reverse proxy you already run

**Not supported yet.** Firetower serves preview hostnames itself, on the `Host`
header, and routing those through a proxy you already run does not work — the
deployment went on minting `*.localhost` previews behind it, which is an
interface that works and previews that do not.

It is not an answer the CLI offers any more, and `--public-url` is gone with it.
A deployment that already has this shape keeps upgrading.

If you want it: <https://github.com/firetower-cloud/firetower/issues>

### Changing your mind later

`install` makes a deployment; it does not edit one. To move an existing one —
onto a mesh address after opening it up, onto a new name, or onto a rotated
token — use `firetower domain`:

```sh
firetower domain firetower.example.com          # asks the same questions install does
firetower domain firetower.example.com --dns-provider cloudflare --dns-token "$TOKEN"
firetower domain --https-bind 100.69.206.104    # same name, different address
```

It changes nothing about the release: no images are pulled, no migrations run,
no database is touched. It recomputes the values in `.env` that follow from the
answer, shows you the diff — with the API token masked — and recreates the
containers that have to read them.

It is also how a deployment installed on loopback gets a name, which is the one
way out of a shape that no longer installs.

### Older releases

Choosing the ports needs a Firetower release that reads `HTTP_PORT`, and holding
the control plane to loopback behind Caddy needs one that reads `HTTP_BIND`.
Against an older one the CLI says so rather than writing a value nothing
honours — and in the second case it says plainly that the release publishes on
every interface, rather than promising a privacy it cannot deliver.

## Requirements

Docker, the Compose plugin, and Node 20 or newer on the machine you are
installing onto. Node comes with npm, which you needed to install this.

## Commands

```
firetower install              install the control plane on this machine
firetower domain [name]        change the name or the address it is reached on
firetower upgrade              upgrade it, then report which workers lag
firetower status               version, health, hosts, worker drift
firetower doctor               diagnose a deployment that isn't working
firetower logs [service] [-f]  tail it
firetower start | stop | restart
firetower backup [--out DIR]   pg_dump plus the root key
firetower uninstall            tear it down, asking separately about volumes

firetower worker install       install a worker on THIS machine
firetower worker upgrade       drain-aware worker upgrade
firetower worker uninstall     remove it, and everything it holds
firetower worker reset         remove it, then install a fresh one
firetower worker status

firetower --version            this CLI's version, and the deployed one
```

Global flags: `--dir <path>` (remembered after `install`), `--yes` for
unattended runs, `--json` on any command that answers a question.

`install` flags: `--domain`, `--dns-provider`, `--dns-token`, `--https-bind`,
`--advertise`, `--http-port`, `--https-port`, `--admin-username`,
`--acme-email`.

`--https-bind` is the address Caddy listens on. `--advertise` is the address
people reach it on, and is needed only where the machine cannot bind that one —
behind NAT, a floating IP or a load balancer. Given neither, an unattended
install takes the single mesh address, or stops and names the flag when there
is no mesh address or more than one. It never guesses between several.

`worker uninstall` (also `worker remove`) takes the container, both named
volumes and the image — the worktrees, every uncommitted change in them, the
agents and the whole nested-Docker cache. It asks for the container's name
typed out rather than a `y/N`, because there is nothing left afterwards to put
any of it back from. `--dry-run` lists what would go and stops; `--keep-image`
leaves the image, which is the one thing on that list a pull brings back.

Two things it will not do. The `firetower` volume is shared by every worker on
the machine, so where a second one mounts it the volume stays and the command
says why. The image stays too where another container was built from it.
`worker reset` is the same removal — the image cache included, since a reset
that kept it would be a reset with a qualifier — followed by an install.

`firetower tunnel` is gone. It forwarded a control plane published on loopback,
and that shape no longer installs; running it now says so rather than answering
`unknown command`, for a release or two.

## Unattended

```sh
firetower --yes install --domain firetower.example.com \
  --dns-provider cloudflare --dns-token "$TOKEN" --admin-username admin
```

`--domain` is required: a `--yes` with no domain used to mean the loopback
shape, and now stops rather than quietly installing something else.

Generates the administrator password and writes the root key to
`firetower-root-key.txt` in the deployment directory, because there is nobody
there to read it off the terminal. Move it somewhere safe and delete it.

## Where the deployment files come from

`install` fetches `deploy/firetower.yml` and `deploy/Caddyfile` from the latest
release of
[firetower-cloud/firetower](https://github.com/firetower-cloud/firetower), so the
compose file always matches the images being pulled. Copies under `fallback/`
are used only when GitHub is unreachable, and the CLI says so when it uses them.

This is why they are not vendored: a copy that were authoritative would go
quietly out of step every time the main repository changed one.

## The rule this codebase is built around

**A value already in `.env` is never replaced.**

`FIRETOWER_ROOT_KEY` is why. Every credential Firetower holds is sealed with it,
so writing a new one over an existing database does not fail — it succeeds, and
every stored credential becomes undecryptable, and nothing says so until the next
clone. `POSTGRES_PASSWORD` is the same mistake with a louder symptom: it is baked
into the data directory at initdb.

`src/env.ts` reads first and fills only what is absent. There are unit tests for
it and an end-to-end test that installs twice and asserts the key survived.

## Staying current

`install`, `upgrade` and the `worker` commands ask two questions before they
touch anything: whether npm has a newer CLI, and whether the current Firetower
release *requires* one.

The second is the one with teeth. A release that changes what a deployment needs
declares it in `deploy/cli.json` in the main repository:

```json
{ "minimumCli": "0.5.0", "reason": "the compose file now needs FIRETOWER_X" }
```

A CLI below that minimum refuses to go on and offers to upgrade itself, because
an old CLI does not fail cleanly — it writes a `.env` missing a variable Compose
now requires, or waits on a service that has been renamed, and the error the
operator reads is about neither. A newer version merely existing on npm is a
note, not a block.

The file is absent today and that is a supported answer: no requirement. Being
unable to reach npm or GitHub is also not a block — offline is not a reason to
refuse to work. `--skip-version-check` opts out entirely.

## Versioning

Independent semver, starting at `0.1.0`. It tracks this CLI, not Firetower —
the two were coupled only while the CLI pinned image tags, and it uses `:latest`.

[release-please](https://github.com/googleapis/release-please) reads the commit
messages on `main` and keeps one open pull request — *chore(main): release
0.2.0* — carrying the version bump and the changelog entry. Nothing publishes
until that pull request is merged; merging it tags, and the tag triggers
`npm publish`. So cutting a release stays a review rather than a side effect of
merging a feature.

Below 1.0, `bump-minor-pre-major` keeps a breaking change on the minor.

## Commits

Conventional commits, enforced in CI. This is not a style rule: the messages are
the input to versioning, and one that says neither `feat:` nor `fix:` produces a
release that bumps nothing and explains nothing.

```
feat(install): preflight the machine before writing anything
fix(upgrade): read the database name from the compose file
```

Scopes: `install`, `upgrade`, `worker`, `doctor`, `status`, `backup`, `env`,
`ci`, `deps`. Headers stay under 72 characters.

CI checks the pull request **title** as well as the commits, and the title
matters more — a squash merge throws the commits away and keeps the title, which
is then the only thing release-please ever sees.

To catch it before pushing:

```sh
echo "feat(install): …" | pnpm commitlint
```

## Releasing

One secret, once: **`NPM_TOKEN`** — a granular npm automation token scoped to
publish `@firetower/cli` and nothing else. Settings → Secrets and variables →
Actions.

Nothing else is needed. release-please uses the built-in `GITHUB_TOKEN`, and the
workflow already declares the permissions it wants. One repository setting does
have to be on, though, or release-please fails opening its pull request with an
error that does not say so: Settings → Actions → General → **Allow GitHub
Actions to create and approve pull requests**.

Once `0.1.0` is on the registry the token can go away — npm trusted publishing
signs over OIDC with no stored credential, and the publish job already requests
the `id-token: write` it needs. It cannot be set up before then: a trusted
publisher is configured on the package's own settings page, and that page does
not exist until the package does.

## Development

```sh
pnpm install
pnpm build
pnpm test          # fast, no Docker
pnpm test:e2e      # drives a real daemon; minutes
```

## Licence

AGPL-3.0-only, the same as Firetower.
