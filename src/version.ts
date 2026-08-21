import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** This CLI's own version, read from the package it was installed as. */
export async function cliVersion(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const text = await readFile(join(here, "..", "package.json"), "utf8");
  return (JSON.parse(text) as { version: string }).version;
}

/**
 * The version inside a release tag.
 *
 * release-please tags this project's releases `firetower-v0.4.0` — the package
 * name, then the version — so stripping a leading `v` is not enough. Pull out
 * the semver and ignore whatever is in front of it.
 */
export function versionFromTag(tag: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(tag)?.[1] ?? null;
}

/**
 * Compare two versions the way a human reads them, so `0.10.0` is newer than
 * `0.9.0`. Returns a negative number when `a` is older.
 *
 * Anything unparseable sorts as equal: a worker reporting something we do not
 * understand is a reason to say nothing, not to claim it is behind.
 */
export function compare(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .replace(/^v/, "")
      .split(/[.-]/)
      .map((n) => Number.parseInt(n, 10));

  const left = parts(a);
  const right = parts(b);

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (Number.isNaN(l) || Number.isNaN(r)) return 0;
    if (l !== r) return l - r;
  }

  return 0;
}
