import { useEffect, useMemo, useRef, useState } from "react";
import {
  ShieldCheck, Lock, LockOpen, HardDrive, QrCode, ChevronLeft, Check, Image as ImageIcon, User, FileText, Plus,
  Shield, Pause, Play, X, ScrollText, WifiOff, Wifi, ScanFace, Loader2, AlertTriangle, History, RotateCcw,
  Server, Smartphone, Laptop, Tablet, Thermometer, Activity, FolderOpen, CircleCheck, Unplug, Usb,
} from "lucide-react";
import { toast } from "sonner";
import livingRoom from "@/assets/living-room.jpg";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  SOURCES, FOLDERS, DRIVE_FREE_GB, FILES, selectedGb, selectedItems, fitsOnDrive, vaultCode, fmtGb, etaText, hexHash,
  type SourceId, type Snapshot,
} from "@/lib/vault";
import { Pill, PrimaryButton, GhostButton, Card, Toggle, Display } from "./ui";

type Step = "pairing" | "mfa" | "selection" | "sync" | "snapshots";
type SyncStatus = "running" | "paused" | "done" | "cancelled";
const FINGERPRINT = "SHA256 7F:9A:86:E3:4F:6B:58:2F:36:33:5D:66:62:C1:0E:A4";

const INITIAL_SNAPSHOTS: Snapshot[] = [
  { id: "s3", date: "Nov 14, 2026 · 02:00", gb: 131.8, files: 16840, dedupGb: 5.9, label: "Nightly vault backup" },
  { id: "s2", date: "Nov 13, 2026 · 02:00", gb: 131.2, files: 16790, dedupGb: 6.1, label: "Nightly vault backup" },
  { id: "s1", date: "Nov 7, 2026 · 21:14", gb: 118.6, files: 15210, dedupGb: 0, label: "First full backup" },
];

