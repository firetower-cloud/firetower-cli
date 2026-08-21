import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { COMPOSE_FILE } from "./docker.js";
import * as env from "./env.js";
import * as services from "./services.js";

/**
 * A deployment on disk, read rather than assumed.
 *
 * Every command that touches one goes through here, so that the service names,
 * the database identity and the variables Compose requires all come from the
 * compose file this deployment actually has — not from what the compose file
 * looked like when this CLI was published.
 */

export interface Deployment {
  dir: string;
  compose: string;
  env: env.Env;
  services: services.Services;
  database: services.DatabaseIdentity;
}

export async function open(dir: string): Promise<Deployment> {
  const compose = await readFile(join(dir, COMPOSE_FILE), "utf8");
  const values = (await env.read(join(dir, ".env"))) ?? {};
  const resolved = services.resolve(compose);

  return {
    dir,
    compose,
    env: values,
    services: resolved,
    database: services.databaseIdentity(compose, resolved, values),
  };
}

/**
 * Which of the variables Compose insists on are missing.
 *
 * Checked before `up`, because Compose's own error names a variable the
 * operator has never heard of and says nothing about why it is suddenly
 * required.
 */
export function missingVariables(compose: string, values: env.Env): string[] {
  return services
    .requiredVariables(compose)
    .filter((name) => {
      const held = values[name];
      return held === undefined || held === "";
    });
}
