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

| Answer | Certificate | Published ports |
| --- | --- | --- |
| Only from this machine | none | yours to choose |
| On a public domain | Caddy gets one automatically | **80 and 443** |
| Behind a reverse proxy you already run | yours | yours to choose |

The ports are pinned by a domain and not by preference: Let's Encrypt answers the
certificate challenge on 80 and 443 specifically — HTTP-01 on one, TLS-ALPN on
the other — so a certificate cannot be issued anywhere else, and a challenge that
keeps failing earns a rate limit measured in days.

Every other shape is free to move, which is the answer when something already
holds 80. `install` reads which ports are free and offers the ones that are:

```sh
firetower install --http-port 8080 --https-port 8443
```

If a reverse proxy you already run is the thing holding 80, tell the CLI what it
serves — with your proxy in front, nothing here can work it out, and it is the
address printed at the end and carried in every notification:

```sh
firetower install --public-url https://firetower.example.com --http-port 8080
```

Firetower then serves plain HTTP on that port for your proxy to pass through to.
Choosing the ports needs a Firetower release that reads `HTTP_PORT`; against an
older one the CLI says so rather than writing a value nothing honours.

## Requirements

Docker, the Compose plugin, and Node 20 or newer on the machine you are
installing onto. Node comes with npm, which you needed to install this.

## Commands

```
firetower install              install the control plane on this machine
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
shapes above, so there is no combination to reconcile — and `--http-port`
alongside `--domain` is refused rather than quietly ignored.

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
