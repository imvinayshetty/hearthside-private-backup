import { describe, expect, it } from "vitest";
import { ROOT_FOLDER, dateCode, defaultBackupName, localVaultAddress, requireAvailableBackup, safeSegment, validateBackupName } from "./backup-rules";

const day = new Date(2026, 10, 15, 12);
describe("HomeSafe Vault compatibility", () => {
  it("uses HomeSafeBckup as root", () => expect(ROOT_FOLDER).toBe("HomeSafeBckup"));
  it("uses DDMMYY", () => expect(dateCode(new Date(2026, 0, 2))).toBe("020126"));
  it("names full backups", () => expect(defaultBackupName("Full", day)).toBe("Full_Bckup_151126"));
  it("names custom backups", () => expect(defaultBackupName("Custom", day)).toBe("Custom_Bckup_151126"));
  it("requires the dated prefix when renaming", () => {
    expect(validateBackupName("Custom_Bckup_151126_2", "Custom", day)).toBe("Custom_Bckup_151126_2");
    expect(() => validateBackupName("other", "Custom", day)).toThrow();
  });
  it("rejects unsafe profile names", () => { for (const name of ["../Vinay", "..", "CON", "a/b", "a."]) expect(() => safeSegment(name)).toThrow(); });
  it("requires a suffix for any same-date backup", () => {
    expect(() => requireAvailableBackup("Custom_Bckup_151126", "Custom", day, [{ name: "Full_Bckup_151126", date: "151126" }])).toThrow("unique suffix");
    expect(requireAvailableBackup("Custom_Bckup_151126_2", "Custom", day, [{ name: "Full_Bckup_151126", date: "151126" }])).toBe("Custom_Bckup_151126_2");
  });
  it("never overwrites case-insensitive names", () => expect(() => requireAvailableBackup("Full_Bckup_151126", "Full", day, [{ name: "full_bckup_151126", date: "151126" }])).toThrow("not be overwritten"));
  it("accepts private HTTPS addresses", () => {
    for (const host of ["192.168.1.108", "10.0.0.1", "172.16.0.1", "172.31.255.254"]) expect(localVaultAddress(`https://${host}:7443`)).toBe(`https://${host}:7443`);
  });
  it("blocks public destinations and insecure addresses", () => {
    for (const address of ["https://example.com", "https://8.8.8.8", "http://192.168.1.1", "https://172.32.0.1", "https://192.168.1.999", "https://user:pass@192.168.1.1", "https://192.168.1.1/api", "https://192.168.1.1?next=cloud"]) expect(() => localVaultAddress(address)).toThrow();
  });
});