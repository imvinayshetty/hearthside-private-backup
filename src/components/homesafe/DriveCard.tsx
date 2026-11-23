import { useEffect, useState } from "react";
import { HardDrive } from "lucide-react";
import { nativeVault, statusSchema, type DriveStatus } from "@/lib/local-connection";

const gb = (n: number) => (n >= 1e12 ? `${(n / 1e12).toFixed(2)} TB` : `${(n / 1e9).toFixed(1)} GB`);

/** Reads the drive of a discovered Vault (pass its address and fingerprint) or of the paired Vault (pass nothing). Null when it cannot be read. */
export function useDriveStatus(target?: { address: string; fingerprint: string } | null, refreshKey = 0): DriveStatus | null {
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const address = target?.address, fingerprint = target?.fingerprint;
  useEffect(() => {
    let live = true; setStatus(null);
    void (async () => {
      try { const bridge = nativeVault(); const r = statusSchema.safeParse(await bridge.vaultStatus(address && fingerprint ? { address, fingerprint } : undefined)); if (live && r.success) setStatus(r.data); }
      catch { /* An older Vault or app cannot report its drive; the card stays hidden. */ }
    })();
    return () => { live = false; };
  }, [address, fingerprint, refreshKey]);
  return status;
}

export function DriveCard({ status }: { status: DriveStatus | null }) {
  if (!status) return null;
  const used = status.totalBytes && status.freeBytes !== undefined ? Math.min(100, Math.round(((status.totalBytes - status.freeBytes) / status.totalBytes) * 100)) : null;
  return <section aria-label="Connected drive" className="mt-6 rounded-xl border border-ink/10 p-4">
    <p className="flex items-center gap-2 text-sm font-medium"><HardDrive size={18} className={status.connected ? "text-sagedeep" : "text-warn"} />{status.connected ? `Connected drive · ${status.driveName}` : `Drive not connected · ${status.driveName}`}</p>
    {status.connected && status.totalBytes !== undefined && status.freeBytes !== undefined && <>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-ink/10"><div className="h-full bg-sage" style={{ width: `${used ?? 0}%` }} /></div>
      <p className="mt-2 text-xs text-slate">{gb(status.freeBytes)} free of {gb(status.totalBytes)}</p>
    </>}
    {!status.connected && <p className="mt-2 text-xs text-warn">Plug the backup drive into the computer running the Vault.</p>}
  </section>;
}
