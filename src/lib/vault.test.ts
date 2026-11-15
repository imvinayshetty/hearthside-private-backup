import { describe, it, expect } from "vitest";
import { selectedGb, fitsOnDrive, vaultCode, etaText } from "./vault";

describe("backup selection", () => {
  it("all three sources total 136.4 GB", () => {
    expect(selectedGb({ photos: true, contacts: true, documents: true })).toBe(136.4);
  });
  it("only documents is 23.9 GB", () => {
    expect(selectedGb({ photos: false, contacts: false, documents: true })).toBe(23.9);
  });
  it("nothing selected cannot start, over-capacity cannot start", () => {
    expect(fitsOnDrive(0)).toBe(false);
    expect(fitsOnDrive(3000, 2800)).toBe(false);
    expect(fitsOnDrive(136.4)).toBe(true);
  });
  it("vault code is 6 digits and stable within a 30s window", () => {
    expect(vaultCode(60000)).toMatch(/^\d{6}$/);
    expect(vaultCode(60000)).toBe(vaultCode(89999));
  });
  it("eta at 48 MB/s for 49.2 GB is about 18 mins", () => {
    expect(etaText(49.2, 48)).toBe("About 18 mins remaining");
  });
});
