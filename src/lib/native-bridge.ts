import { Capacitor, registerPlugin } from "@capacitor/core";
import { Network } from "@capacitor/network";
import { z } from "zod";
import type { NativeVault } from "./local-connection";

// QR payload printed by the Vault console (`pair EMAIL PHONE`).
export const vaultQrSchema = z.object({ version: z.literal(1), address: z.string(), fingerprint: z.string(), code: z.string().regex(/^\d{6}$/) });

export const discoveredSchema = z.object({ name: z.string().optional(), address: z.string(), fingerprint: z.string().regex(/^[a-fA-F0-9:]{64,95}$/) });

type Plugin = {
  wifi(): Promise<{ wifi: boolean; name?: string }>;
  discover(): Promise<{ vaults: unknown[] }>;
  begin(i: { email: string; code: string; address: string; fingerprint: string }): Promise<unknown>;
  confirm(i: { requestId: string }): Promise<unknown>;
  catalog(): Promise<unknown>;
  pick(i: { kind: "Full" | "Custom" }): Promise<unknown>;
  startBackup(i: { name: string; kind: "Full" | "Custom"; paths: string[] }): Promise<unknown>;
  transferStatus(i: { transferId: string }): Promise<unknown>;
  disconnect(): Promise<void>;
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
      return vaults.flatMap((v) => { const r = discoveredSchema.safeParse(v); return r.success ? [r.data] : []; });
    },
    async scanQR() {
      const { BarcodeScanner, BarcodeFormat } = await import("@capacitor-mlkit/barcode-scanning");
      const { camera } = await BarcodeScanner.requestPermissions();
      if (camera !== "granted" && camera !== "limited") throw new Error("Camera access was declined. Enter the code instead.");
      const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
      const raw = barcodes[0]?.rawValue;
      if (!raw) throw new Error("No QR code was read. Enter the code instead.");
      let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new Error("That QR code is not from your HomeSafe Vault."); }
      const qr = vaultQrSchema.safeParse(parsed);
      if (!qr.success) throw new Error("That QR code is not from your HomeSafe Vault.");
      return qr.data;
    },
    begin: (i) => vault.begin(i),
    confirm: (requestId) => vault.confirm({ requestId }),
    catalog: () => vault.catalog(),
    pick: (i) => vault.pick(i),
    startBackup: (i) => vault.startBackup(i),
    transferStatus: (transferId) => vault.transferStatus({ transferId }),
    disconnect: () => vault.disconnect(),
  };
  window.HomeSafeNative = bridge;
}