function useNow(ms = 1000) {
  const [n, setN] = useState(0);
  useEffect(() => { setN(Date.now()); const t = setInterval(() => setN(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return n;
}

export function HomeSafe() {
  const [wifi, setWifi] = useState(true);
  const [drive, setDrive] = useState(true);
  const [step, setStep] = useState<Step>("pairing");
  const [paired, setPaired] = useState(false);
  const [enabled, setEnabled] = useState<Record<SourceId, boolean>>({ photos: true, contacts: true, documents: true });
  const [differential, setDifferential] = useState(true);
  const [dedupe, setDedupe] = useState(true);
  const [encrypt, setEncrypt] = useState(true);
  const [folders, setFolders] = useState<string[]>(FOLDERS.map((f) => f.id));
  const [snapshots, setSnapshots] = useState(INITIAL_SNAPSHOTS);
  const [devices, setDevices] = useState([
    { id: "me", name: "This phone", kind: "phone", last: "Now" },
    { id: "ipad", name: "Kitchen iPad", kind: "tablet", last: "Yesterday 21:40" },
    { id: "mac", name: "Study MacBook", kind: "laptop", last: "Nov 12" },
  ]);
  const sync = useSync({ wifi, drive, total: selectedGb(enabled), differential, dedupe });

  useEffect(() => {
    if (sync.status === "done" && sync.committed === false) {
      sync.markCommitted();
      const now = new Date();
      setSnapshots((s) => [{ id: `s${Date.now()}`, date: now.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "").replace(/(\d{4}),?/, "$1 ·"), gb: sync.total, files: selectedItems(enabled), dedupGb: Math.round(sync.dedup * 10) / 10, label: "Nightly vault backup" }, ...s]);
      toast.success("Snapshot committed to your vault");
    }
  }, [sync, enabled]);

  const phone = (
    <PhoneFlow {...{ step, setStep, paired, setPaired, wifi, drive, enabled, setEnabled, differential, setDifferential, dedupe, setDedupe, encrypt, setEncrypt, folders, setFolders, sync, snapshots }} />
  );

  return (
    <div className="min-h-screen bg-ground text-ink">
      <StatusStrip wifi={wifi} drive={drive} setWifi={setWifi} setDrive={setDrive} />
      <div className="mx-auto max-w-[1280px] lg:grid lg:grid-cols-[1fr_420px] lg:gap-8 lg:px-8 lg:py-8">
        <div className="order-2 hidden lg:block">
          <div className="sticky top-14 overflow-hidden rounded-[32px] border border-ink/5 bg-ground shadow-[0_20px_50px_-24px_rgba(47,54,51,0.35)]" style={{ height: 764 }}>
            <div className="h-full overflow-y-auto">{phone}</div>
          </div>
        </div>
        <div className="mx-auto max-w-[440px] lg:hidden">{phone}</div>
        <div className="order-1 px-5 pb-10 md:px-8 lg:px-0 lg:pb-0">
          <Dashboard {...{ wifi, drive, setWifi, setDrive, paired, snapshots, devices, setDevices, sync }} />
        </div>
      </div>
    </div>
  );
}

/* ---------------- sync simulation ---------------- */
function useSync({ wifi, drive, total, differential, dedupe }: { wifi: boolean; drive: boolean; total: number; differential: boolean; dedupe: boolean }) {
  const [status, setStatus] = useState<SyncStatus | "idle">("idle");
  const [done, setDone] = useState(0);
  const [dedup, setDedup] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [fileIdx, setFileIdx] = useState(0);
  const [fileProg, setFileProg] = useState(0);
  const [tick, setTick] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [committed, setCommitted] = useState(true);
  const [frozenTotal, setFrozenTotal] = useState(total);
  const blocked = !wifi ? "Wi-Fi connection lost" : !drive ? "Backup drive disconnected" : null;
  const log = (m: string) => setLogs((l) => [`${new Date().toLocaleTimeString("en-GB")}  ${m}`, ...l].slice(0, 200));
  const prevBlocked = useRef<string | null>(null);

  useEffect(() => {
    if (status === "running" && blocked && prevBlocked.current !== blocked) log(`HALT ${blocked} — transfer suspended, nothing sent elsewhere`);
    if (!blocked && prevBlocked.current && status === "running") log("Link restored — resuming from last verified chunk");
    prevBlocked.current = blocked;
  }, [blocked, status]);

  useEffect(() => {
    if (status !== "running" || blocked) { setSpeed(0); return; }
    const t = setInterval(() => {
      // demo time-compression: each 400ms tick moves ~1.6 GB so a backup finishes in about a minute
      const s = 44 + Math.random() * 9;
      setSpeed(s);
      setTick((x) => x + 1);
      setFileProg((p) => {
        const np = p + 0.18 + Math.random() * 0.2;
        if (np >= 1) { setFileIdx((i) => { const ni = (i + 1) % FILES.length; log(`OK   ${FILES[i][0]} committed`); return ni; }); return 0; }
        return np;
      });
      setDone((d) => {
        const step = frozenTotal / 85;
        const nd = Math.min(frozenTotal, d + step * (s / 48));
        if (dedupe) setDedup((x) => x + step * 0.07);
        if (nd >= frozenTotal) { setStatus("done"); setCommitted(false); log("SNAPSHOT committed · manifest signed locally"); }
        return nd;
      });
    }, 400);
    return () => clearInterval(t);
  }, [status, blocked, frozenTotal, dedupe]);

  return {
    status, done, dedup, speed, fileIdx, fileProg, logs, blocked, committed, total: frozenTotal,
    hash: hexHash(tick + 1),
    start: () => {
      const t = differential ? Math.round(total * 10) / 10 : total;
      setFrozenTotal(t); setDone(0); setDedup(0); setFileIdx(0); setFileProg(0); setLogs([]); setStatus("running");
      log(`START ${fmtGb(t)} → WD MyPassport 4TB over LAN (mTLS, pinned cert)`);
      log(differential ? "MODE differential · unchanged files skipped" : "MODE full copy");
      if (dedupe) log("DEDUPE FastCDC chunking · BLAKE3 chunk ids");
    },
    pause: () => { setStatus("paused"); log("PAUSE by user"); },
    resume: () => { setStatus("running"); log("RESUME by user"); },
    cancel: () => { setStatus("cancelled"); log("CANCEL by user — partial chunks kept for next run"); },
    reset: () => setStatus("idle"),
    markCommitted: () => setCommitted(true),
  };
}
type Sync = ReturnType<typeof useSync>;

/* ---------------- top status strip ---------------- */
function StatusStrip({ wifi, drive, setWifi, setDrive }: { wifi: boolean; drive: boolean; setWifi: (v: boolean) => void; setDrive: (v: boolean) => void }) {
  return (
    <div role="status" className={cn("sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-ink/5 px-5 py-2 text-[12px] font-medium backdrop-blur", wifi ? "bg-ground/90 text-sagedeep" : "bg-warnsoft/95 text-warn")}>
      <span className="flex items-center gap-2">
        {wifi ? <Wifi size={14} /> : <WifiOff size={14} />}
        {wifi ? "Local network only · Home-WiFi-5G · 0 WAN bytes" : "Wi-Fi lost · backups paused · still nothing sent online"}
      </span>
      <details className="relative">
        <summary className="cursor-pointer list-none rounded-full px-2 py-0.5 text-slate hover:bg-sagesoft">Simulate</summary>
        <div className="absolute right-0 top-7 z-40 w-56 space-y-3 rounded-2xl bg-card p-4 text-ink shadow-lg">
          <label className="flex items-center justify-between gap-3 text-[13px]">Home Wi-Fi <Toggle on={wifi} onChange={setWifi} label="Home Wi-Fi connected" /></label>
          <label className="flex items-center justify-between gap-3 text-[13px]">Vault drive <Toggle on={drive} onChange={setDrive} label="Vault drive connected" /></label>
        </div>
      </details>
    </div>
  );
}

/* ---------------- phone flow ---------------- */
type FlowProps = {
  step: Step; setStep: (s: Step) => void; paired: boolean; setPaired: (v: boolean) => void; wifi: boolean; drive: boolean;
  enabled: Record<SourceId, boolean>; setEnabled: (e: Record<SourceId, boolean>) => void;
  differential: boolean; setDifferential: (v: boolean) => void; dedupe: boolean; setDedupe: (v: boolean) => void;
  encrypt: boolean; setEncrypt: (v: boolean) => void; folders: string[]; setFolders: (f: string[]) => void; sync: Sync; snapshots: Snapshot[];
};

function PhoneFlow(p: FlowProps) {
  return (
    <div className="flex min-h-[calc(100vh-37px)] flex-col lg:min-h-[764px]">
      {p.step === "pairing" && <Pairing {...p} />}
      {p.step === "mfa" && <Mfa {...p} />}
      {p.step === "selection" && <Selection {...p} />}
      {p.step === "sync" && <SyncScreen {...p} />}
      {p.step === "snapshots" && <SnapshotsScreen {...p} />}
    </div>
  );
}

function Pairing({ setStep, setPaired, wifi, drive }: FlowProps) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState(0); // 0 searching,1 tls,2 fingerprint,3 done
  const [qr, setQr] = useState(false);
  const begin = (viaQr: boolean) => {
    setQr(viaQr); setPhase(0); setOpen(true);
    setTimeout(() => setPhase(1), viaQr ? 1400 : 700);
    setTimeout(() => setPhase(2), viaQr ? 2400 : 1600);
  };
  const steps = [viaLabel(qr), "Opening mutual TLS on 192.168.1.108:7443", "Pin the vault's certificate"];
  return (
    <>
      <header className="px-6 pt-6">
        <Pill><ShieldCheck size={14} />100% Local · No Internet Used</Pill>
        <Display className="mt-6 text-[38px] leading-[42px]">Welcome Home</Display>
        <p className="mt-3 text-[15px] leading-[22px] text-slate">
          {wifi ? <>Connected to <span className="font-medium text-ink">Home-WiFi-5G</span>. Your storage drive is ready.</> : <>Not connected to your home Wi-Fi. Reconnect to find your vault — HomeSafe never uses the internet.</>}
        </p>
      </header>
      <main className="px-5 pb-32 pt-7">
        <div className="relative">
          <img src={livingRoom} alt="" className="h-[150px] w-full rounded-[28px] object-cover" />
          <div className="relative mx-3 -mt-14 rounded-[24px] bg-card p-5 shadow-[0_12px_32px_-12px_rgba(47,54,51,0.22)]">
            {wifi ? (
              <>
                <div className="flex items-start gap-4">
                  <div className="grid h-12 w-12 shrink-0 place-items-center rounded-[16px] bg-sagesoft text-sagedeep"><HardDrive size={24} strokeWidth={1.6} /></div>
                  <div className="min-w-0">
                    <div className="text-[16px] font-semibold leading-tight">Living Room Vault (Pi 5)</div>
                    <div className="mt-1 text-[13px] text-slate">{drive ? "WD MyPassport 4TB · 2.8 TB available" : "Drive not detected — plug it into the vault"}</div>
                  </div>
                </div>
                <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-sagesoft"><div className="h-full w-[30%] rounded-full bg-sage" /></div>
                <div className="mt-4 flex items-center justify-between">
                  <span className="rounded-full border border-ink/10 bg-ground px-3 py-1 font-mono text-[12.5px] text-slate">192.168.1.108</span>
                  <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-sagedeep"><span className="h-2 w-2 rounded-full bg-sage" />On your network</span>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-4 py-2">
                <div className="grid h-12 w-12 place-items-center rounded-[16px] bg-warnsoft text-warn"><WifiOff size={22} /></div>
                <div><div className="text-[15px] font-semibold">No vault found yet</div><div className="text-[13px] text-slate">Searching your local network…</div></div>
              </div>
            )}
          </div>
        </div>
        <button onClick={() => begin(true)} disabled={!wifi} className="mx-auto mt-8 flex items-center gap-2 text-[14px] font-medium text-slate hover:text-ink disabled:opacity-40">
          <QrCode size={18} strokeWidth={1.7} />Or scan pairing QR code on host screen
        </button>
      </main>
      <div className="sticky bottom-0 mt-auto px-5 pb-5">
        <PrimaryButton disabled={!wifi} onClick={() => begin(false)}><Lock size={17} />Connect Privately</PrimaryButton>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[360px] rounded-[24px] border-0 bg-card">
          <DialogHeader>
            <DialogTitle className="font-display text-[22px] font-normal">Pairing with your vault</DialogTitle>
            <DialogDescription>Happening only between this phone and Living Room Vault.</DialogDescription>
          </DialogHeader>
          <ol className="space-y-3">
            {steps.map((s, i) => (
              <li key={s} className="flex items-center gap-3 text-[14px]">
                {phase > i ? <CircleCheck size={18} className="text-sage" /> : phase === i ? <Loader2 size={18} className="animate-spin text-sage" /> : <span className="h-[18px] w-[18px] rounded-full border border-ink/15" />}
                <span className={phase < i ? "text-slate" : ""}>{s}</span>
              </li>
            ))}
          </ol>
          {phase >= 2 && (
            <div className="rounded-2xl bg-ground p-4">
              <div className="text-[12px] text-slate">Check this matches the fingerprint on the vault's screen</div>
              <div className="mt-2 break-all font-mono text-[12.5px] leading-5">{FINGERPRINT}</div>
              <div className="mt-4 flex gap-2">
                <GhostButton className="h-11 text-[14px]" onClick={() => { setOpen(false); toast.error("Pairing stopped. Nothing was saved."); }}>Doesn't match</GhostButton>
                <PrimaryButton className="h-11 text-[14px]" onClick={() => { setOpen(false); setPaired(true); setStep("mfa"); toast.success("Vault certificate pinned"); }}>It matches</PrimaryButton>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
const viaLabel = (qr: boolean) => (qr ? "Reading QR code from host screen" : "Finding Living Room Vault");

function Mfa({ setStep, wifi }: FlowProps) {
  const [face, setFace] = useState<"idle" | "scan" | "ok">("idle");
  const [digits, setDigits] = useState<string[]>(Array(6).fill(""));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const now = useNow();
  const code = digits.join("");
  const setAt = (i: number, v: string) => {
    const clean = v.replace(/\D/g, "");
    if (clean.length > 1) { const arr = clean.slice(0, 6).split(""); setDigits([...arr, ...Array(6 - arr.length).fill("")]); refs.current[Math.min(arr.length, 5)]?.focus(); return; }
    const n = [...digits]; n[i] = clean; setDigits(n); setErr("");
    if (clean && i < 5) refs.current[i + 1]?.focus();
  };
  const submit = () => {
    setBusy(true);
    setTimeout(() => {
      setBusy(false);
      if (code === vaultCode(now) || code === vaultCode(now - 30000)) setStep("selection");
      else { setErr("That code didn't match. Check the vault authenticator and try again."); setDigits(Array(6).fill("")); refs.current[0]?.focus(); }
    }, 700);
  };
  return (
    <>
      <header className="px-6 pt-6">
        <div className="flex items-center gap-3">
          <button onClick={() => setStep("pairing")} aria-label="Back" className="grid h-8 w-8 place-items-center rounded-full bg-sagesoft text-sagedeep"><Shield size={16} /></button>
          <span className="text-[14px] font-semibold">HomeSafe</span>
        </div>
        <Display className="mt-6">Authorize Local Backup</Display>
        <p className="mt-2 text-[15px] leading-[22px] text-slate">Your credentials never leave your home network.</p>
      </header>
      <main className="space-y-4 px-5 pb-32 pt-6">
        {face === "ok" ? (
          <div className="flex items-center gap-4 rounded-[24px] bg-sagesoft p-4">
            <div className="grid h-12 w-12 place-items-center rounded-full bg-sage text-primary-foreground shadow"><Check size={22} strokeWidth={2.5} /></div>
            <div><div className="text-[16px] font-semibold">Face ID confirmed</div><div className="text-[13px] text-sagedeep">Factor 1 complete</div></div>
          </div>
        ) : (
          <button onClick={() => { setFace("scan"); setTimeout(() => { setFace("ok"); refs.current[0]?.focus(); }, 1300); }} disabled={face === "scan"}
            className="flex w-full items-center gap-4 rounded-[24px] bg-sagesoft p-4 text-left">
            <div className="grid h-12 w-12 place-items-center rounded-full bg-card text-sagedeep">{face === "scan" ? <Loader2 className="animate-spin" size={22} /> : <ScanFace size={22} />}</div>
            <div><div className="text-[16px] font-semibold">{face === "scan" ? "Looking for your face…" : "Use Face ID or fingerprint"}</div><div className="text-[13px] text-sagedeep">Factor 1 · checked on this phone</div></div>
          </button>
        )}
        <div className={cn("rounded-[24px] bg-card p-5 shadow-[0_12px_32px_-16px_rgba(47,54,51,0.18)] transition-opacity", face !== "ok" && "opacity-50")}>
          <label className="text-[13.5px] font-medium" htmlFor="otp-0">Enter 6-digit code from your authenticator</label>
          <div className="mt-3 flex justify-between gap-2">
            {digits.map((d, i) => (
              <input key={i} id={`otp-${i}`} ref={(el) => { refs.current[i] = el; }} value={d} inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                aria-label={`Digit ${i + 1}`} disabled={face !== "ok"}
                onChange={(e) => setAt(i, e.target.value)}
                onKeyDown={(e) => { if (e.key === "Backspace" && !d && i > 0) refs.current[i - 1]?.focus(); if (e.key === "Enter" && code.length === 6) submit(); }}
                className={cn("h-14 w-full min-w-0 rounded-[16px] bg-ground text-center font-display text-[24px] outline-none focus:border-2 focus:border-sage focus:bg-card", err && "border border-destructive")} />
            ))}
          </div>
          {err && <p role="alert" className="mt-3 text-[13px] text-destructive">{err}</p>}
          {face === "ok" && <p className="mt-3 text-[12px] text-slate">Code on your vault's display right now: <span className="font-mono text-ink">{now ? vaultCode(now) : "······"}</span></p>}
        </div>
        <div className="rounded-[24px] border border-ink/10 p-5">
          <Pill className="py-1"><WifiOff size={14} />Verified offline</Pill>
          <p className="mt-3 text-[15px] leading-[22px] text-ink/80">Mutual TLS verification directly against your local drive.</p>
        </div>
      </main>
      <div className="sticky bottom-0 mt-auto px-5 pb-5">
        <PrimaryButton disabled={face !== "ok" || code.length < 6 || busy || !wifi} onClick={submit}>
          {busy ? <Loader2 size={17} className="animate-spin" /> : <LockOpen size={17} />}{!wifi ? "Reconnect to home Wi-Fi" : "Unlock & Proceed"}
        </PrimaryButton>
      </div>
    </>
  );
}

const ICONS: Record<SourceId, typeof ImageIcon> = { photos: ImageIcon, contacts: User, documents: FileText };

function Selection(p: FlowProps) {
  const { enabled, setEnabled, setStep, sync, drive, wifi } = p;
  const [foldersOpen, setFoldersOpen] = useState(false);
  const gb = selectedGb(enabled);
  const ok = fitsOnDrive(gb) && drive && wifi;
  return (
    <>
      <header className="flex items-center justify-between gap-2 px-5 pt-6">
        <button aria-label="Back" onClick={() => setStep("mfa")} className="grid h-10 w-10 place-items-center rounded-full hover:bg-sagesoft"><ChevronLeft size={22} /></button>
        <h1 className="font-display text-[26px] tracking-tight">Choose what to keep</h1>
        <Pill className="py-1"><Lock size={12} />Offline</Pill>
      </header>
      <main className="space-y-3 px-5 pb-32 pt-6">
        <Card className="p-5">
          <div className="flex items-baseline gap-2"><span className="font-display text-[34px] leading-none tabular-nums">{gb.toFixed(1)}</span><span className="font-display text-[17px] text-slate">GB selected</span></div>
          <div className="mt-5 h-2 overflow-hidden rounded-full bg-sagesoft"><div className="h-full rounded-full bg-sage transition-all" style={{ width: `${Math.max(2, (gb / DRIVE_FREE_GB) * 100)}%` }} /></div>
          <div className={cn("mt-4 flex items-center gap-2 text-[13.5px]", drive ? "text-slate" : "text-warn")}>{drive ? <HardDrive size={15} /> : <Unplug size={15} />}{drive ? "2.8 TB free on WD 4TB Drive" : "Vault drive disconnected — reconnect to continue"}</div>
        </Card>
        {SOURCES.map((s) => {
          const Icon = ICONS[s.id];
          return (
            <Card key={s.id} className="flex items-center gap-4 p-5">
              <div className="grid h-11 w-11 place-items-center rounded-[14px] bg-sagesoft text-sagedeep"><Icon size={20} strokeWidth={1.7} /></div>
              <div className="min-w-0 flex-1"><div className="text-[15px] font-medium">{s.name}</div><div className="text-[13px] text-slate/80">{s.meta}</div></div>
              <Toggle on={enabled[s.id]} label={s.name} onChange={(v) => setEnabled({ ...enabled, [s.id]: v })} />
            </Card>
          );
        })}
        <button onClick={() => setFoldersOpen(true)} className="flex h-[52px] w-full items-center justify-center gap-2 rounded-full border border-ink/10 bg-card/60 text-[15px] font-medium text-slate hover:bg-card">
          <Plus size={16} className="text-sage" />Choose specific folders
        </button>
        <label className="flex cursor-pointer items-start gap-3 px-2 pt-2 text-[14px] text-slate">
          <input type="checkbox" checked={p.differential} onChange={(e) => p.setDifferential(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--sage)]" />
          <span>Only copy new and modified files <span className="text-slate/70">(differential sync)</span></span>
        </label>
        <div className="space-y-3 rounded-[20px] border border-ink/10 p-4">
          <div className="flex items-center justify-between gap-3 text-[13.5px]"><span><span className="font-medium text-ink">Deduplicate</span><br /><span className="text-slate">BLAKE3 hashing · FastCDC chunks</span></span><Toggle on={p.dedupe} onChange={p.setDedupe} label="Deduplicate" /></div>
          <div className="flex items-center justify-between gap-3 text-[13.5px]"><span><span className="font-medium text-ink">Encrypt on this phone</span><br /><span className="text-slate">AES-GCM-256 · key stays at home</span></span><Toggle on={p.encrypt} onChange={p.setEncrypt} label="Encrypt on this phone" /></div>
        </div>
        {gb === 0 && <p className="px-2 text-[13px] text-warn">Pick at least one thing to back up.</p>}
      </main>
      <div className="sticky bottom-0 mt-auto px-4 pb-5">
        <PrimaryButton disabled={!ok} onClick={() => { sync.start(); setStep("sync"); }}><Shield size={17} />Start Safe Backup</PrimaryButton>
      </div>
      <Dialog open={foldersOpen} onOpenChange={setFoldersOpen}>
        <DialogContent className="max-w-[360px] rounded-[24px] border-0 bg-card">
          <DialogHeader><DialogTitle className="font-display text-[22px] font-normal">Choose specific folders</DialogTitle><DialogDescription>Only ticked folders are copied.</DialogDescription></DialogHeader>
          <ul className="space-y-2">
            {FOLDERS.map((f) => (
              <li key={f.id}><label className="flex items-center gap-3 rounded-2xl bg-ground px-4 py-3 text-[14px]">
                <input type="checkbox" className="h-5 w-5 accent-[var(--sage)]" checked={p.folders.includes(f.id)} onChange={(e) => p.setFolders(e.target.checked ? [...p.folders, f.id] : p.folders.filter((x) => x !== f.id))} />
                <FolderOpen size={16} className="text-sage" /><span className="flex-1">{f.name}</span><span className="tabular-nums text-slate">{f.gb} GB</span>
              </label></li>
            ))}
          </ul>
          <PrimaryButton className="h-12 text-[15px]" onClick={() => setFoldersOpen(false)}>Done · {p.folders.length} folders</PrimaryButton>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Ring({ pct }: { pct: number }) {
  const r = 100, c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 228 228" className="h-[214px] w-[214px] -rotate-90" aria-hidden>
      <circle cx="114" cy="114" r={r} fill="none" strokeWidth="14" className="stroke-ink/8" />
      <circle cx="114" cy="114" r={r} fill="none" strokeWidth="14" strokeLinecap="round" className="stroke-sage transition-all duration-500" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} />
    </svg>
  );
}

function SyncScreen({ sync, setStep, encrypt }: FlowProps) {
  const [logsOpen, setLogsOpen] = useState(false);
  const pct = sync.total ? Math.floor((sync.done / sync.total) * 100) : 0;
  const file = FILES[sync.fileIdx];
  const st = sync.blocked ? "Waiting" : sync.status === "running" ? "Syncing" : sync.status === "paused" ? "Paused" : sync.status === "done" ? "Complete" : "Cancelled";

  if (sync.status === "done" || sync.status === "cancelled") {
    const done = sync.status === "done";
    return (
      <>
        <header className="px-6 pt-7">
          <h1 className="text-[26px] font-medium tracking-tight">{done ? "Backup complete" : "Backup cancelled"}</h1>
          <p className="mt-1 text-[14px] text-slate">{done ? "Snapshot saved on your home drive" : "Already-copied chunks are kept for next time"}</p>
        </header>
        <main className="space-y-4 px-5 pb-10 pt-8">
          <div className="grid place-items-center py-4"><div className={cn("grid h-24 w-24 place-items-center rounded-full", done ? "bg-sage text-primary-foreground" : "bg-warnsoft text-warn")}>{done ? <Check size={42} strokeWidth={2.5} /> : <X size={42} />}</div></div>
          <Card className="divide-y divide-ink/8 p-6">
            <Row k="Copied to vault" v={fmtGb(sync.done)} />
            <Row k="Saved by deduplication" v={fmtGb(sync.dedup)} />
            <Row k="Encryption" v={encrypt ? "AES-GCM-256 on device" : "Off"} />
            <Row k="Sent outside your home" v="0 bytes" />
          </Card>
          <PrimaryButton onClick={() => setStep("snapshots")}><History size={17} />Browse snapshots</PrimaryButton>
          <GhostButton onClick={() => { sync.reset(); setStep("selection"); }}><RotateCcw size={17} />{done ? "New backup" : "Back to selection"}</GhostButton>
          <button onClick={() => setLogsOpen(true)} className="mx-auto flex items-center gap-2 text-[14px] text-slate hover:text-ink"><ScrollText size={16} />View transfer logs</button>
        </main>
        <LogsDialog open={logsOpen} setOpen={setLogsOpen} logs={sync.logs} />
      </>
    );
  }

  return (
    <>
      <header className="flex items-start justify-between px-6 pt-6">
        <div><h1 className="text-[26px] font-medium tracking-tight">Live Sync</h1><p className="mt-0.5 text-[14px] text-slate">Nightly vault backup</p></div>
        <Pill tone={sync.blocked ? "warn" : "card"} className="py-2"><span className={cn("h-2 w-2 rounded-full", sync.blocked ? "bg-warn" : "bg-sage", st === "Syncing" && "animate-pulse")} />{st}</Pill>
      </header>
      <main className="px-5 pb-10 pt-6">
        <div className="relative mx-auto grid h-[214px] w-[214px] place-items-center" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Backup progress">
          <Ring pct={pct} />
          <div className="absolute text-center">
            <div className="font-display text-[56px] leading-none tabular-nums">{pct}<span className="text-[24px] text-slate">%</span></div>
            <div className="mt-3 text-[12.5px] tabular-nums text-slate">{sync.done.toFixed(1)} GB of {sync.total.toFixed(1)} GB</div>
          </div>
        </div>
        <div className="mt-8 flex justify-center"><Pill className="px-4 py-2.5 text-[13px]"><ShieldCheck size={15} />Air-Gapped · 0 WAN Bytes Sent</Pill></div>
        {sync.blocked && (
          <div role="alert" className="mt-4 flex items-start gap-3 rounded-[20px] bg-warnsoft p-4 text-[13.5px] text-warn">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" /><div><div className="font-medium">{sync.blocked}</div><div>Backup is on hold and will resume by itself once it's back.</div></div>
          </div>
        )}
        <Card className="mt-6 px-6 py-6">
          <div className="text-[12.5px] text-slate">Transfer speed</div>
          <div className="mt-1 text-[20px] font-medium tabular-nums">{sync.speed.toFixed(0)} MB/s <span className="text-[14px] font-normal text-slate">(Wi-Fi 6)</span></div>
          <div className="my-4 h-px bg-ink/10" />
          <div className="text-[12.5px] text-slate">Estimated time</div>
          <div className="mt-1 text-[17px] font-medium">{sync.status === "paused" ? "Paused" : sync.blocked ? "Waiting for connection" : etaText(sync.total - sync.done, sync.speed || 48)}</div>
          <div className="my-4 h-px bg-ink/10" />
          <div className="text-[12.5px] text-slate">Active file</div>
          <div className="mt-1 truncate text-[16px] font-medium">{file[0]} <span className="font-normal text-slate">({file[1] >= 1 ? `${file[1]} MB` : `${Math.round(file[1] * 1000)} KB`})</span></div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink/8"><div className="h-full rounded-full bg-sage transition-all" style={{ width: `${sync.fileProg * 100}%` }} /></div>
          <div className="mt-3 flex justify-between gap-3 text-[12px] text-slate"><span className="truncate font-mono">chunk {sync.hash.slice(0, 20)}…</span><span className="shrink-0 tabular-nums text-sagedeep">{sync.dedup.toFixed(1)} GB deduped</span></div>
        </Card>
        <div className="relative z-10 -mt-3 grid grid-cols-[1fr_auto] gap-2">
          {sync.status === "paused"
            ? <GhostButton onClick={sync.resume}><Play size={17} />Resume Backup</GhostButton>
            : <GhostButton onClick={sync.pause} disabled={!!sync.blocked}><Pause size={17} />Pause Backup</GhostButton>}
          <button onClick={sync.cancel} aria-label="Cancel backup" className="grid h-14 w-14 place-items-center rounded-full border border-ink/10 bg-card text-slate hover:text-destructive"><X size={18} /></button>
        </div>
        <Card className="-mt-3 flex items-center gap-4 bg-card/70 px-5 pb-4 pt-7">
          <div className="grid h-11 w-11 place-items-center rounded-[14px] bg-ink/5 text-slate"><HardDrive size={20} /></div>
          <div><div className="text-[15px] font-medium">WD MyPassport 4TB</div><div className="text-[13px] text-slate">{(2.8 - sync.done / 1000).toFixed(2)} TB remaining</div></div>
        </Card>
        <button onClick={() => setLogsOpen(true)} className="mx-auto mt-5 flex items-center gap-2 text-[14px] text-slate hover:text-ink"><ScrollText size={16} />View transfer logs</button>
      </main>
      <LogsDialog open={logsOpen} setOpen={setLogsOpen} logs={sync.logs} />
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between py-3 text-[14px] first:pt-0 last:pb-0"><span className="text-slate">{k}</span><span className="font-medium tabular-nums">{v}</span></div>;
}

function LogsDialog({ open, setOpen, logs }: { open: boolean; setOpen: (v: boolean) => void; logs: string[] }) {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-[420px] rounded-[24px] border-0 bg-card">
        <DialogHeader><DialogTitle className="font-display text-[22px] font-normal">Transfer logs</DialogTitle><DialogDescription>Kept on your vault. Every entry is local-network only.</DialogDescription></DialogHeader>
        <div className="max-h-[50vh] overflow-y-auto rounded-2xl bg-ground p-3 font-mono text-[11.5px] leading-5">
          {logs.length ? logs.map((l, i) => <div key={i}>{l}</div>) : <div className="text-slate">No transfers yet.</div>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SnapshotsScreen({ snapshots, setStep, sync, drive }: FlowProps) {
  return (
    <>
      <header className="flex items-center gap-2 px-5 pt-6">
        <button aria-label="Back" onClick={() => setStep(sync.status === "idle" ? "selection" : "sync")} className="grid h-10 w-10 place-items-center rounded-full hover:bg-sagesoft"><ChevronLeft size={22} /></button>
        <h1 className="flex-1 font-display text-[26px] tracking-tight">Your snapshots</h1>
        <Pill className="py-1"><Lock size={12} />Offline</Pill>
      </header>
      <main className="px-5 pb-10 pt-6"><SnapshotExplorer snapshots={snapshots} drive={drive} /></main>
    </>
  );
}

/* ---------------- snapshot explorer + restore ---------------- */
function SnapshotExplorer({ snapshots, drive, compact }: { snapshots: Snapshot[]; drive: boolean; compact?: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [restore, setRestore] = useState<{ pct: number; done: boolean } | null>(null);
  const snap = snapshots.find((s) => s.id === openId);
  useEffect(() => {
    if (!restore || restore.done) return;
    const t = setInterval(() => setRestore((r) => r && (r.pct >= 100 ? { pct: 100, done: true } : { ...r, pct: Math.min(100, r.pct + 9) })), 250);
    return () => clearInterval(t);
  }, [restore]);
  if (!drive) return <Empty icon={<Unplug size={20} />} title="Drive not connected" body="Plug the WD MyPassport back into your vault to browse snapshots." />;
  if (!snapshots.length) return <Empty icon={<History size={20} />} title="No snapshots yet" body="Your first backup will appear here." />;
  if (!snap) {
    return (
      <ul className="space-y-2">
        {snapshots.map((s, i) => (
          <li key={s.id}><button onClick={() => { setOpenId(s.id); setPicked([]); setRestore(null); }} className="flex w-full items-center gap-4 rounded-[20px] bg-card p-4 text-left shadow-[0_8px_24px_-18px_rgba(47,54,51,0.3)] hover:bg-sagesoft/50">
            <div className="grid h-10 w-10 place-items-center rounded-[12px] bg-sagesoft text-sagedeep"><History size={18} /></div>
            <div className="min-w-0 flex-1"><div className="text-[14.5px] font-medium">{s.date}{i === 0 && <span className="ml-2 rounded-full bg-sagesoft px-2 py-0.5 text-[11px] text-sagedeep">Latest</span>}</div><div className="text-[12.5px] text-slate">{s.label} · {fmtGb(s.gb)} · {s.files.toLocaleString()} files{!compact && s.dedupGb > 0 && ` · ${s.dedupGb} GB deduped`}</div></div>
          </button></li>
        ))}
      </ul>
    );
  }
  const files = FILES.map(([n, mb]) => ({ n, mb }));
  return (
    <div className="space-y-3">
      <button onClick={() => setOpenId(null)} className="flex items-center gap-1 text-[13.5px] text-slate hover:text-ink"><ChevronLeft size={16} />All snapshots</button>
      <div className="text-[15px] font-medium">{snap.date}</div>
      <ul className="divide-y divide-ink/8 rounded-[20px] bg-card px-4">
        {files.map((f) => (
          <li key={f.n}><label className="flex items-center gap-3 py-3 text-[13.5px]">
            <input type="checkbox" className="h-4 w-4 accent-[var(--sage)]" checked={picked.includes(f.n)} onChange={(e) => setPicked(e.target.checked ? [...picked, f.n] : picked.filter((x) => x !== f.n))} />
            <span className="flex-1 truncate">{f.n}</span><span className="tabular-nums text-slate">{f.mb >= 1 ? `${f.mb} MB` : `${Math.round(f.mb * 1000)} KB`}</span>
          </label></li>
        ))}
      </ul>
      {restore ? (
        <div className="rounded-[20px] bg-sagesoft p-4 text-[13.5px] text-sagedeep" role="status">
          {restore.done ? <span className="flex items-center gap-2"><CircleCheck size={16} />Restored {picked.length} file{picked.length > 1 ? "s" : ""} to this phone over your Wi-Fi.</span>
            : <><div>Restoring over local network… {restore.pct}%</div><div className="mt-2 h-1.5 rounded-full bg-card"><div className="h-full rounded-full bg-sage transition-all" style={{ width: `${restore.pct}%` }} /></div></>}
        </div>
      ) : (
        <PrimaryButton className="h-12 text-[15px]" disabled={!picked.length} onClick={() => setRestore({ pct: 0, done: false })}><RotateCcw size={16} />Restore {picked.length || ""} to this phone</PrimaryButton>
      )}
    </div>
  );
}

function Empty({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return <div className="rounded-[20px] border border-dashed border-ink/15 p-6 text-center"><div className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-sagesoft text-sagedeep">{icon}</div><div className="mt-3 text-[14.5px] font-medium">{title}</div><div className="mt-1 text-[13px] text-slate">{body}</div></div>;
}

/* ---------------- dashboard (tablet/desktop) ---------------- */
function Dashboard({ wifi, drive, setWifi, setDrive, paired, snapshots, devices, setDevices, sync }: {
  wifi: boolean; drive: boolean; setWifi: (v: boolean) => void; setDrive: (v: boolean) => void; paired: boolean; snapshots: Snapshot[];
  devices: { id: string; name: string; kind: string; last: string }[]; setDevices: (d: { id: string; name: string; kind: string; last: string }[]) => void; sync: Sync;
}) {
  const now = useNow();
  const used = 1200 + (sync.status === "idle" ? 0 : sync.done);
  const [restarting, setRestarting] = useState(false);
  const DevIcon = useMemo(() => ({ phone: Smartphone, tablet: Tablet, laptop: Laptop }) as Record<string, typeof Smartphone>, []);
  return (
    <div className="hidden pt-8 md:block lg:pt-0">
      <div className="mb-6 flex items-end justify-between">
        <div><Pill><ShieldCheck size={14} />100% Local · No Internet Used</Pill><h2 className="mt-4 font-display text-[34px] tracking-tight">HomeSafe Vault</h2><p className="text-[14px] text-slate">Living Room Vault (Pi 5) · managed from your home network only</p></div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <PanelTitle icon={<Server size={16} />} title="Host daemon" />
          <div className="mt-4 space-y-2 text-[13.5px]">
            <Row k="Status" v={restarting ? "Restarting…" : wifi ? "Running · homesafed 2.4" : "Unreachable"} />
            <Row k="Address" v="192.168.1.108:7443" />
            <Row k="Certificate" v={paired ? "Pinned on this phone" : "Not yet pinned"} />
          </div>
          <div className="mt-4 rounded-2xl bg-ground p-4">
            <div className="text-[12px] text-slate">Vault authenticator · refreshes every 30s</div>
            <div className="mt-1 font-display text-[30px] tracking-[0.2em] tabular-nums">{now ? vaultCode(now) : "······"}</div>
          </div>
          <div className="mt-4 flex gap-2">
            <GhostButton className="h-11 text-[14px]" disabled={restarting || !wifi} onClick={() => { setRestarting(true); setTimeout(() => { setRestarting(false); toast.success("Vault daemon restarted"); }, 1500); }}><RotateCcw size={15} />Restart</GhostButton>
            <GhostButton className="h-11 text-[14px]" onClick={() => setWifi(!wifi)}>{wifi ? <WifiOff size={15} /> : <Wifi size={15} />}{wifi ? "Drop Wi-Fi" : "Rejoin Wi-Fi"}</GhostButton>
          </div>
        </Card>
        <Card>
          <PanelTitle icon={<HardDrive size={16} />} title="Drive health" />
          {drive ? (
            <>
              <div className="mt-4 flex items-baseline gap-2"><span className="font-display text-[30px] tabular-nums">{fmtGb(4000 - used)}</span><span className="text-[13px] text-slate">free of 4 TB</span></div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-sagesoft"><div className="h-full rounded-full bg-sage" style={{ width: `${(used / 4000) * 100}%` }} /></div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center text-[12px]">
                <Stat icon={<Activity size={14} />} k="SMART" v="Healthy" />
                <Stat icon={<Thermometer size={14} />} k="Temp" v="34°C" />
                <Stat icon={<Usb size={14} />} k="Link" v="USB 3.2" />
              </div>
            </>
          ) : <div className="mt-4"><Empty icon={<Unplug size={20} />} title="WD MyPassport disconnected" body="Backups wait until the drive is back. Nothing is lost." /></div>}
          <GhostButton className="mt-4 h-11 text-[14px]" onClick={() => setDrive(!drive)}>{drive ? "Safely eject drive" : "Reconnect drive"}</GhostButton>
        </Card>
        <Card className="md:col-span-1">
          <PanelTitle icon={<History size={16} />} title="Snapshot explorer" />
          <div className="mt-4"><SnapshotExplorer snapshots={snapshots} drive={drive} compact /></div>
        </Card>
        <Card>
          <PanelTitle icon={<Smartphone size={16} />} title="Connected devices" />
          <ul className="mt-4 space-y-2">
            {devices.map((d) => { const I = DevIcon[d.kind] ?? Smartphone; return (
              <li key={d.id} className="flex items-center gap-3 rounded-2xl bg-ground p-3">
                <I size={18} className="text-sagedeep" /><div className="flex-1"><div className="text-[14px] font-medium">{d.name}</div><div className="text-[12px] text-slate">Last backup · {d.last}</div></div>
                {d.id !== "me" && <button className="rounded-full px-3 py-1 text-[12.5px] text-slate hover:bg-warnsoft hover:text-warn" onClick={() => { setDevices(devices.filter((x) => x.id !== d.id)); toast(`${d.name} can no longer reach the vault`); }}>Revoke</button>}
              </li>); })}
          </ul>
        </Card>
      </div>
    </div>
  );
}
function PanelTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return <div className="flex items-center gap-2 text-[14px] font-semibold"><span className="grid h-7 w-7 place-items-center rounded-full bg-sagesoft text-sagedeep">{icon}</span>{title}</div>;
}
function Stat({ icon, k, v }: { icon: React.ReactNode; k: string; v: string }) {
  return <div className="rounded-2xl bg-ground p-3"><div className="flex justify-center text-sage">{icon}</div><div className="mt-1 text-slate">{k}</div><div className="font-medium">{v}</div></div>;
}
