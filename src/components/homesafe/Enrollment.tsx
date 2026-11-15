import { useEffect, useState } from "react";
import { HardDrive, Shield, Smartphone, AlertTriangle } from "lucide-react";
import { ROOT_FOLDER, defaultBackupName, localVaultAddress, safeSegment, validateBackupName, type BackupKind } from "@/lib/backup-rules";
import { Display, GhostButton, Pill, PrimaryButton } from "./ui";

export function Enrollment({ onDemo }: { onDemo: () => void }) {
  const [profile, setProfile] = useState("");
  const [address, setAddress] = useState("");
  const [kind, setKind] = useState<BackupKind>("Full");
  const [name, setName] = useState("");
  const [today, setToday] = useState<Date | null>(null);
  const [platform, setPlatform] = useState("Android");
  const [error, setError] = useState("");
  const [prepared, setPrepared] = useState(false);
  useEffect(() => { const date = new Date(); setToday(date); setName(defaultBackupName("Full", date)); }, []);
  const inputClass = "mt-2 min-h-12 w-full rounded-md border border-ink/15 bg-card px-3 text-ink outline-none focus:border-sage";
  function prepare() {
    setError(""); setPrepared(false);
    try {
      const cleanProfile = safeSegment(profile);
      const cleanAddress = localVaultAddress(address);
      const date = new Date();
      if (!today || defaultBackupName(kind, today) !== defaultBackupName(kind, date)) {
        setToday(date); setName(defaultBackupName(kind, date)); throw new Error("The date changed. Review the new backup name and try again.");
      }
      const cleanName = validateBackupName(name, kind, date);
      setProfile(cleanProfile); setAddress(cleanAddress); setName(cleanName); setPrepared(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Check your setup details."); }
  }
  return (
    <div className="min-h-screen bg-ground text-ink">
      <header className="border-b border-ink/10 px-5 py-4"><div className="mx-auto flex max-w-4xl items-center gap-2 font-semibold"><Shield size={20} className="text-sagedeep" />HomeSafe <span className="ml-auto text-sm font-normal text-slate">Phone & tablet</span></div></header>
      <main className="mx-auto max-w-4xl px-5 py-8 md:py-12">
        <Pill><Smartphone size={15} />Not enrolled</Pill>
        <Display className="mt-5">Connect to HomeSafe Vault</Display>
        <div className="mt-6 border-l-2 border-warn pl-4 text-sm">
          <p className="font-medium">Phone connection service is not installed</p>
          <p className="mt-2 leading-6 text-slate">HomeSafe Vault currently saves files selected on the computer. Android and iOS enrollment, biometric verification and Wi-Fi transfers are not available yet. Nothing will be sent or written from this screen.</p>
        </div>
        <form onSubmit={e => { e.preventDefault(); prepare(); }} onChange={() => setPrepared(false)} className="mt-8 grid gap-8 md:grid-cols-2">
          <section className="space-y-5">
            <h2 className="text-lg font-semibold">Device enrollment</h2>
            <label className="block text-sm">Device type<select aria-label="Device type" className={inputClass} value={platform} onChange={e => setPlatform(e.target.value)}><option>Android</option><option>iPhone</option><option>iPad</option><option>Android tablet</option></select></label>
            <label className="block text-sm">Profile name<input aria-label="Profile name" className={inputClass} value={profile} onChange={e => setProfile(e.target.value)} placeholder="Your name" maxLength={80} required /></label>
            <label className="block text-sm">Local Vault address<input aria-label="Local Vault address" className={inputClass} value={address} onChange={e => setAddress(e.target.value)} placeholder="https://192.168.1.108:7443" autoCapitalize="none" autoCorrect="off" required /></label>
          </section>
          <section className="space-y-5">
            <h2 className="flex items-center gap-2 text-lg font-semibold"><HardDrive size={18} />Backup destination</h2>
            <label className="block text-sm">Backup type<select aria-label="Backup type" className={inputClass} value={kind} onChange={e => { const next = e.target.value as BackupKind; setKind(next); if (today) setName(defaultBackupName(next, today)); }}><option value="Full">Full</option><option value="Custom">Custom</option></select></label>
            <label className="block text-sm">Backup name<input aria-label="Backup name" className={inputClass} value={name} onChange={e => setName(e.target.value)} required maxLength={80} /></label>
            <p className="break-all font-mono text-sm text-sagedeep">{ROOT_FOLDER}/{profile.trim() || "<profile>"}/{name || "<backup>"}/</p>
            <p className="text-sm leading-6 text-slate">Existing backups are never overwritten. Another backup on the same date requires a unique suffix. Existing names and drive access must be checked by the Vault before any write.</p>
          </section>
          <div className="md:col-span-2">
            {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
            {prepared && <div role="status" className="mb-5 border border-ink/10 p-4"><p className="flex items-center gap-2 font-medium"><AlertTriangle size={18} className="text-warn" />Setup details checked — enrollment pending</p><p className="mt-2 text-sm leading-6 text-slate">{platform} · {profile}. No device identity has been created or verified. Complete enrollment after the local Vault service and native phone connection are installed.</p></div>}
            <div className="flex flex-col gap-3 sm:flex-row"><PrimaryButton type="submit">Check setup details</PrimaryButton><GhostButton type="button" onClick={onDemo}>Open demo</GhostButton></div>
          </div>
        </form>
      </main>
    </div>
  );
}