# Bundled deployment files

Copies of `deploy/firetower.yml` and `deploy/Caddyfile` from
[firetower-cloud/firetower](https://github.com/firetower-cloud/firetower).

**These are a fallback, not a source.** `firetower install` fetches both from the
latest release of that repository and only reaches for these when GitHub is
unreachable — in which case it says so, because they may be older than the images
being pulled.

Because nothing depends on them being current, a stale copy here is harmless.
That is the whole reason the CLI fetches instead of vendoring: a copy that
*were* authoritative would go quietly out of step every time the main repository
changed one of them.

Refreshed occasionally by hand or by a bot PR. Never edited here.
