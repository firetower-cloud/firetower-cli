import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { networkInterfaces } from "node:os";
import { candidateAddresses } from "../src/checks/machine.js";
import { isIpv4 } from "../src/shape.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  networkInterfaces: vi.fn(),
}));

const mocked = vi.mocked(networkInterfaces);

/** One address, with only the fields this code reads. */
const addr = (address: string, internal = false) =>
  ({ address, internal, family: "IPv4", netmask: "", mac: "", cidr: null }) as never;

/**
 * Which of a machine's addresses a domain can point at.
 *
 * The case that motivated all of this: a cloud VM with a tailnet has two
 * private addresses, and the first one `networkInterfaces()` hands back is the
 * provider's, which no laptop outside that VPC can route to. The old code took
 * that first entry and printed it as the answer.
 */
describe("candidateAddresses", () => {
  beforeEach(() => mocked.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("puts a tailnet address ahead of the VPC address beside it", () => {
    mocked.mockReturnValue({
      eth0: [addr("10.212.0.3")],
      tailscale0: [addr("100.69.206.104")],
    });

    const found = candidateAddresses();

    expect(found[0]).toMatchObject({ address: "100.69.206.104", kind: "mesh" });
    expect(found[1]).toMatchObject({ address: "10.212.0.3", kind: "private" });
  });

  it("recognises a tailnet by its range, not only by the interface name", () => {
    // macOS calls it `utun3`, which is what every other tunnel is called too.
    // 100.64.0.0/10 is the stronger signal.
    mocked.mockReturnValue({ utun3: [addr("100.71.4.9")] });

    expect(candidateAddresses()[0]).toMatchObject({ kind: "mesh" });
  });

  it("leaves out Docker's bridges", () => {
    // Node marks only loopback as `internal`, so these arrive looking exactly
    // like a NIC — and this deployment creates several of them. Offering
    // 172.17.0.1 as the address to point a domain at offers an address that is
    // unreachable from everywhere, including from the container answering on it.
    mocked.mockReturnValue({
      docker0: [addr("172.17.0.1")],
      "br-8f2a91c0": [addr("172.18.0.1")],
      eth0: [addr("192.168.1.50")],
    });

    expect(candidateAddresses().map((c) => c.address)).toEqual(["192.168.1.50"]);
  });

  it("leaves out loopback and link-local", () => {
    mocked.mockReturnValue({
      lo: [addr("127.0.0.1", true)],
      eth0: [addr("169.254.7.2"), addr("192.168.1.50")],
    });

    expect(candidateAddresses().map((c) => c.address)).toEqual(["192.168.1.50"]);
  });

  it("calls a routable address public, and sorts it last", () => {
    mocked.mockReturnValue({
      eth0: [addr("203.0.113.9")],
      wg0: [addr("10.8.0.4")],
    });

    const found = candidateAddresses();

    expect(found[0]).toMatchObject({ address: "10.8.0.4", kind: "mesh" });
    expect(found.at(-1)).toMatchObject({ address: "203.0.113.9", kind: "public" });
  });

  it("has nothing to offer a machine with only loopback", () => {
    mocked.mockReturnValue({ lo: [addr("127.0.0.1", true)] });

    expect(candidateAddresses()).toEqual([]);
  });

  it("keeps IPv6 out of a list that becomes A records", () => {
    mocked.mockReturnValue({ eth0: [addr("fe80::1"), addr("192.168.1.50")] });

    expect(candidateAddresses().map((c) => c.address)).toEqual(["192.168.1.50"]);
  });
});

/**
 * What the advanced prompt accepts.
 *
 * Syntax only, and that is the whole policy. Classifying the answer cannot be
 * made correct — on a Google Cloud VM `10.128.0.2` is an RFC1918 address the
 * entire internet reaches — so the only thing worth catching here is a value
 * that could never be an A record at all.
 */
describe("isIpv4", () => {
  it("takes four octets", () => {
    for (const value of ["34.79.12.180", "10.0.0.5", "0.0.0.0", "255.255.255.255", "127.0.0.1"]) {
      expect(isIpv4(value)).toBe(true);
    }
  });

  it("takes one with spaces around it, which is what a paste looks like", () => {
    expect(isIpv4("  100.69.206.104 ")).toBe(true);
  });

  it("refuses a domain name, which is the mistake worth catching", () => {
    // Typed into the address prompt it would become an A record pointing at
    // nothing, and the failure would arrive as a browser that hangs.
    expect(isIpv4("firetower.example.com")).toBe(false);
  });

  it("refuses what is not an address", () => {
    for (const value of ["", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.-1", "::1", "1.2.3.x"]) {
      expect(isIpv4(value)).toBe(false);
    }
  });

  it("does not judge what kind of address it is", () => {
    // Loopback included. `firetower install` says it assumes you know what you
    // are doing, and this is where that promise is kept.
    expect(isIpv4("127.0.0.1")).toBe(true);
  });
});
