import { describe, it, expect } from "vitest";
import * as env from "../src/env.js";

describe("parse", () => {
  it("reads bare values, skipping comments and blanks", () => {
    expect(
      env.parse(`
# a comment
DOMAIN=firetower.example.com

POSTGRES_PASSWORD=hunter2
`),
    ).toEqual({ DOMAIN: "firetower.example.com", POSTGRES_PASSWORD: "hunter2" });
  });

  it("keeps a # that is part of a generated password", () => {
    // base64 has no #, but a password somebody typed might, and treating the
    // rest of the line as a comment would silently truncate it.
    expect(env.parse(`POSTGRES_PASSWORD="pa#ssword"`)).toEqual({
      POSTGRES_PASSWORD: "pa#ssword",
    });
  });

  it("strips a trailing comment from an unquoted value", () => {
    expect(env.parse("DOMAIN=example.com # the one we own")).toEqual({
      DOMAIN: "example.com",
    });
  });

  it("treats an empty value as empty, not as missing", () => {
    expect(env.parse("FIRETOWER_ROOT_KEY=")).toEqual({ FIRETOWER_ROOT_KEY: "" });
  });
});

describe("merge", () => {
  it("never replaces a value that is already there", () => {
    const existing = { FIRETOWER_ROOT_KEY: "the-original-key" };
    const incoming = { FIRETOWER_ROOT_KEY: "a-freshly-generated-key" };

    expect(env.merge(existing, incoming).FIRETOWER_ROOT_KEY).toBe("the-original-key");
  });

  it("fills a key that is absent", () => {
    expect(env.merge({}, { ADMIN_USERNAME: "admin" }).ADMIN_USERNAME).toBe("admin");
  });

  it("fills a key that is present but empty", () => {
    // deploy/.env.example ships several of these. Empty means "not set".
    expect(env.merge({ FIRETOWER_ROOT_KEY: "" }, { FIRETOWER_ROOT_KEY: "k" })).toEqual({
      FIRETOWER_ROOT_KEY: "k",
    });
  });

  it("reports what it refused to touch", () => {
    const existing = { FIRETOWER_ROOT_KEY: "original", ADMIN_USERNAME: "kevin" };
    const incoming = { FIRETOWER_ROOT_KEY: "new", ADMIN_USERNAME: "kevin" };

    // Only the one that would have changed. Reporting a value we would have
    // written identically is noise.
    expect(env.kept(existing, incoming)).toEqual(["FIRETOWER_ROOT_KEY"]);
  });

  it("survives a round trip through the file format", () => {
    const original = {
      POSTGRES_PASSWORD: env.generatePassword(),
      FIRETOWER_ROOT_KEY: env.generateRootKey(),
      ADMIN_USERNAME: "admin",
      ADMIN_INITIAL_PASSWORD: "cedar-lantern-quarry-418",
      DOMAIN: "",
      FIRETOWER_PUBLIC_URL: "http://localhost",
    };

    const read = env.parse(env.format(original));
    expect(env.merge(read, { FIRETOWER_ROOT_KEY: "something-else" }).FIRETOWER_ROOT_KEY).toBe(
      original.FIRETOWER_ROOT_KEY,
    );
  });
});

describe("generated secrets", () => {
  it("makes a root key the server will accept", () => {
    // 32 bytes of base64: 44 characters ending in `=`. Anything else is
    // refused at start-up rather than used.
    for (let i = 0; i < 200; i++) {
      const key = env.generateRootKey();
      expect(key).toHaveLength(44);
      expect(key.endsWith("=")).toBe(true);
      expect(env.looksLikeARootKey(key)).toBe(true);
    }
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(env.looksLikeARootKey("")).toBe(false);
    expect(env.looksLikeARootKey("too-short")).toBe(false);
    expect(env.looksLikeARootKey(Buffer.alloc(24).toString("base64"))).toBe(false);
    expect(env.looksLikeARootKey("x".repeat(44))).toBe(false);
  });

  it("does not repeat itself", () => {
    const keys = new Set(Array.from({ length: 100 }, () => env.generateRootKey()));
    expect(keys.size).toBe(100);
  });
});

describe("format", () => {
  it("quotes a value that would otherwise break the parser", () => {
    const text = env.format({ ADMIN_INITIAL_PASSWORD: "with spaces # and a hash" });
    expect(env.parse(text).ADMIN_INITIAL_PASSWORD).toBe("with spaces # and a hash");
  });

  it("omits a key it was not given", () => {
    expect(env.format({ DOMAIN: "example.com" })).not.toContain("POSTGRES_PASSWORD=");
  });
});

describe("the database password", () => {
  it("survives being interpolated into a connection string", () => {
    // The compose file builds postgres://user:${POSTGRES_PASSWORD}@postgres:5432/db.
    // A `/` in the password ends the authority section early and the control
    // plane dies with `invalid port number`, which names nothing useful.
    for (let i = 0; i < 500; i++) {
      const password = env.generatePassword();

      expect(password).toMatch(/^[A-Za-z0-9_-]+$/);

      const url = new URL(`postgres://firetower:${password}@postgres:5432/firetower`);
      expect(url.port).toBe("5432");
      expect(url.hostname).toBe("postgres");
      expect(decodeURIComponent(url.password)).toBe(password);
    }
  });

  it("is long enough to be worth generating", () => {
    expect(env.generatePassword().length).toBeGreaterThanOrEqual(32);
  });
});
