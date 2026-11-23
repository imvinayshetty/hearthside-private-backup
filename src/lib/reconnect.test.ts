import { describe, expect, it, vi } from "vitest";
import { withReconnect, type NativeVault } from "./local-connection";
import vectors from "../../protocol/test-vectors.json";

/** The Vault sorts keys by Unicode code point; JS's default string order is UTF-16, which differs for emoji keys. */
const codePointCompare = (a: string, b: string): number => {
  const x = Array.from(a, (c) => c.codePointAt(0) as number), y = Array.from(b, (c) => c.codePointAt(0) as number);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return x.length - y.length;
};

const pin = "ab".repeat(32);
function bridge(found: { address: string; fingerprint: string }[]) {
  return { savedVault: vi.fn(async () => ({ address: "https://192.168.1.5:7443", fingerprint: pin })), discover: vi.fn(async () => found.map(f => ({ name: "Vault", ...f }))), relocate: vi.fn(async () => {}) } as unknown as NativeVault & { relocate: ReturnType<typeof vi.fn> };
}
const unreachable = Object.assign(new Error("Lost contact"), { code: "unreachable" });

describe("reconnect after IP change", () => {
  it("updates the address when the same fingerprint is found elsewhere", async () => {
    const b = bridge([{ address: "https://192.168.1.9:7443", fingerprint: pin }]);
    const run = vi.fn().mockRejectedValueOnce(unreachable).mockResolvedValueOnce("ok");
    await expect(withReconnect(b, run)).resolves.toBe("ok");
    expect(b.relocate).toHaveBeenCalledWith({ address: "https://192.168.1.9:7443", fingerprint: pin });
  });
  it("never accepts a different fingerprint", async () => {
    const b = bridge([{ address: "https://192.168.1.9:7443", fingerprint: "cd".repeat(32) }]);
    await expect(withReconnect(b, vi.fn().mockRejectedValue(unreachable))).rejects.toBe(unreachable);
    expect(b.relocate).not.toHaveBeenCalled();
  });
});

describe("signing test vectors", () => {
  it("canonical strings match sorted-key JSON", () => {
    for (const v of vectors.vectors) expect(JSON.stringify(Object.fromEntries(Object.entries(v.input).sort(([a], [b]) => codePointCompare(a, b))))).toBe(v.canonical);
  });
});
