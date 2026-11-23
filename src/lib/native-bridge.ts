import { Capacitor, registerPlugin } from "@capacitor/core";
import { Network } from "@capacitor/network";
import { parsePairingUri, QR_ERROR, usableVaults } from "./vault-protocol";
import type { NativeVault } from "./local-connection";


type Plugin = {
  wifi(): Promise<{ wifi: boolean; name?: string }>;
  discover(): Promise<{ vaults: unknown[] }>;
  begin(i: { email: string; code: string; address: string; fingerprint: string }): Promise<unknown>;
  confirm(i: { requestId: string }): Promise<unknown>;
  catalog(): Promise<unknown>;
  pick(i: { kind: "Full" | "Custom" }): Promise<unknown>;
  startBackup(i: { name: string; kind: "Full" | "Custom"; paths: string[]; basedOn?: string }): Promise<unknown>;
  /** Android only for now: which of these items are new or changed since this phone's last Full backup. */
  compareWithLastFull(i: { paths: string[] }): Promise<unknown>;
  resolveProblems(i: { transferId: string; actions: { index: number; action: "retry" | "rename" | "skip"; name?: string }[] }): Promise<unknown>;
  cancelBackup(i: { transferId: string }): Promise<unknown>;
  /** The drive a Vault saves to. No argument: the paired Vault. Android only for now. */
  vaultStatus(i?: { address: string; fingerprint: string }): Promise<unknown>;
  transferStatus(i: { transferId: string }): Promise<unknown>;
  disconnect(): Promise<void>;
  savedVault(): Promise<{ address?: string; fingerprint?: string }>;
  relocate(i: { address: string; fingerprint: string }): Promise<void>;
  forget(): Promise<void>;
};

/** Installs window.HomeSafeNative only inside the installed Android/iPhone app. */
export function installNativeVault(): void {
  if (typeof window === "undefined" || window.HomeSafeNative || !Capacitor.isNativePlatform()) return;
  const vault = registerPlugin<Plugin>("HomeSafeVault");
  const bridge: NativeVault = {
    async network() {
      const s = await Network.getStatus();
      if (!s.connected || s.connectionType !== "wifi") return { wifi: false };
      try { const w = await vault.wifi(); return w.name ? { wifi: true, name: w.name } : { wifi: true }; } catch { return { wifi: true }; }
    },
    async discover() {
      const { vaults } = await vault.discover();
      return usableVaults(vaults);
    },
    async scanQR() {
      const { BarcodeScanner, BarcodeFormat } = await import("@capacitor-mlkit/barcode-scanning");
      const { camera } = await BarcodeScanner.requestPermissions();
      if (camera !== "granted" && camera !== "limited") throw new Error("Camera access was declined. Enter the code instead.");
      const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
      const raw = barcodes[0]?.rawValue;
      if (!raw) throw new Error(QR_ERROR);
      return parsePairingUri(raw);
    },
    begin: (i) => vault.begin(i),
    confirm: (requestId) => vault.confirm({ requestId }),
    catalog: () => vault.catalog(),
    pick: (i) => vault.pick(i),
    startBackup: (i) => vault.startBackup(i),
    compareWithLastFull: (i) => vault.compareWithLastFull(i),
    resolveProblems: (i) => vault.resolveProblems(i),
    cancelBackup: (i) => vault.cancelBackup(i),
    vaultStatus: (i) => vault.vaultStatus(i),
    transferStatus: (transferId) => vault.transferStatus({ transferId }),
    disconnect: () => vault.disconnect(),
    savedVault: () => vault.savedVault(),
    relocate: (i) => vault.relocate(i),
    forget: () => vault.forget(),
  };
  window.HomeSafeNative = bridge;
}
