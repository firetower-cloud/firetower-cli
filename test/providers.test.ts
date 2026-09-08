import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROVIDERS,
  COMMON,
  MULTI_FIELD,
  KNOWN_REPLACE,
  TOKEN_HINT,
  isKnownProvider,
  providerBlock,
  propagationSettings,
  suggest,
} from "../src/providers.js";
import { derive, resolveProvider } from "../src/shape.js";
import { withProviderBlock } from "../src/upstream.js";

/**
 * The typed list, and the failure it exists to prevent.
 *
 * `DNS_PROVIDER` is interpolated into a Go module path and compiled into
 * Caddy. A typo is therefore not a bad-credential response a minute later — it
 * is a Go build failing several minutes in, after every other question has been
 * answered, with an error naming a module the operator never typed.
 */

describe("the list", () => {
  it("has every caddy-dns module, not a curated dozen", () => {
    // A round number here would mean somebody trimmed it. The point of the list
    // is that choosing from it is never the reason something is unsupported.
    expect(PROVIDERS.length).toBeGreaterThan(80);
  });

  it("offers the single-token ones as a menu", () => {
    // The rest are reachable by typing. These are the ones the Caddyfile's
    // one-line `dns {$DNS_PROVIDER} {env.DNS_API_TOKEN}` can express.
    for (const { value } of COMMON) expect(isKnownProvider(value)).toBe(true);
    for (const { value } of COMMON) expect(MULTI_FIELD.has(value)).toBe(false);
  });

  it("knows which ones need more than a token", () => {
    for (const name of MULTI_FIELD) expect(isKnownProvider(name)).toBe(true);
  });

  it("agrees with the Dockerfile about what a module path looks like", () => {
    // The Dockerfile passes anything with a slash through untouched and
    // prefixes everything else with github.com/caddy-dns. A name in this list
    // containing a slash would be prefixed and fail to resolve.
    for (const name of PROVIDERS) expect(name).not.toContain("/");
  });
});

describe("resolveProvider", () => {
  it("takes a real module", () => {
    expect(resolveProvider("cloudflare")).toEqual({ provider: "cloudflare" });
  });

  it("catches the typo, and says what was meant", () => {
    const result = resolveProvider("cloudflares");

    expect(result).toHaveProperty("problem");
    expect("problem" in result && result.problem).toContain("did you mean cloudflare");
  });

  it("catches a plausible wrong name too", () => {
    expect("problem" in resolveProvider("digital-ocean")).toBe(true);
    expect("problem" in resolveProvider("route52")).toBe(true);
  });

  it("does not guess when nothing is close", () => {
    const result = resolveProvider("mycompanydnsthing");

    expect("problem" in result && result.problem).not.toContain("did you mean");
    expect("problem" in result && result.problem).toContain("github.com/caddy-dns");
  });

  it("lets a full module path through, which is the documented escape", () => {
    // For a provider that is not under caddy-dns, or one added since this CLI
    // was published. Refusing these would make the list a ceiling rather than a
    // spellchecker.
    expect(resolveProvider("github.com/libdns/somethingnew")).toEqual({
      provider: "github.com/libdns/somethingnew",
    });
  });

  it("takes `none`, which is the bring-your-own answer", () => {
    expect(resolveProvider("none")).toEqual({ provider: "none" });
  });

  it("trims, because a pasted token often brings whitespace with it", () => {
    expect(resolveProvider("  cloudflare\n")).toEqual({ provider: "cloudflare" });
  });

  it("refuses an empty answer", () => {
    expect("problem" in resolveProvider("   ")).toBe(true);
  });
});

describe("suggest", () => {
  it("stops guessing past two edits", () => {
    expect(suggest("cloudflare")).toBe("cloudflare");
    expect(suggest("cloudflar")).toBe("cloudflare");
    expect(suggest("zzzzzzzzzzzz")).toBeNull();
  });
});

