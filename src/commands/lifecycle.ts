import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as prompts from "@clack/prompts";
import * as docker from "../docker.js";
import { requireDeployment } from "./shared.js";
import { ui } from "../ui.js";

export interface DirOptions {
  dir?: string;
}

export async function logs(options: DirOptions & { follow?: boolean; service?: string }) {
  const dir = await requireDeployment(options.dir);
  const args = ["logs", ...(options.follow ? ["-f"] : ["--tail", "200"])];
  if (options.service) args.push(options.service);

  await docker.compose({ dir, stream: true }, ...args);
}

export async function start(options: DirOptions): Promise<void> {
  const dir = await requireDeployment(options.dir);
  ui.title("Firetower");

  await docker.composeOrThrow({ dir }, "up", "-d");
  await docker.waitForHealthy({ dir }, "firetower");

  ui.ok("running");
  ui.blank();
}

export async function stop(options: DirOptions): Promise<void> {
  const dir = await requireDeployment(options.dir);
  ui.title("Firetower");

  // `stop`, never `down`: down removes the containers, and somebody who typed
  // stop did not ask for that.
  await docker.composeOrThrow({ dir }, "stop");

  ui.ok("stopped");
  ui.dim("volumes are untouched — `firetower start` brings it back");
  ui.blank();
}

export async function restart(options: DirOptions): Promise<void> {
  const dir = await requireDeployment(options.dir);
  ui.title("Firetower");

  await docker.composeOrThrow({ dir }, "restart");
  await docker.waitForHealthy({ dir }, "firetower");

  ui.ok("running");
  ui.blank();
}

export async function backup(options: DirOptions & { out?: string }): Promise<void> {
  const dir = await requireDeployment(options.dir);
  const directory = options.out ?? join(dir, "backups");

  ui.title("Firetower");
  await mkdir(directory, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const result = await docker.compose(
    { dir },
    "exec", "-T", "postgres", "pg_dump", "-U", "firetower", "firetower",
  );

  if (result.exitCode !== 0) {
    ui.fail("pg_dump failed", `${result.stderr ?? ""}`.trim());
    process.exit(1);
  }

  const dump = join(directory, `${stamp}.sql`);
  await writeFile(dump, String(result.stdout));
  ui.ok(dump);

  // Both, always. Every credential in the dump is sealed with the root key, so
  // a backup without it restores a database that opens nothing.
  const env = await readFile(join(dir, ".env"), "utf8");
  const key = /^FIRETOWER_ROOT_KEY=(.*)$/m.exec(env)?.[1];

  if (key) {
    const keyPath = join(directory, `${stamp}.root-key.txt`);
    await writeFile(keyPath, `${key}\n`, { mode: 0o600 });
    ui.ok(keyPath);
    ui.blank();
    ui.dim("keep these two apart from each other, and both away from the machine");
  } else {
    ui.warn("no root key in .env — it lives on the volume", "back up the volume as well");
  }

  ui.blank();
}

export async function uninstall(options: DirOptions & { yes?: boolean }): Promise<void> {
  const dir = await requireDeployment(options.dir);
  ui.title("Firetower");

  ui.warn(`this removes the containers in ${dir}`);
  ui.blank();

  if (!options.yes) {
    const sure = await prompts.confirm({ message: "Stop and remove them?", initialValue: false });
    if (prompts.isCancel(sure) || !sure) process.exit(1);
  }

  await docker.composeOrThrow({ dir }, "down");
  ui.ok("containers removed");

  // Asked separately, and never bundled into the answer above. The volumes are
  // the database, the root key and every repository mirror — the only part of
  // this that cannot be put back.
  if (!options.yes) {
    ui.blank();
    ui.notice([
      "The volumes are still here: the database, the root key, and",
      "every repository mirror. Removing them cannot be undone, and",
      "`firetower install` in this directory would come back to a",
      "working deployment while they exist.",
    ]);

    const volumes = await prompts.confirm({
      message: "Delete the volumes too?",
      initialValue: false,
    });
    if (prompts.isCancel(volumes)) process.exit(1);

    if (volumes) {
      await docker.composeOrThrow({ dir }, "down", "-v");
      ui.ok("volumes removed");
    } else {
      ui.dim("volumes kept");
    }
  }

  ui.blank();
}
