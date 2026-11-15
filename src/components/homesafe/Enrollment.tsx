import { useEffect, useState } from "react";
import { HardDrive, Shield, Smartphone, AlertTriangle, Wifi, QrCode, Keyboard, Loader2 } from "lucide-react";
import { ROOT_FOLDER, defaultBackupName, localVaultAddress, pairingCode, safeSegment, vaultEmail, type BackupKind } from "@/lib/backup-rules";
import { cn } from "@/lib/utils";
import { Display, GhostButton, Pill, PrimaryButton } from "./ui";

type Method = "wifi" | "qr" | "manual";
type Outcome = null | "checking" | "unavailable";

export function Enrollment({ onDemo }: { onDemo: () => void }) {
  const [method, setMethod] = useState<Method>("manual");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [kind, setKind] = useState<BackupKind>("Full");
  const [today, setToday] = useState<Date | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState<Outcome>(null);
  useEffect(() => setToday(new Date()), []);
  const inputClass = "mt-2 min-h-12 w-full rounded-md border border-ink/15 bg-card px-3 text-ink outline-none focus:border-sage";

  async function pick(next: Method) {
    setMethod(next); setError(""); setNote(""); setOutcome(null);
    if (next === "wifi") setNote("Finding your Vault on home Wi-Fi needs the installed HomeSafe app for Android or iPhone. Enter the address shown on your Vault instead.");
    if (next === "qr") {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error();
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        stream.getTracks().forEach(t => t.stop());
        setNote("Camera allowed. Reading the Vault's pairing QR needs the installed HomeSafe app. Type the address and code below for now.");
      } catch { setNote("Camera access was not allowed. Type the Vault's local address and six-digit code instead."); }
      setMethod("manual");
    }
  }

  function connect() {
    setError(""); setOutcome(null);
    try {
      vaultEmail(email); localVaultAddress(address); pairingCode(code);
      setOutcome("checking");
      setTimeout(() => setOutcome("unavailable"), 900);
    } catch (e) { setError(e instanceof Error ? e.message : "Check your details."); }
  }

  const backup = today ? defaultBackupName(kind, today) : `${kind}_Bckup_DDMMYY`;
  const methods: { id: Method; label: string; icon: typeof Wifi }[] = [
    { id: "wifi", label: "Find on Wi-Fi", icon: Wifi }, { id: "qr", label: "Scan QR", icon: QrCode }, { id: "manual", label: "Type address", icon: Keyboard },
  ];
  const profilePreview = "<profile>";

  return (
    <div className="min-h-screen bg-ground text-ink">
      <header className="border-b border-ink/10 px-5 py-4"><div className="mx-auto flex max-w-4xl items-center gap-2 font-semibold"><Shield size={20} className="text-sagedeep" />HomeSafe <span className="ml-auto text-sm font-normal text-slate">Phone & tablet</span></div></header>
      <main className="mx-auto max-w-4xl px-5 py-8 md:py-12">
        <Pill><Smartphone size={15} />Not paired</Pill>
        <Display className="mt-5">Connect to your Vault</Display>
        <p className="mt-3 max-w-xl text-sm leading-6 text-slate">Use the email you registered on your Vault. Your profile and phone name are chosen there — this phone never creates a second account.</p>

        <div role="radiogroup" aria-label="How to connect" className="mt-8 grid gap-3 sm:grid-cols-3">
          {methods.map(m => (
            <button key={m.id} type="button" role="radio" aria-checked={method === m.id} onClick={() => pick(m.id)}
              className={cn("flex min-h-14 items-center gap-3 rounded-xl border px-4 text-left font-medium", method === m.id ? "border-sage bg-sagesoft" : "border-ink/15 bg-card")}>
              <m.icon size={18} className="text-sagedeep" />{m.label}
            </button>
          ))}
        </div>
        {note && <p role="status" className="mt-4 border-l-2 border-warn pl-4 text-sm leading-6 text-slate">{note}</p>}

        <form onSubmit={e => { e.preventDefault(); connect(); }} className="mt-8 grid gap-8 md:grid-cols-2">
          <section className="space-y-5">
            <label className="block text-sm">Vault account email<input aria-label="Vault account email" type="email" className={inputClass} value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoCapitalize="none" required /></label>
            <label className="block text-sm">Local Vault address<input aria-label="Local Vault address" className={inputClass} value={address} onChange={e => setAddress(e.target.value)} placeholder="https://192.168.1.108:7443" autoCapitalize="none" autoCorrect="off" required /></label>
            <label className="block text-sm">Pairing code from Vault<input aria-label="Pairing code" inputMode="numeric" maxLength={7} className={cn(inputClass, "font-mono tracking-[0.3em]")} value={code} onChange={e => setCode(e.target.value)} placeholder="000000" required /></label>
            <p className="text-xs leading-5 text-slate">This is the one-time code your Vault shows after you sign in and pick a phone — not your Authy login code.</p>
          </section>
          <section className="space-y-5">
            <h2 className="flex items-center gap-2 text-lg font-semibold"><HardDrive size={18} />Backups go to</h2>
            <p className="break-all font-mono text-sm text-sagedeep">{ROOT_FOLDER} / {profilePreview} / &lt;phone name&gt; / {backup}</p>
            <label className="block text-sm">Backup type<select aria-label="Backup type" className={inputClass} value={kind} onChange={e => setKind(e.target.value as BackupKind)}><option value="Full">Full</option><option value="Custom">Custom</option></select></label>
            <p className="text-sm leading-6 text-slate">Full backup includes only files this phone allows HomeSafe to read. Existing backups are never overwritten; another backup on the same date needs a unique suffix.</p>
          </section>
          <div className="md:col-span-2">
            {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
            {outcome === "checking" && <p role="status" className="mb-4 flex items-center gap-2 text-sm"><Loader2 size={16} className="animate-spin" />Contacting your Vault…</p>}
            {outcome === "unavailable" && <div role="alert" className="mb-5 border border-ink/10 p-4"><p className="flex items-center gap-2 font-medium"><AlertTriangle size={18} className="text-warn" />Vault unavailable — not paired</p><p className="mt-2 text-sm leading-6 text-slate">Your Vault's phone connection service isn't installed yet, so this phone can't confirm your account, profile or phone name. Nothing was sent or saved. Check the Vault is on, on the same Wi-Fi, and has phone pairing turned on.</p></div>}
            <div className="flex flex-col gap-3 sm:flex-row"><PrimaryButton type="submit" disabled={outcome === "checking"}>Pair with Vault</PrimaryButton><GhostButton type="button" onClick={onDemo}>Open demo</GhostButton></div>
          </div>
        </form>
      </main>
    </div>
  );
}