describe("the shipped Caddyfile.dockerfile", () => {
  it("prefixes a bare name and passes a path through", () => {
    // The two halves of the contract this list depends on, read from the file
    // that implements it rather than assumed.
    const dockerfile = readFileSync(
      join(import.meta.dirname, "..", "fallback", "Caddyfile.dockerfile"),
      "utf8",
    );

    expect(dockerfile).toContain("github.com/caddy-dns/${DNS_MODULE}");
    expect(dockerfile).toContain('*/*) module="${DNS_MODULE}"');
    expect(dockerfile).toContain('"" | none)');
  });
});

describe("modules that need a dependency substituted", () => {
  it("carries the vercel workaround, because it does not build without one", () => {
    // caddy-dns/vercel v0.0.2 — the only tag there is — pins libdns/vercel
    // v0.0.2, written against the libdns.Record struct from before v1 made it
    // an interface. Without this the build fails three minutes in, with
    // `r.Type undefined`, naming a package nobody chose.
    expect(KNOWN_REPLACE.vercel).toBe(
      "github.com/libdns/vercel=github.com/libdns/vercel@v0.1.0",
    );
  });

  it("only names modules that are in the list", () => {
    for (const name of Object.keys(KNOWN_REPLACE)) expect(isKnownProvider(name)).toBe(true);
  });

  it("uses the old=new@version form xcaddy --replace wants", () => {
    for (const value of Object.values(KNOWN_REPLACE)) {
      expect(value).toMatch(/^[^=]+=[^=]+@[^=]+$/);
    }
  });

  it("is applied to .env rather than hidden in the build", () => {
    // Written out so it can be found and deleted when upstream tags a release.
    // A substitution applied invisibly would outlive the reason for it.
    const written = derive(
      {
        kind: "domain",
        domain: "ft.example.com",
        dnsProvider: "vercel",
        dnsToken: "tok",
        address: "100.64.0.1",
      },
      { http: 8080, https: 443, configurable: true, bindable: true },
    );

    expect(written.DNS_MODULE_REPLACE).toBe(KNOWN_REPLACE.vercel);
  });

  it("writes nothing for a module that builds as published", () => {
    const written = derive(
      {
        kind: "domain",
        domain: "ft.example.com",
        dnsProvider: "godaddy",
        dnsToken: "key:secret",
        address: "100.64.0.1",
      },
      { http: 8080, https: 443, configurable: true, bindable: true },
    );

    expect(written).not.toHaveProperty("DNS_MODULE_REPLACE");
  });
});

describe("the token hints", () => {
  it("spells out GoDaddy's, which is a key and a secret joined by a colon", () => {
    // libdns/godaddy takes one string, but it is KEY:SECRET. Pasting the key
    // alone passes every prompt and fails only at issuance, with an
    // authentication error that says nothing about the format.
    expect(TOKEN_HINT.godaddy).toContain("KEY:SECRET");
  });

  it("only hints at providers that are offered", () => {
    for (const name of Object.keys(TOKEN_HINT)) expect(isKnownProvider(name)).toBe(true);
  });
});

describe("the Caddyfile shape a provider needs", () => {
  const ONE_LINE = "dns {$DNS_PROVIDER} {env.DNS_API_TOKEN}";
  const caddyfile = readFileSync(
    join(import.meta.dirname, "..", "fallback", "Caddyfile"),
    "utf8",
  );

  it("ships the one-line form, which is right for a single-token provider", () => {
    expect(caddyfile).toContain(ONE_LINE);
    expect(withProviderBlock(caddyfile, "cloudflare")).toBe(caddyfile);
    // GoDaddy keeps the one-line form too — what it gains is the propagation
    // settings below it, which is a different edit in the same place.
    expect(withProviderBlock(caddyfile, "godaddy")).toContain(ONE_LINE);
  });

  it("replaces it with a block for a provider that takes several values", () => {
    // Not cosmetic. caddy-dns/route53 answers any inline argument with
    // `d.ArgErr()`, so the one-line form is a parse error and Caddy never loads
    // its config: it restarts for ever having logged one line about a token
    // nobody meant to give it. Verified against a real build.
    const written = withProviderBlock(caddyfile, "route53");

    expect(written).not.toContain(ONE_LINE);
    expect(written).toContain("dns {$DNS_PROVIDER} {");
    expect(written).toContain("https://github.com/caddy-dns/route53");
  });

  it("keeps the block valid Caddyfile — braces balanced, newline-separated", () => {
    // A `{$VAR}` substitution can carry a block only across newlines; braces on
    // one line are `Unexpected next token after '{' on same line`. The block is
    // written into the file rather than passed through .env for that reason.
    const block = providerBlock("azure");

    expect(block.split("\n").length).toBeGreaterThan(2);
    expect((block.match(/\{/g) ?? []).length).toBe((block.match(/\}/g) ?? []).length);
  });

  it("leaves a Caddyfile it did not write alone", () => {
    // Somebody's hand-written provider block must survive. Only the exact
    // shipped one-liner is ever rewritten.
    const edited = caddyfile.replace(ONE_LINE, "dns route53 {\n\t\t\tregion eu-west-1\n\t\t}");

    expect(withProviderBlock(edited, "azure")).toBe(edited);
  });
});

