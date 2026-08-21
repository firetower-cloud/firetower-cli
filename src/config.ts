import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { access } from "node:fs/promises";
import { COMPOSE_FILE } from "./docker.js";

/**
 * Where this machine's deployment is, remembered so that every command after
 * `install` needs no arguments.
 *
 * A pointer and nothing else. Everything that matters lives in the deployment
 * directory, so losing this file costs one `--dir`.
 */

export interface Config {
  dir?: string;
}

function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "firetower", "cli.json");
}

export async function readConfig(): Promise<Config> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as Config;
  } catch {
    return {};
  }
}

export async function rememberDir(dir: string): Promise<void> {
  const path = configPath();
  await mkdir(join(path, ".."), { recursive: true });

  const config = await readConfig();
  await writeFile(path, `${JSON.stringify({ ...config, dir }, null, 2)}\n`);
}

async function isDeployment(dir: string): Promise<boolean> {
  try {
    await access(join(dir, COMPOSE_FILE));
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the deployment: what was asked for, what we remembered, then the places
 * an install would have put it.
 *
 * The search exists so that a deployment made by following the README — rather
 * than by this CLI — is still found, since there is no reason to treat it as a
 * different kind of thing.
 */
export async function findDeployment(explicit?: string): Promise<string | null> {
  if (explicit) return (await isDeployment(explicit)) ? explicit : null;

  const remembered = (await readConfig()).dir;
  if (remembered && (await isDeployment(remembered))) return remembered;

  for (const candidate of [
    process.cwd(),
    "/opt/firetower",
    join(homedir(), "firetower"),
  ]) {
    if (await isDeployment(candidate)) return candidate;
  }

  return null;
}

/** Where a fresh install should go, given who is running it. */
export function defaultInstallDir(): string {
  return process.getuid?.() === 0 ? "/opt/firetower" : join(homedir(), "firetower");
}
