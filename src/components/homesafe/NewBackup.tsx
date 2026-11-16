import { useEffect, useRef, useState } from "react";
import { FolderOpen, Loader2, Play } from "lucide-react";
import { GhostButton, PrimaryButton } from "./ui";
import { connectionInput } from "./ConnectionShell";
import { defaultBackupName, requireAvailableBackup, type BackupKind } from "@/lib/backup-rules";
import { nativeVault, pickSchema, startSchema, transferSchema } from "@/lib/local-connection";
import type { z } from "zod";

type Item = z.infer<typeof pickSchema>["items"][number];
type Transfer = z.infer<typeof transferSchema>;

// Shown only inside a verified pairing session (pairing_verified for this profile and phone).
export function NewBackup({ existing, onDone }: { existing: { name: string; date: string }[]; onDone: () => void }) {
  const [kind, setKind] = useState<BackupKind>("Full");
  const [name, setName] = useState(() => defaultBackupName("Full", new Date()));
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  const today = new Date();
  let nameError = "";
  try { requireAvailableBackup(name, kind, today, existing); } catch (e) { nameError = e instanceof Error ? e.message : "Invalid name."; }
  const running = transfer?.state === "running";

  function choose(k: BackupKind) { setKind(k); setName(defaultBackupName(k, new Date())); setItems([]); setError(""); setTransfer(null); }
  async function pick() {
    setError(""); setBusy(true);
    try { setItems(pickSchema.parse(await nativeVault().pick({ kind })).items); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not open the picker."); }
    finally { setBusy(false); }
  }
  async function start() {
    setError(""); setBusy(true);
    try {
      const clean = requireAvailableBackup(name, kind, new Date(), existing);
      if (!items.length) throw new Error(kind === "Full" ? "Load your phone's files first." : "Choose at least one file or folder.");
      const bridge = nativeVault();
      const { transferId } = startSchema.parse(await bridge.startBackup({ name: clean, kind, paths: items.map(i => i.path) }));
      setTransfer({ state: "running", sentBytes: 0, totalBytes: items.reduce((s, i) => s + i.bytes, 0) });
      timer.current = setInterval(async () => {
        try {
          const t = transferSchema.parse(await bridge.transferStatus(transferId));
          setTransfer(t);
          if (t.state !== "running") { if (timer.current) clearInterval(timer.current); onDone(); }
        } catch (e) {
          if (timer.current) clearInterval(timer.current);
          setTransfer(p => ({ state: "failed", sentBytes: p?.sentBytes ?? 0, totalBytes: p?.totalBytes ?? 0, reason: e instanceof Error ? e.message : "Lost contact with your Vault." }));
        }
      }, 1000);
    } catch (e) { setError(e instanceof Error ? e.message : "The backup could not start."); }
    finally { setBusy(false); }
  }
  const pct = transfer && transfer.totalBytes ? Math.min(100, Math.round((transfer.sentBytes / transfer.totalBytes) * 100)) : 0;
  const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;

  return <section aria-labelledby="new-backup" className="mt-8 rounded-2xl border border-ink/10 bg-card p-5">
    <h2 id="new-backup" className="font-medium">New backup</h2>
    <div role="radiogroup" aria-label="Backup type" className="mt-4 grid grid-cols-2 gap-3">
      {(["Full", "Custom"] as const).map(k => <GhostButton key={k} role="radio" aria-checked={kind === k} disabled={running} onClick={() => choose(k)} className={"h-auto flex-col items-start rounded-xl p-3 text-left " + (kind === k ? "border-sage bg-sagesoft" : "")}><span className="font-medium">{k === "Full" ? "Full backup" : "Custom folders"}</span><span className="text-xs text-slate">{k === "Full" ? "All files the phone allows" : "Pick files or folders"}</span></GhostButton>)}
    </div>
    <GhostButton disabled={busy || running} onClick={pick} className="mt-4 w-full"><FolderOpen size={17} />{kind === "Full" ? "Load phone files" : "Choose files or folders"}</GhostButton>
    {items.length > 0 && <p className="mt-2 text-xs text-slate">{items.length} items · {mb(items.reduce((s, i) => s + i.bytes, 0))}</p>}
    <label className="mt-5 block text-sm font-medium">Backup name<input aria-label="Backup name" className={connectionInput} value={name} disabled={running} onChange={e => setName(e.target.value)} aria-invalid={!!nameError} /></label>
    {nameError && <p role="alert" className="mt-2 text-xs leading-5 text-warn">{nameError} {nameError.includes("suffix") && `For example ${defaultBackupName(kind, today)}_2.`}</p>}
    <PrimaryButton className="mt-5" disabled={busy || running || !!nameError || !items.length} onClick={start}>{busy ? <Loader2 size={18} className="animate-spin motion-reduce:animate-none" /> : <Play size={18} />}Start backup</PrimaryButton>
    {transfer && <div role="status" className="mt-5 text-sm">
      {transfer.state === "running" && <><div className="h-2 overflow-hidden rounded-full bg-ink/10"><div className="h-full bg-sage transition-all" style={{ width: `${pct}%` }} /></div><p className="mt-2 text-slate">{pct}% · {mb(transfer.sentBytes)} of {mb(transfer.totalBytes)}</p></>}
      {transfer.state === "complete" && <p className="text-sagedeep">Backup complete · {mb(transfer.sentBytes)} saved to your Vault.</p>}
      {transfer.state === "failed" && <p className="text-destructive">Backup failed: {transfer.reason || "The Vault stopped the transfer."}</p>}
    </div>}
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
  </section>;
}
