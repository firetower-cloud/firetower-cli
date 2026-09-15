import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { networkInterfaces } from "node:os";
import { askReach } from "../src/shape.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  networkInterfaces: vi.fn(),
}));

const mocked = vi.mocked(networkInterfaces);

const addr = (address: string) =>
  ({ address, internal: false, family: "IPv4", netmask: "", mac: "", cidr: null }) as never;

/**
 * Choosing the bind address with no operator to ask.
 *
 * The failure this guards is quiet and late: a cloud VM with no tailnet has
 * exactly one address, the provider's private one. Taking it because it is the
 * only candidate produces an install that finishes, obtains a real certificate,
 * and answers nobody — and the first sign of it is a browser that hangs, days
 * later.
 */
describe("the bind address, unattended", () => {
  const flags = { domain: "ft.example.com", dnsProvider: "godaddy", dnsToken: "t" };

  beforeEach(() => mocked.mockReset());
  afterEach(() => vi.restoreAllMocks());

  const exits = () => vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("stopped");
  }) as never);

  it("takes a lone tailnet address, which is the case with nothing to decide", async () => {
    mocked.mockReturnValue({
      ens4: [addr("10.212.0.3")],
      tailscale0: [addr("100.69.206.104")],
    });

    await expect(askReach(flags)).resolves.toMatchObject({ address: "100.69.206.104" });
  });

  it("refuses to guess when nothing looks like a mesh", async () => {
    // The exact shape of a GCP VM without Tailscale: one address, and no way
    // from here to tell "the office can reach this" from "nobody can".
    mocked.mockReturnValue({ ens4: [addr("10.212.0.3")] });
    const exit = exits();

    await expect(askReach(flags)).rejects.toThrow("stopped");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("takes the operator's word for it when they name one", async () => {
    mocked.mockReturnValue({ ens4: [addr("10.212.0.3")] });

    await expect(askReach({ ...flags, httpsBind: "10.212.0.3" })).resolves.toMatchObject({
      address: "10.212.0.3",
    });
  });

  it("refuses to choose between two mesh addresses", async () => {
    mocked.mockReturnValue({
      tailscale0: [addr("100.69.206.104")],
      wg0: [addr("10.8.0.4")],
    });
    const exit = exits();

    await expect(askReach(flags)).rejects.toThrow("stopped");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("refuses a machine with nothing but loopback", async () => {
    mocked.mockReturnValue({});
    const exit = exits();

    await expect(askReach(flags)).rejects.toThrow("stopped");
    expect(exit).toHaveBeenCalledWith(1);
  });
});

/**
 * `--advertise`, which exists for the machine that cannot bind the address it
 * is reached at.
 *
 * Unattended is the only place this can be got wrong quietly: interactively
 * the CLI prints what it is about to bind and asks. Here there is nobody to
 * read it, so the rule is that an address is never guessed — it is named, or
 * the command stops.
 */
describe("the advertised address, unattended", () => {
  const flags = { domain: "ft.example.com", dnsProvider: "godaddy", dnsToken: "t" };

  beforeEach(() => mocked.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("keeps the two apart when both are named", async () => {
    // The GCP shape: the only address the guest has is internal, and the one
    // in DNS lives on Google's router.
    mocked.mockReturnValue({ ens4: [addr("10.128.0.2")] });

    await expect(
      askReach({ ...flags, httpsBind: "0.0.0.0", advertise: "34.79.12.180" }),
    ).resolves.toMatchObject({ address: "34.79.12.180", bind: "0.0.0.0" });
  });

  it("binds everything when only the advertised address is named", async () => {
    // Answerable precisely because the address was named deliberately. Reading
    // the bind off the interfaces instead would pick the internal address on
    // the exact machines this flag exists for.
    mocked.mockReturnValue({ ens4: [addr("10.128.0.2")] });

    await expect(askReach({ ...flags, advertise: "34.79.12.180" })).resolves.toMatchObject({
      address: "34.79.12.180",
      bind: "0.0.0.0",
    });
  });

  it("uses the bind for both when only it is named", async () => {
    mocked.mockReturnValue({ ens4: [addr("10.0.0.5")] });

    await expect(askReach({ ...flags, httpsBind: "10.0.0.5" })).resolves.toMatchObject({
      address: "10.0.0.5",
      bind: "10.0.0.5",
    });
  });

  it("takes a lone tailnet address for both", async () => {
    mocked.mockReturnValue({ tailscale0: [addr("100.69.206.104")] });

    await expect(askReach(flags)).resolves.toMatchObject({
      address: "100.69.206.104",
      bind: "100.69.206.104",
    });
  });
});
