import { describe, expect, it } from "vitest";
import { confirmDeadline, manifestPages, parsePairingUri, QR_ERROR, relocatedVault, secondsLeft, usableVaults, vaultProblem } from "./vault-protocol";

const fp = "ab".repeat(32);
const uri = (o: Record<string, string>) => "homesafe://pair?" + new URLSearchParams({ v: "1", host: "192.168.1.20", port: "7443", fp, code: "123456", email: "me@home.com", ...o });

describe("pairing QR v1", () => {
  it("accepts a valid homesafe://pair URI", () => {
    expect(parsePairingUri(uri({}))).toEqual({ address: "https://192.168.1.20:7443", fingerprint: fp, code: "123456", email: "me@home.com" });
  });
  it.each([["v", "2"], ["host", "8.8.8.8"], ["port", "0"], ["port", "65536"], ["fp", "abc"], ["code", "12345"], ["email", "nope"]])("rejects %s=%s", (k, v) => {
    expect(() => parsePairingUri(uri({ [k]: v }))).toThrow(QR_ERROR);
  });
  it("rejects the old JSON QR", () => {
    expect(() => parsePairingUri(JSON.stringify({ version: 1, address: "https://192.168.1.2:7443", fingerprint: fp, code: "123456" }))).toThrow(QR_ERROR);
  });
});

describe("discovery and reconnect", () => {
  it("ignores Vaults whose TXT v is not 1", () => {
    const found = usableVaults([{ v: "1", name: "Den", address: "https://192.168.1.5:7443", fingerprint: fp }, { v: "2", address: "https://192.168.1.6:7443", fingerprint: fp }, { address: "https://192.168.1.7:7443", fingerprint: fp }]);
    expect(found.map(v => v.address)).toEqual(["https://192.168.1.5:7443"]);
  });
  it("matches a moved Vault only by pinned fingerprint", () => {
    const found = usableVaults([{ v: "1", address: "https://192.168.1.9:7443", fingerprint: "cd".repeat(32) }]);
    expect(relocatedVault(found, fp)).toBeNull();
    expect(relocatedVault(usableVaults([{ v: "1", address: "https://192.168.1.9:7443", fingerprint: fp }]), fp)?.address).toBe("https://192.168.1.9:7443");
  });
});

describe("Vault error codes", () => {
  it("phone_revoked asks to re-pair", () => { expect(vaultProblem({ code: "phone_revoked" })).toMatchObject({ code: "phone_revoked", repair: true }); });
  it("rate_limited is not a re-pair", () => { expect(vaultProblem({ code: "rate_limited", message: "x" })).toMatchObject({ code: "rate_limited", repair: false }); });
});

describe("timing and paging", () => {
  it("caps confirmation at 30 seconds after begin", () => {
    expect(confirmDeadline(1000 + 120, 1000_000)).toBe(1030);
    expect(secondsLeft(1030, 1029_200)).toBe(1);
    expect(secondsLeft(1030, 1031_000)).toBe(0);
  });
  it("pages manifests only above 5,000 files", () => {
    expect(manifestPages(Array(5000).fill(0)).pages).toHaveLength(0);
    const p = manifestPages(Array(12001).fill(0));
    expect(p.inline).toHaveLength(0);
    expect(p.pages.map(x => [x.offset, x.files.length])).toEqual([[0, 5000], [5000, 5000], [10000, 2001]]);
  });
});
