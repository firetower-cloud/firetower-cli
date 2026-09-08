import { describe, expect, it, afterEach } from "vitest";
import { createServer, type Server } from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitCertificates, progress, willObtainCertificate } from "../src/certificates.js";
import type { Reach } from "../src/shape.js";

/**
 * Waiting for Caddy to serve a certificate, rather than for a file to exist.
 *
 * The check has to tell three states apart, and only one of them is "ready":
 * nothing listening, Caddy answering with its own placeholder, and a real
 * certificate. So these tests stand up an actual TLS server and point the
 * check at it — a mock would only prove the mock.
 */

/** A self-signed certificate for the names given, made with openssl. */
function selfSigned(subject: string, names: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "ft-cert-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");

  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "1",
    "-subj", `/CN=${subject}`,
    "-addext", `subjectAltName=${names.map((n) => `DNS:${n}`).join(",")}`,
  ], { stdio: "ignore" });

  return {
    key: readFileSync(key),
    cert: readFileSync(cert),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const servers: Server[] = [];

function serve(key: Buffer, cert: Buffer): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer({ key, cert }, (socket) => socket.end());
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const fast = { timeoutMs: 900, intervalMs: 50, quiet: true };

describe("waiting for certificates", () => {
  it("is satisfied by a certificate covering both the name and its wildcard", async () => {
    const { key, cert, cleanup } = selfSigned("example.test", [
      "example.test",
      "*.example.test",
    ]);
    const port = await serve(key, cert);

    const waited = await awaitCertificates({
      host: "127.0.0.1",
      port,
      domain: "example.test",
      ...fast,
    });

    expect(waited).toEqual({ ready: true, missing: [] });
    cleanup();
  });

  it("keeps waiting on the wildcard when only the bare name is covered", async () => {
    // The exact state a fresh GoDaddy install lands in, the other way round:
    // one certificate issued, the other lost to the race and retrying.
    const { key, cert, cleanup } = selfSigned("example.test", ["example.test"]);
    const port = await serve(key, cert);

    const waited = await awaitCertificates({
      host: "127.0.0.1",
      port,
      domain: "example.test",
      ...fast,
    });

    expect(waited.ready).toBe(false);
    expect(waited.missing).toEqual(["*.example.test"]);
    cleanup();
  });

  it("does not accept Caddy's own placeholder as an answer", async () => {
    // Caddy answers TLS from the moment it starts, with a certificate from its
    // internal CA. A handshake succeeding is therefore not the signal — this
    // is the state being waited out, not the end of the wait.
    const { key, cert, cleanup } = selfSigned("Caddy Local Authority - ECC Intermediate", [
      "example.test",
      "*.example.test",
    ]);
    const port = await serve(key, cert);

    const waited = await awaitCertificates({
      host: "127.0.0.1",
      port,
      domain: "example.test",
      ...fast,
    });

    expect(waited.ready).toBe(false);
    expect(waited.missing).toEqual(["example.test", "*.example.test"]);
    cleanup();
  });

  it("treats nothing listening as not ready, rather than as an error", async () => {
    // Caddy still starting, or the port not published yet. Neither is a reason
    // to stop, and neither may throw.
    const waited = await awaitCertificates({
      host: "127.0.0.1",
      port: 1,
      domain: "example.test",
      ...fast,
    });

    expect(waited.ready).toBe(false);
  });

  it("does not accept a wildcard as cover for a deeper name", async () => {
    // `*.example.test` covers `a.example.test` and not `a.b.example.test`. The
    // probe label is one deep, so this is only ever a correctness check on the
    // matcher — but getting it backwards would report ready too early.
    const { key, cert, cleanup } = selfSigned("example.test", ["*.example.test"]);
    const port = await serve(key, cert);

    const waited = await awaitCertificates({
      host: "127.0.0.1",
      port,
      domain: "example.test",
      ...fast,
    });

    // The wildcard probe passes; the bare name does not, because a wildcard
    // never covers it. This is why two certificates exist at all.
    expect(waited.missing).toEqual(["example.test"]);
    cleanup();
  });
});

describe("when there is nothing to wait for", () => {
  const domain = (over: Partial<Extract<Reach, { kind: "domain" }>> = {}): Reach => ({
    kind: "domain",
    domain: "example.test",
    dnsProvider: "cloudflare",
    dnsToken: "t",
    address: "100.64.0.1",
    ...over,
  });

  it("waits for a domain that obtains its own certificate", () => {
    expect(willObtainCertificate(domain())).toBe(true);
  });

  it("does not wait on loopback, where no Caddy exists", () => {
    expect(willObtainCertificate({ kind: "local" })).toBe(false);
  });

  it("does not wait for a certificate the operator supplies", () => {
    // Caddy loads those files at start-up. Nothing is being obtained, so
    // waiting would be eight minutes of watching a file not change.
    expect(willObtainCertificate(domain({ dnsProvider: "none" }))).toBe(false);
  });

  it("does not wait on a provider whose block is written empty", () => {
    // route53 and friends take several values, so their Caddyfile block is
    // left for the operator to fill in and no certificate can be issued until
    // they do. `install` says so — and must not then wait for it anyway.
    expect(willObtainCertificate(domain({ dnsProvider: "route53" }))).toBe(false);
  });
});

describe("the spinner line", () => {
  /**
   * One line, always.
   *
   * This was a small table of the two certificates, and clack's spinner cannot
   * repaint one: it redraws by moving the cursor up a fixed number of lines, so
   * anything taller scrolls instead of updating and the terminal fills with
   * copies of itself. Every second, for as long as the wait lasts.
   */
  it("never contains a newline", () => {
    for (const elapsed of [0, 30_000, 95_000, 400_000]) {
      const line = progress(["example.test", "*.example.test"], elapsed);

      expect(line).not.toContain("\n");
    }
  });

  it("names what is still outstanding", () => {
    expect(progress(["*.example.test"], 1000)).toContain("*.example.test");
    expect(progress(["*.example.test"], 1000)).not.toContain(" example.test,");
  });

  it("explains itself only once the wait is long enough to need it", () => {
    // A sentence about DNS providers on a twelve-second Cloudflare install is
    // noise; on a three-minute GoDaddy one it is the whole answer.
    expect(progress(["example.test"], 10_000)).not.toContain("retry");
    expect(progress(["example.test"], 120_000)).toContain("retry");
  });

  it("reads as minutes once it is minutes", () => {
    expect(progress(["example.test"], 30_000)).toContain("(30s)");
    expect(progress(["example.test"], 125_000)).toContain("(2m5s)");
  });
});
