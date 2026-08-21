import { findDeployment } from "../config.js";
import { ui } from "../ui.js";

/**
 * Every command except `install` needs a deployment, and the failure when
 * there isn't one is the same sentence each time.
 */
export async function requireDeployment(explicit?: string): Promise<string> {
  const dir = await findDeployment(explicit);
  if (dir) return dir;

  ui.blank();
  ui.fail(
    explicit ? `no Firetower deployment in ${explicit}` : "no Firetower deployment found",
    "run `firetower install`, or point at one with --dir",
  );
  ui.blank();
  process.exit(1);
}
