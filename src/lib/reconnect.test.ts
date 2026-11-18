import { describe, expect, it, vi } from "vitest";
import { withReconnect, type NativeVault } from "./local-connection";
import vectors from "../../protocol/test-vectors.json";

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
    for (const v of vectors.vectors) expect(JSON.stringify(Object.fromEntries(Object.entries(v.input).sort(([a], [b]) => a.localeCompare(b))))).toBe(v.canonical);
  });
});
