import { describe, expect, it } from "vitest";
import { backupPath, pairingCode, requireNewPhoneName, vaultEmail } from "./backup-rules";

describe("approved pairing rules", () => {
  it("builds profile / phone / backup path", () => {
    expect(backupPath("Vinay", "Blue Pixel", "Full_Bckup_151126")).toBe("HomeSafeBckup/Vinay/Blue Pixel/Full_Bckup_151126");
  });
  it("rejects unsafe phone segment", () => { expect(() => backupPath("Vinay", "a/b", "Full_Bckup_151126")).toThrow(); });
  it("rejects duplicate phone names in a profile", () => {
    expect(() => requireNewPhoneName("blue pixel", ["Blue Pixel"])).toThrow(/already used/);
    expect(requireNewPhoneName("Kitchen iPad", ["Blue Pixel"])).toBe("Kitchen iPad");
  });
  it("accepts only six-digit codes", () => {
    expect(pairingCode("123 456")).toBe("123456");
    expect(() => pairingCode("12345")).toThrow();
  });
  it("normalizes email", () => {
    expect(vaultEmail(" A@B.co ")).toBe("a@b.co");
    expect(() => vaultEmail("nope")).toThrow();
  });
});
