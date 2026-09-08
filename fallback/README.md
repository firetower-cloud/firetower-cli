# Bundled deployment files

Copies of `deploy/firetower.yml`, `deploy/Caddyfile` and
`deploy/Caddyfile.dockerfile` from
[firetower-cloud/firetower](https://github.com/firetower-cloud/firetower).

All three are written, not just the ones a given install reads. The compose
file names `Caddyfile.dockerfile` as the `caddy` service's `dockerfile`, and
Compose reads a build section whether or not the profile selects the service —
so a deployment directory missing it fails at `up` with a build error rather
than anything about certificates.

**These are a fallback, not a source.** `firetower install` fetches them from the
latest release of that repository and only reaches for these when GitHub is
unreachable — in which case it says so, because they may be older than the images
being pulled.

Because nothing depends on them being current, a stale copy here is harmless.
That is the whole reason the CLI fetches instead of vendoring: a copy that
*were* authoritative would go quietly out of step every time the main repository
changed one of them.

Refreshed occasionally by hand or by a bot PR. Never edited here.
