import { describe, it, expect } from "vitest";
import { runArgs, saysDockerOff } from "../src/commands/worker/index.js";

/**
 * What a worker is created with.
 *
 * Asserted rather than described, because this list existed twice — here and
 * as `run_args` in ft-server — and only one copy was taught to run Docker.
 * `worker upgrade` went on recreating containers from the other one, so the
 * image was current, the arguments were not, and every session on an upgraded
 * worker got a daemon that exits on start-up with an iptables error.
 *
 * Nothing here can stop the two drifting again. What it can do is make the
 * drift a failing test in the repository that shipped it.
 */

const args = (docker: boolean) => runArgs("firetower-worker", docker);

describe("runArgs with Docker", () => {
  it("is privileged, which is the whole feature", () => {
    // Not `--cap-add`: the daemon needs CAP_NET_ADMIN for its bridge and
    // CAP_SYS_ADMIN to mount layers, and where AppArmor is enforcing its
    // docker-default profile denies `mount` whatever capabilities are added.
    expect(args(true)).toContain("--privileged");
  });

  it("gives the daemon its own volume for /var/lib/docker", () => {
    // Overlay-on-overlay is the classic nested-Docker failure and it reads as
    // a broken image rather than a bad mount.
    expect(args(true)).toContain("firetower-docker-firetower-worker:/var/lib/docker");
  });

  it("keys that volume to the worker, because two daemons cannot share one", () => {
    expect(runArgs("second", true)).toContain("firetower-docker-second:/var/lib/docker");
  });

  it("does not also say the daemon is off", () => {
    expect(args(true).join(" ")).not.toContain("FIRETOWER_WORKER_DOCKER");
  });
});

describe("runArgs without Docker", () => {
  it("still comes up", () => {
    const without = args(false);
    expect(without).toContain("--name");
    expect(without.slice(-2)).toEqual(["sleep", "infinity"]);
  });

  it("is not privileged", () => {
    expect(args(false)).not.toContain("--privileged");
  });

  it("says so, rather than leaving the entrypoint to find out", () => {
    // The entrypoint starts a daemon unless it is told not to. Without this it
    // would fail on a machine that was never meant to run one, and leave a
    // log that reads as a fault instead of a setting.
    expect(args(false)).toContain("FIRETOWER_WORKER_DOCKER=off");
  });

  it("has no image cache to keep", () => {
    expect(args(false).join(" ")).not.toContain("/var/lib/docker");
  });
});

describe("runArgs, either way", () => {
  it("reaps what the daemon leaves behind", () => {
    // `sleep infinity` reaps nothing, and containerd's shims reparent to pid 1
    // as they exit — a worker that stays up for weeks would fill with zombies.
    expect(args(true)).toContain("--init");
    expect(args(false)).toContain("--init");
  });

  it("keeps the worktrees on their named volume", () => {
    for (const set of [args(true), args(false)]) {
      expect(set).toContain("firetower:/var/lib/firetower");
    }
  });

  it("puts the image before the command, or docker reads the flags as its own", () => {
    for (const set of [args(true), args(false)]) {
      const image = set.findIndex((a) => a.startsWith("ghcr.io/"));
      expect(image).toBeGreaterThan(0);
      expect(set.slice(image + 1)).toEqual(["sleep", "infinity"]);
    }
  });
});

/**
 * What `upgrade` preserves, and what it must not.
 *
 * The trap this covers: asking "is it privileged?" would have been the obvious
 * question and the wrong one. Every worker built before Docker worked is
 * unprivileged, and so is every worker deliberately installed with
 * `--no-docker`. Preserving privilege would mean the upgrade that exists to
 * give the first group Docker gives it to nobody.
 */
describe("saysDockerOff", () => {
  const env = (...lines: string[]) => lines.join("\n") + "\n";

  it("is false for a worker that predates Docker, so upgrading gives it some", () => {
    // The case the whole change is for: no privilege, no variable, and an
    // upgrade that has to turn Docker on rather than preserve its absence.
    expect(saysDockerOff(env("PATH=/usr/bin", "HOME=/var/lib/firetower/home"))).toBe(false);
  });

  it("is true when somebody said no, so upgrading leaves it off", () => {
    expect(saysDockerOff(env("PATH=/usr/bin", "FIRETOWER_WORKER_DOCKER=off"))).toBe(true);
  });

  it("takes any other value as on, because a typo should not remove a feature", () => {
    expect(saysDockerOff(env("FIRETOWER_WORKER_DOCKER=false"))).toBe(false);
    expect(saysDockerOff(env("FIRETOWER_WORKER_DOCKER=0"))).toBe(false);
    expect(saysDockerOff(env("FIRETOWER_WORKER_DOCKER="))).toBe(false);
  });

  it("is not fooled by a variable that merely ends the same way", () => {
    expect(saysDockerOff(env("NOT_FIRETOWER_WORKER_DOCKER=off"))).toBe(false);
  });

  it("reads the value however it was typed, but the name exactly", () => {
    // The asymmetry the control plane reads it with: `Off` is off, and a
    // differently-cased name is a different variable nothing looks at.
    expect(saysDockerOff(env("FIRETOWER_WORKER_DOCKER=Off"))).toBe(true);
    expect(saysDockerOff(env("FIRETOWER_WORKER_DOCKER=OFF"))).toBe(true);
    expect(saysDockerOff(env("firetower_worker_docker=off"))).toBe(false);
  });

  it("reads an empty environment as on", () => {
    expect(saysDockerOff("")).toBe(false);
  });
});
