import { describe, it, expect, afterAll } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as env from "../src/env.js";

/**
 * The install path, against a real Docker daemon.
 *
 * This is the test that would have caught the mistake the whole of `env.ts`
 * exists to prevent: a second `install` in a directory that already has one
 * must not write a new root key over the old one. Everything sealed with the
 * first key would still be in the database, and unreadable, and nothing would
 * say so until the next clone.
 */

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
let dir: string;

afterAll(async () => {
  if (!dir) return;

  await execa("docker", ["compose", "-f", "firetower.yml", "down", "-v"], {
    cwd: dir,
    reject: false,
  });
  await rm(dir, { recursive: true, force: true });
});

describe("install", () => {
  it("brings up a working deployment and keeps its secrets on a re-run", async () => {
    dir = await mkdtemp(join(tmpdir(), "firetower-e2e-"));

    const first = await execa("node", [CLI, "--dir", dir, "--yes", "install"], {
      reject: false,
      stdio: "inherit",
    });
    expect(first.exitCode).toBe(0);

    const before = await env.read(join(dir, ".env"));
    expect(before?.FIRETOWER_ROOT_KEY).toBeTruthy();
    expect(env.looksLikeARootKey(before!.FIRETOWER_ROOT_KEY!)).toBe(true);

    // `.env` holds every secret this deployment has. Nobody else on the
    // machine gets to read it.
    const { stdout: mode } = await execa("stat", ["-c", "%a", join(dir, ".env")], {
      reject: false,
    });
    if (mode) expect(String(mode).trim()).toBe("600");

    const doctor = await execa("node", [CLI, "--dir", dir, "doctor"], { reject: false });
    expect(doctor.exitCode).toBe(0);

    // The whole point of this file.
    const second = await execa("node", [CLI, "--dir", dir, "--yes", "install"], {
      reject: false,
    });

    const after = await env.read(join(dir, ".env"));
    expect(after?.FIRETOWER_ROOT_KEY).toBe(before?.FIRETOWER_ROOT_KEY);
    expect(after?.POSTGRES_PASSWORD).toBe(before?.POSTGRES_PASSWORD);
    expect(second.exitCode).not.toBe(0); // it should refuse, not proceed

    // And the compose file it wrote is the one the release publishes.
    const compose = await readFile(join(dir, "firetower.yml"), "utf8");
    expect(compose).toContain("ghcr.io/firetower-cloud/firetower");
  });
});
