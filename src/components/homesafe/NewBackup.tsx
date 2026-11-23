import { useEffect, useRef, useState } from "react";
import { FolderOpen, Loader2, Play } from "lucide-react";
import { GhostButton, PrimaryButton } from "./ui";
import { connectionInput } from "./ConnectionShell";
import { defaultBackupName, requireAvailableBackup, type BackupKind } from "@/lib/backup-rules";
import { compareSchema, handleVaultError, nativeVault, pickSchema, startSchema, transferSchema, withReconnect } from "@/lib/local-connection";
import { vaultProblem } from "@/lib/vault-protocol";
import type { z } from "zod";

type Item = z.infer<typeof pickSchema>["items"][number];
type Transfer = z.infer<typeof transferSchema>;
type Compare = Extract<z.infer<typeof compareSchema>, { found: true }>;
type Mode = "Changes" | "Full" | "Custom";

const mb = (b: number) => b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} GB` : `${(b / 1048576).toFixed(1)} MB`;
/** Items are named "Folder/Sub/file"; group by the first folder so people can see what a Full backup covers. */
export function folderSummary(items: { name: string; bytes: number }[]) {
  const groups = new Map<string, { count: number; bytes: number }>();
  for (const i of items) { const top = i.name.split("/")[0] || "Other"; const g = groups.get(top) ?? { count: 0, bytes: 0 }; g.count++; g.bytes += i.bytes; groups.set(top, g); }
  return [...groups.entries()].map(([folder, g]) => ({ folder, ...g })).sort((a, b) => b.bytes - a.bytes);
}

// Shown only inside a verified pairing session (pairing_verified for this profile and phone).
export function NewBackup({ existing, onDone, onRepair, freeBytes }: { freeBytes?: number | undefined; existing: { name: string; date: string }[]; onDone: () => void; onRepair: () => void }) {
  const hasFull = existing.some(b => /^Full_Bckup_/.test(b.name));
  const [mode, setMode] = useState<Mode>(hasFull ? "Changes" : "Full");
  const kind: BackupKind = mode === "Full" ? "Full" : "Custom";
  const suggest = (m: Mode) => m === "Changes" ? `${defaultBackupName("Custom", new Date())}_Changes` : defaultBackupName(m, new Date());
  const [name, setName] = useState(() => suggest(hasFull ? "Changes" : "Full"));
  const [items, setItems] = useState<Item[]>([]);
  const [diff, setDiff] = useState<Compare | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [transferId, setTransferId] = useState("");
  const [renames, setRenames] = useState<Record<number, string>>({});
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  const today = new Date();
  let nameError = "";
  try { requireAvailableBackup(name, kind, today, existing); } catch (e) { nameError = e instanceof Error ? e.message : "Invalid name."; }
  const needed = mode === "Changes" ? diff?.changedBytes ?? 0 : items.reduce((s, i) => s + i.bytes, 0);
  const noRoom = freeBytes !== undefined && needed > freeBytes;
  const running = transfer?.state === "running" || transfer?.state === "waiting" || transfer?.state === "review";

  async function analyse() {
    setError(""); setNote(""); setDiff(null); setBusy(true);
    try {
      const bridge = nativeVault();
      const all = pickSchema.parse(await bridge.pick({ kind: "Full" })).items; setItems(all);
      const result = compareSchema.parse(await withReconnect(bridge, () => bridge.compareWithLastFull({ paths: all.map(i => i.path) })));
      if (!result.found) { setNote("No earlier Full backup of this phone was found, so a Full backup is needed first."); choose("Full"); return; }
      setDiff(result);
    } catch (e) { setNote(`Syncing only changes is not available here (${vaultProblem(e, "unavailable").message}). Choose Full or Custom.`); choose("Full"); }
    finally { setBusy(false); }
  }
  // Same phone again: find the last Full backup and what changed since, without being asked.
  useEffect(() => { if (hasFull && mode === "Changes" && !items.length && !diff && !transfer) void analyse(); }, [hasFull]); // eslint-disable-line react-hooks/exhaustive-deps

  function choose(m: Mode) { setMode(m); setName(suggest(m)); setItems([]); setDiff(null); setError(""); setTransfer(null); if (m === "Changes") void analyse(); }
  async function pick() {
    setError(""); setBusy(true);
    try { setItems(pickSchema.parse(await nativeVault().pick({ kind })).items); }
    catch (e) { setError(vaultProblem(e, "Could not open the picker.").message); }
    finally { setBusy(false); }
  }
  async function start() {
    setError(""); setBusy(true);
    try {
      const clean = requireAvailableBackup(name, kind, new Date(), existing);
      const paths = mode === "Changes" ? (diff?.changed ?? []) : items.map(i => i.path);
      if (!paths.length) throw new Error(mode === "Changes" ? "Nothing has changed since your last Full backup." : kind === "Full" ? "Load your phone's files first." : "Choose at least one file or folder.");
      const bridge = nativeVault();
      const { transferId } = startSchema.parse(await withReconnect(bridge, () => bridge.startBackup({ name: clean, kind, paths, ...(mode === "Changes" && diff ? { basedOn: diff.name } : {}) })));
      setTransferId(transferId); setRenames({});
      setTransfer({ state: "running", problems: [], skippedCount: 0, sentBytes: 0, totalBytes: mode === "Changes" && diff ? diff.changedBytes : items.reduce((s, i) => s + i.bytes, 0) });
      timer.current = setInterval(async () => {
        try {
          const t = transferSchema.parse(await bridge.transferStatus(transferId));
          if (t.state === "failed" && t.code) { const reason = await handleVaultError({ code: t.code, message: t.reason }, t.reason || "The Vault stopped the transfer.", onRepair); setTransfer({ ...t, reason }); } else setTransfer(t);
          if (t.state === "complete" || t.state === "failed") { if (timer.current) clearInterval(timer.current); onDone(); }
        } catch (e) {
          if (timer.current) clearInterval(timer.current);
          setTransfer(p => ({ state: "failed", problems: [], skippedCount: 0, sentBytes: p?.sentBytes ?? 0, totalBytes: p?.totalBytes ?? 0, reason: e instanceof Error ? e.message : "Lost contact with your Vault." }));
        }
      }, 1000);
    } catch (e) { setError(await handleVaultError(e, "The backup could not start.", onRepair)); }
    finally { setBusy(false); }
  }
  async function decide(actions: { index: number; action: "retry" | "rename" | "skip"; name?: string }[]) {
    try { await nativeVault().resolveProblems({ transferId, actions }); } catch (e) { setError(vaultProblem(e, "Could not send your choice.").message); }
  }
  async function cancel() {
    if (!window.confirm("Cancel this backup? Files already copied stay on your Vault, and you can start again or sync changes later.")) return;
    try { await nativeVault().cancelBackup({ transferId }); } catch (e) { setError(vaultProblem(e, "Could not cancel.").message); }
  }
  const pct = transfer && transfer.totalBytes ? Math.min(100, Math.round((transfer.sentBytes / transfer.totalBytes) * 100)) : 0;
  const folders = mode === "Full" ? folderSummary(items) : [];
  const options: { id: Mode; title: string; hint: string }[] = [
    ...(hasFull ? [{ id: "Changes" as const, title: "Sync changes only", hint: "New or changed since the last Full backup" }] : []),
    { id: "Full", title: "Full backup", hint: "All photos and videos on this phone" },
    { id: "Custom", title: "Custom folders", hint: "Pick files or folders" },
  ];

  return <section aria-labelledby="new-backup" className="mt-8 rounded-2xl border border-ink/10 bg-card p-5">
    <h2 id="new-backup" className="font-medium">New backup</h2>
    <div role="radiogroup" aria-label="Backup type" className={`mt-4 grid gap-3 ${options.length === 3 ? "grid-cols-1" : "grid-cols-2"}`}>
      {options.map(o => <GhostButton key={o.id} role="radio" aria-checked={mode === o.id} disabled={running} onClick={() => choose(o.id)} className={"h-auto flex-col items-start rounded-xl p-3 text-left " + (mode === o.id ? "border-sage bg-sagesoft" : "")}><span className="font-medium">{o.title}</span><span className="text-xs text-slate">{o.hint}</span></GhostButton>)}
    </div>
    {note && <p role="status" className="mt-3 text-xs leading-5 text-slate">{note}</p>}
    {mode === "Changes" ? <div className="mt-4 rounded-xl border border-ink/10 p-3 text-sm">
      {busy && !diff ? <p className="flex items-center gap-2 text-slate"><Loader2 size={15} className="animate-spin motion-reduce:animate-none" />Comparing with your last Full backup…</p>
        : diff ? <>
          <p className="font-medium">Last Full backup: {diff.name}</p>
          <p className="text-xs text-slate">{diff.date} · {diff.files.toLocaleString()} files · {mb(diff.bytes)}</p>
          <p className="mt-2">{diff.changedCount === 0 ? "Everything on this phone is already in that backup." : `${diff.changedCount.toLocaleString()} new or changed ${diff.changedCount === 1 ? "file" : "files"} (${mb(diff.changedBytes)}) will be sent; ${diff.unchangedCount.toLocaleString()} unchanged are skipped.`}</p>
        </> : null}
    </div> : <GhostButton disabled={busy || running} onClick={pick} className="mt-4 w-full"><FolderOpen size={17} />{mode === "Full" ? "Load phone files" : "Choose files or folders"}</GhostButton>}
    {mode !== "Changes" && items.length > 0 && <p className="mt-2 text-xs text-slate">{items.length.toLocaleString()} {items.length === 1 ? "item" : "items"} · {mb(items.reduce((s, i) => s + i.bytes, 0))}</p>}
    {mode === "Full" && <div className="mt-3 text-xs text-slate">
      <p>A Full backup copies the photos and videos in your phone's media library. Other files, such as documents, need Custom folders.</p>
      {folders.length > 0 && <ul aria-label="Folders in this backup" className="mt-2 space-y-1">{folders.slice(0, 8).map(f => <li key={f.folder} className="flex justify-between gap-3"><span className="truncate">{f.folder}</span><span className="shrink-0">{f.count.toLocaleString()} · {mb(f.bytes)}</span></li>)}{folders.length > 8 && <li>+ {folders.length - 8} more folders</li>}</ul>}
    </div>}
    <label className="mt-5 block text-sm font-medium">Backup name<input aria-label="Backup name" className={connectionInput} value={name} disabled={running} onChange={e => setName(e.target.value)} aria-invalid={!!nameError} /></label>
    {nameError && <p role="alert" className="mt-2 text-xs leading-5 text-warn">{nameError} {name.trim().toLowerCase() === suggest(mode).toLowerCase() && `A backup already exists for today — add a suffix such as ${suggest(mode)}_2.`}</p>}
    {noRoom && <p role="alert" className="mt-3 text-xs leading-5 text-warn">This backup needs {mb(needed)} but the Vault drive has only {mb(freeBytes ?? 0)} free. Choose fewer files or free up space on the drive.</p>}
    <PrimaryButton className="mt-5" disabled={busy || running || noRoom || !!nameError || (mode === "Changes" ? !diff?.changedCount : !items.length)} onClick={start}>{busy && mode !== "Changes" ? <Loader2 size={18} className="animate-spin motion-reduce:animate-none" /> : <Play size={18} />}Start backup</PrimaryButton>
    {transfer && <div role="status" className="mt-5 text-sm">
      {transfer.state === "review" && <div aria-label="Files to review" className="rounded-xl border border-warn/40 p-3">
        <p className="font-medium">{transfer.problems.length} {transfer.problems.length === 1 ? "file needs" : "files need"} your decision</p>
        <p className="text-xs text-slate">Everything else is already saved. Choose what to do with each file, then the backup finishes.</p>
        <ul className="mt-3 space-y-3">{transfer.problems.map(p => <li key={p.index} className="text-xs">
          <p className="break-all font-medium">{p.name}</p><p className="text-slate">{p.reason}</p>
          <input aria-label={`New name for ${p.name}`} className={connectionInput + " mt-1"} value={renames[p.index] ?? p.name} onChange={e => setRenames(r => ({ ...r, [p.index]: e.target.value }))} />
          <div className="mt-2 flex flex-wrap gap-2"><GhostButton onClick={() => void decide([{ index: p.index, action: "retry" }])}>Retry copy</GhostButton><GhostButton disabled={(renames[p.index] ?? p.name) === p.name} onClick={() => void decide([{ index: p.index, action: "rename", name: renames[p.index] ?? p.name }])}>Rename and copy</GhostButton><GhostButton onClick={() => void decide([{ index: p.index, action: "skip" }])}>Skip</GhostButton></div>
        </li>)}</ul>
        <div className="mt-3 flex flex-wrap gap-2"><GhostButton onClick={() => void decide(transfer.problems.map(p => ({ index: p.index, action: "retry" as const })))}>Retry all</GhostButton><GhostButton onClick={() => void decide(transfer.problems.map(p => ({ index: p.index, action: "skip" as const })))}>Skip all</GhostButton></div>
      </div>}
      {(transfer.state === "running" || transfer.state === "waiting") && <><div className="h-2 overflow-hidden rounded-full bg-ink/10"><div className="h-full bg-sage transition-all" style={{ width: `${pct}%` }} /></div>
        <p className="mt-2 text-slate">{pct}% · {mb(transfer.sentBytes)} of {mb(transfer.totalBytes)}{transfer.state === "running" && transfer.bytesPerSecond ? ` · ${(transfer.bytesPerSecond / 1048576).toFixed(1)} MB/s` : ""}</p>
        {transfer.problems.length > 0 && <p className="mt-1 text-warn">{transfer.problems.length} {transfer.problems.length === 1 ? "file" : "files"} could not be copied. The backup continues, and you can review {transfer.problems.length === 1 ? "it" : "them"} at the end.</p>}
        {transfer.state === "waiting" && <p className="mt-1 text-warn">{transfer.reason || "Waiting for your Vault…"} The backup continues where it stopped.</p>}</>}
      {running && <GhostButton className="mt-3" onClick={() => void cancel()}>Cancel backup</GhostButton>}
      {transfer.state === "complete" && <p className="text-sagedeep">Backup complete · {mb(transfer.sentBytes)} saved to your Vault.{transfer.skippedCount > 0 ? ` ${transfer.skippedCount} skipped ${transfer.skippedCount === 1 ? "file is" : "files are"} listed in the backup details.` : ""}</p>}
      {transfer.state === "failed" && <p className="text-destructive">{transfer.code === "cancelled" ? "Backup cancelled. Files already copied are safe on your Vault." : `Backup failed: ${transfer.reason || "The Vault stopped the transfer."}`}</p>}
    </div>}
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
  </section>;
}
