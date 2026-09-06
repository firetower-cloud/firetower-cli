# @firetower/cli

Install, upgrade and inspect a [Firetower](https://usefiretower.com) deployment.

```sh
npm i -g @firetower/cli
firetower install
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

| Answer | Certificate | Control plane is published on | Proxy |
| --- | --- | --- | --- |
| Only from this machine | none | `127.0.0.1`, port yours to choose | none created |
| On a name, over HTTPS | **yours**, in `./certs` | `127.0.0.1`, behind Caddy | Caddy, on 443 |
| Behind a reverse proxy you already run | yours | `127.0.0.1`, port yours to choose | yours |

**None of the three puts Firetower on the internet.** That is deliberate rather
than an omission. The control plane holds every git token, every agent
credential and the root key, so whoever reaches it can erase the codebase of the
company that installed it — which is a poor trade for the convenience of an
automatic certificate.

### Only from this machine

The default, and the one to want. Nothing is published to the network, so you
reach it over an ssh tunnel from wherever you actually sit:

```sh
firetower install
```

The install prints the exact command at the end. This CLI will also run it for
you, from your own machine — it reads the port off the remote `.env` over the
same connection it is about to forward:

```sh
firetower tunnel you@your-server
firetower tunnel you@your-server --ssh-config   # the stanza, for the long term
```

Both sides use the same port number on purpose: it makes the address in your
browser match the one Firetower prints in notifications, and a forward onto a
port under 1024 would need root on *your* machine. That is also why `install`
recommends 8080 rather than 80.

### On a name, over HTTPS

For when a tunnel each is not reasonable — several people, on a network they
already share. Caddy terminates TLS in front of Firetower with a certificate
**you supply**, and the name never has to be reachable from the internet.

```sh
firetower install --domain firetower.example.com
```

Four things go with it:

1. A certificate at `certs/fullchain.pem` and `certs/privkey.pem` in the install
   directory. It must cover **both** `firetower.example.com` and
   `*.firetower.example.com` — previews are served on subdomains, so a
   bare-name certificate leaves them broken. Mint it wherever your DNS
   credentials already live and copy the result in; the credential never
   touches the server.
2. Both names in DNS, pointing at this machine. A private address is the right
   answer:

   ```
   firetower.example.com     A   10.0.0.5
   *.firetower.example.com   A   10.0.0.5
   ```

3. `install` writes `COMPOSE_PROFILES=tls`, which is what creates the Caddy
   container at all. Without it there is no proxy.
4. **Renewal is yours.** Nothing here obtains the certificate, so nothing here
   renews it. `firetower doctor` warns when there are under three weeks left.

### Behind a reverse proxy you already run

Tell the CLI what your proxy serves — with it in front, nothing here can work
that out, and it is the address printed at the end and carried in every
notification:

```sh
firetower install --public-url https://firetower.example.com --http-port 8080
```

Firetower then serves plain HTTP on `127.0.0.1:8080` for your proxy to pass
through to.

### Older releases

Choosing the ports needs a Firetower release that reads `HTTP_PORT`, and holding
the control plane to loopback needs one that reads `HTTP_BIND`. Against an older
one the CLI says so rather than writing a value nothing honours — and in the
second case it says plainly that the release publishes on every interface,
rather than promising a privacy it cannot deliver.

## Requirements

Docker, the Compose plugin, and Node 20 or newer on the machine you are
installing onto. Node comes with npm, which you needed to install this.

## Commands

```
firetower install              install the control plane on this machine
firetower tunnel <dest>        forward a loopback control plane to your machine
firetower upgrade              upgrade it, then report which workers lag
firetower status               version, health, hosts, worker drift
firetower doctor               diagnose a deployment that isn't working
firetower logs [service] [-f]  tail it
firetower start | stop | restart
firetower backup [--out DIR]   pg_dump plus the root key
firetower uninstall            tear it down, asking separately about volumes

firetower worker install       install a worker on THIS machine
firetower worker upgrade       drain-aware worker upgrade
firetower worker status

firetower --version            this CLI's version, and the deployed one
```

Global flags: `--dir <path>` (remembered after `install`), `--yes` for
unattended runs, `--json` on any command that answers a question.

`install` flags: `--domain`, `--public-url`, `--http-port`, `--https-port`,
`--admin-username`, `--acme-email`. Each of the first two names one of the three
shapes above, so there is no combination to reconcile.

`tunnel` flags: `--local-port` when the remote port is taken on your machine,
`--remote-port` to skip reading the remote `.env`, `--ssh-config` to print a
stanza instead of connecting. It is the one command that runs somewhere other
than the machine Firetower is installed on, so it needs no `--dir` and does not
check the deployment's version.

## Unattended

```sh
firetower --yes install --domain firetower.example.com --admin-username admin
```

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
