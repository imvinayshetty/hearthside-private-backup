import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { HardDrive, RefreshCw, ShieldCheck } from "lucide-react";
import { ConnectionShell } from "@/components/homesafe/ConnectionShell";
import { GhostButton } from "@/components/homesafe/ui";
import { catalogSchema, nativeVault, useLocalConnection } from "@/lib/local-connection";
import type { z } from "zod";

export const Route = createFileRoute("/backups")({ head: () => ({ meta: [{ title: "Your backups — HomeSafe" }, { name: "description", content: "View backups saved privately to your local HomeSafe Vault." }, { property: "og:title", content: "Your backups — HomeSafe" }, { property: "og:description", content: "Your phone's saved backups on your home drive." }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }] }), component: BackupsPage });
function BackupsPage() {
  const { session } = useLocalConnection();
  const [catalog, setCatalog] = useState<z.infer<typeof catalogSchema>["backups"]>([]);
  const [kind, setKind] = useState(""); const [date, setDate] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function refresh() { setBusy(true); setError(""); try { setCatalog(catalogSchema.parse(await nativeVault().catalog()).backups); } catch (e) { setError(e instanceof Error ? e.message : "Cannot read your Vault."); } finally { setBusy(false); } }
  useEffect(() => { if (session) void refresh(); }, [session]);
  if (!session) return <ConnectionShell title="Backups" step={3} back="/"><HardDrive size={36} className="mt-10 text-sage" /><p className="mt-5 text-sm leading-6 text-slate">Pair with your Vault to view this phone’s backups.</p><Link to="/" className="mt-8 inline-block text-sagedeep underline">Go to Login</Link></ConnectionShell>;
  const rows = catalog.filter(b => (!kind || b.kind === kind) && (!date || b.date === date));
  return <ConnectionShell title="Backups" step={3} back="/pair"><p className="mt-4 flex items-center gap-2 text-sm text-sagedeep"><ShieldCheck size={17} />{session.profile} · {session.phone}</p><div className="mt-8 flex flex-wrap gap-3"><select aria-label="Backup type" className="h-11 rounded-lg border bg-card px-3" value={kind} onChange={e => setKind(e.target.value)}><option value="">All backups</option><option value="Full">Full</option><option value="Custom">Custom</option></select><input type="date" aria-label="Backup date" className="h-11 min-w-0 rounded-lg border bg-card px-3" value={date} onChange={e => setDate(e.target.value)} /><GhostButton aria-label="Refresh backups" disabled={busy} onClick={refresh} className="h-11 w-11"><RefreshCw size={17} /></GhostButton></div>{error ? <p role="alert" className="mt-8 text-sm text-destructive">{error}</p> : busy ? <p role="status" className="mt-10 text-sm text-slate">Reading your Vault…</p> : rows.length ? <ul className="mt-8 divide-y divide-ink/10">{rows.map(b => <li key={b.name} className="py-5"><p className="break-all text-sm font-medium">{b.name}</p><p className="mt-2 text-xs text-slate">{b.date} · {b.files} files · {b.complete ? "Complete" : "Incomplete"}</p></li>)}</ul> : <div className="mt-12 text-center"><HardDrive size={36} className="mx-auto text-sage" /><h2 className="mt-4 font-medium">{catalog.length ? "No matching backups" : "No backups yet"}</h2></div>}</ConnectionShell>;
}