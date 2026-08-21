/**
 * One check engine, two entry points.
 *
 * `install` runs the subset that has to be true before anything is written;
 * `doctor` runs everything, including the questions that only make sense once
 * a deployment exists. They share this file so that a remedy is written once
 * and cannot drift between the command that prevents a problem and the command
 * that diagnoses it.
 */

export type Status = "ok" | "warn" | "fail";

export interface Result {
  name: string;
  status: Status;
  /** What was found. Shown beside the name. */
  detail?: string;
  /** What to do about it. Only worth setting when the status is not ok. */
  remedy?: string;
}

export interface Check {
  name: string;
  /** Run before an install, to stop it starting. */
  preflight: boolean;
  /** Run against an existing deployment. */
  deployment: boolean;
  run: (context: Context) => Promise<Result>;
}

export interface Context {
  /** The deployment directory, when there is one. */
  dir: string | null;
  /** The domain being installed, when `install` is asking. */
  domain?: string | null;
}

export function ok(name: string, detail?: string): Result {
  return { name, status: "ok", detail };
}

export function warn(name: string, detail: string, remedy?: string): Result {
  return { name, status: "warn", detail, remedy };
}

export function fail(name: string, detail: string, remedy?: string): Result {
  return { name, status: "fail", detail, remedy };
}

export async function runChecks(checks: Check[], context: Context): Promise<Result[]> {
  const results: Result[] = [];

  // In order, not in parallel: the output is meant to be read as it appears,
  // and a machine with no daemon should say so before it says anything about
  // ports.
  for (const check of checks) {
    try {
      results.push(await check.run(context));
    } catch (error) {
      results.push(fail(check.name, (error as Error).message));
    }
  }

  return results;
}

export const worst = (results: Result[]): Status =>
  results.some((r) => r.status === "fail")
    ? "fail"
    : results.some((r) => r.status === "warn")
      ? "warn"
      : "ok";
