import pc from "picocolors";

/**
 * Output.
 *
 * Two channels on purpose. Progress, prompts and errors go to stderr, so that
 * `--json` on stdout stays a clean pipe. A CLI whose progress spinner ends up
 * in somebody's jq is a CLI people stop scripting against.
 */

const out = (line = "") => process.stderr.write(`${line}\n`);

export const ui = {
  blank: () => out(),

  title(text: string) {
    out();
    out(`  ${pc.bold(text)}`);
    out();
  },

  step(text: string) {
    out(`  ${text}`);
  },

  /**
   * A check that passed, in two columns.
   *
   * `padEnd` alone is not enough: a label longer than the column — a path,
   * usually — would run straight into the value with no space at all.
   */
  ok(label: string, value?: string) {
    const padded = value ? `${label.padEnd(20)} ${pc.dim(value)}` : label;
    out(`  ${pc.green("✓")} ${padded}`);
  },

  warn(text: string, remedy?: string) {
    out(`  ${pc.yellow("!")} ${text}`);
    if (remedy) out(`    ${pc.dim(remedy)}`);
  },

  fail(text: string, remedy?: string) {
    out(`  ${pc.red("✗")} ${text}`);
    if (remedy) out(`    ${pc.dim(remedy)}`);
  },

  /** For the things that are worth stopping to read. */
  notice(lines: string[]) {
    const rule = pc.dim("─".repeat(62));
    out();
    out(`  ${rule}`);
    for (const line of lines) out(`  ${line}`);
    out(`  ${rule}`);
    out();
  },

  dim: (text: string) => out(`  ${pc.dim(text)}`),

  /** The only thing that goes to stdout: an answer somebody asked for. */
  json(value: unknown) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  },
};

export { pc };