describe("what gets written for a provider with no single token", () => {
  const ports = { http: 8080, https: 443, configurable: true, bindable: true };
  const reach = (dnsProvider: string, dnsToken: string) =>
    ({
      kind: "domain" as const,
      domain: "ft.example.com",
      dnsProvider,
      dnsToken,
      address: "100.64.0.1",
    });

  it("writes no DNS_API_TOKEN, because there is no token to write", () => {
    // It used to write one anyway, from a prompt the operator was forced to
    // answer. A key nothing reads, in a file somebody reads later.
    const written = derive(reach("route53", ""), ports);

    expect(written.DNS_PROVIDER).toBe("route53");
    expect(written).not.toHaveProperty("DNS_API_TOKEN");
  });

  it("still writes one for a provider that has one", () => {
    expect(derive(reach("godaddy", "key:secret"), ports).DNS_API_TOKEN).toBe("key:secret");
  });
});

/**
 * The settings a slow DNS provider needs, written rather than suggested.
 *
 * A GoDaddy wildcard failed four times at 12-17 seconds and succeeded at 124.
 * The settings that fix it existed as a comment in the Caddyfile, which is a
 * thing you find *after* losing the hour — and the failure presents as an
 * authentication problem, so the hour goes on the token.
 */
describe("propagation settings", () => {
  const CADDYFILE = readFileSync(
    join(import.meta.dirname, "..", "fallback", "Caddyfile"),
    "utf8",
  );

  it("writes them live for a provider known to be slow", () => {
    const written = withProviderBlock(CADDYFILE, "godaddy");

    expect(written).toContain("\n\t\tpropagation_delay 2m");
    expect(written).toContain("\n\t\tpropagation_timeout 10m");
    expect(written).toContain("\n\t\tresolvers 1.1.1.1 8.8.8.8");
  });

  it("gives dns_ttl its unit, because a bare number takes the proxy down", () => {
    // `600` is not a duration. Caddy rejects the whole config rather than the
    // line, so the proxy does not start at all.
    expect(withProviderBlock(CADDYFILE, "godaddy")).toContain("\n\t\tdns_ttl 600s");
    expect(withProviderBlock(CADDYFILE, "godaddy")).not.toMatch(/dns_ttl \d+$/m);
  });

  it("writes none of it for a provider that does not need it", () => {
    // Two minutes of nothing at every install is the cost of a false entry on
    // that list, so it stays short.
    const written = withProviderBlock(CADDYFILE, "cloudflare");

    expect(written).not.toContain("\n\t\tpropagation_delay");
    expect(written).toBe(CADDYFILE);
  });

  it("still writes the provider block for one that needs both", () => {
    // Nothing on the slow list is multi-field today, but the two edits share a
    // line and must not silently drop one another.
    expect(propagationSettings("route53")).toEqual([]);
    expect(withProviderBlock(CADDYFILE, "route53")).toContain("dns {$DNS_PROVIDER} {\n");
  });
});
