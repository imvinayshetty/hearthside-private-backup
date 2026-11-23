import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Wifi, QrCode, Keyboard, ArrowRight, Loader2, ShieldCheck, HardDrive, Timer } from "lucide-react";
import { ConnectionShell, connectionInput } from "@/components/homesafe/ConnectionShell";
import { GhostButton, PrimaryButton } from "@/components/homesafe/ui";
import { DriveCard, useDriveStatus } from "@/components/homesafe/DriveCard";
import { localVaultAddress, pairingCode } from "@/lib/backup-rules";
import { nativeVault, offerSchema, sessionSchema, useLocalConnection, type PairOffer } from "@/lib/local-connection";
import { CODE_HINT, confirmDeadline, fingerprintPin, secondsLeft, vaultProblem, type DiscoveredVault, type PairingQr } from "@/lib/vault-protocol";

export const Route = createFileRoute("/pair")({
  head: () => ({ meta: [{ title: "Pair on home Wi-Fi — HomeSafe" }, { name: "description", content: "Securely pair HomeSafe with your local Vault using a code or QR." }, { property: "og:title", content: "Pair on home Wi-Fi — HomeSafe" }, { property: "og:description", content: "Connect privately to your Vault at home." }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }] }),
  component: PairPage,
});

type Method = { kind: "found"; vault: DiscoveredVault } | { kind: "manual" } | null;

function PairPage() {
  const connection = useLocalConnection();
  const navigate = useNavigate();
  const [wifi, setWifi] = useState<boolean | null>(null);
  const [network, setNetwork] = useState("");
  const [vaults, setVaults] = useState<DiscoveredVault[]>([]);
  const [searching, setSearching] = useState(true);
  const [method, setMethod] = useState<Method>(null);
  const [address, setAddress] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [offer, setOffer] = useState<PairOffer | null>(null);
  const [deadline, setDeadline] = useState(0);
  const [left, setLeft] = useState(0);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const bridge = nativeVault();
        const result = await bridge.network();
        if (!live) return;
        setWifi(result.wifi); setNetwork(result.name || "");
        if (result.wifi) { const found = await bridge.discover(); if (live) setVaults(found); }
      } catch { /* No browser claim of Wi-Fi discovery or verified identity. */ }
      finally { if (live) setSearching(false); }
    })();
    return () => { live = false; };
  }, []);

  // Confirmation must happen within 30 s of begin; on expiry start over cleanly.
  useEffect(() => {
    if (!offer) return;
    const tick = () => {
      const s = secondsLeft(deadline, Date.now()); setLeft(s);
      if (s === 0) { setOffer(null); setCode(""); setError("Time ran out before you confirmed. " + CODE_HINT); }
    };
    tick(); const id = setInterval(tick, 250); return () => clearInterval(id);
  }, [offer, deadline]);

  async function begin(target: { address: string; fingerprint: string; code: string; email?: string }) {
    setError(""); setBusy(true);
    try {
      const bridge = nativeVault();
      if (wifi !== true) throw new Error("Connect to your home Wi-Fi first.");
      const email = target.email || connection.email;
      if (target.email && target.email !== connection.email) connection.setEmail(target.email); // QR email wins over the typed one.
      const began = Date.now();
      const result = offerSchema.parse(await bridge.begin({ email, code: pairingCode(target.code), address: localVaultAddress(target.address), fingerprint: fingerprintPin(target.fingerprint) }));
      if (result.email !== email) throw new Error("Vault account mismatch. Pairing stopped.");
      setDeadline(confirmDeadline(result.expiresAt, began)); setOffer(result);
    } catch (e) { setError(vaultProblem(e, "Unable to pair. " + CODE_HINT).message); }
    finally { setBusy(false); }
  }
  async function scan() {
    setMethod(null); setError(""); setBusy(true);
    let qr: PairingQr | null = null;
    try { qr = await nativeVault().scanQR(); }
    catch (e) { setError(e instanceof Error ? e.message : "Camera unavailable. Enter the code instead."); }
    finally { setBusy(false); }
    if (qr) await begin(qr);
  }
  async function confirm() {
    if (!offer) return;
    setBusy(true); setError("");
    try {
      if (secondsLeft(deadline, Date.now()) === 0) throw new Error("Time ran out. " + CODE_HINT);
      const session = sessionSchema.parse(await nativeVault().confirm(offer.requestId));
      if (session.email !== offer.email || session.profile !== offer.profile || session.phone !== offer.phone) throw new Error("Device destination mismatch. Pairing stopped.");
      connection.setSession(session); await navigate({ to: "/backups" });
    } catch (e) { setOffer(null); setCode(""); setError(vaultProblem(e, "Pairing could not be confirmed. " + CODE_HINT).message); }
    finally { setBusy(false); }
  }
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (method?.kind === "found") void begin({ address: method.vault.address, fingerprint: method.vault.fingerprint, code });
    else void begin({ address, fingerprint, code });
  }

  const shown = method?.kind === "found" ? method.vault : vaults[0] ?? null;
  const drive = useDriveStatus(shown ? { address: shown.address, fingerprint: shown.fingerprint } : null);
  if (!connection.email) return <ConnectionShell title="Login first" step={1}><Link to="/" className="mt-8 inline-block text-sagedeep underline">Go to Login</Link></ConnectionShell>;
  const codeField = <label className="block text-sm font-medium">Code shown on your Vault<input className={connectionInput + " text-center font-mono text-xl"} aria-label="Pairing code" inputMode="numeric" maxLength={6} autoComplete="one-time-code" pattern="[0-9]{6}" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))} placeholder="000000" required /></label>;
  const submitButton = <PrimaryButton type="submit" disabled={busy || code.length !== 6}>{busy ? <Loader2 size={18} className="animate-spin motion-reduce:animate-none" /> : <ArrowRight size={18} />}Pair with Vault</PrimaryButton>;

  return <ConnectionShell title={offer ? "Confirm your phone" : "Connect your Vault"} step={2} back="/">
    <div role="status" className="my-8 flex items-center gap-3 border-y border-ink/10 py-5"><Wifi size={24} className="text-sagedeep" /><div><p className="text-sm font-medium">{wifi === true ? (network ? <>Connected to <span className="break-all">{network}</span></> : "Wi-Fi connected") : wifi === false ? "Wi-Fi disconnected" : "Wi-Fi can't be checked here"}</p><p className="mt-1 text-xs text-slate">{wifi === true ? (searching ? "Looking for your Vault…" : vaults.length ? `${vaults.length === 1 ? "1 Vault" : `${vaults.length} Vaults`} found on this Wi-Fi` : "No Vault found yet — scan its QR code or enter it manually") : wifi === false ? "Connect to the same home Wi-Fi as your Vault." : "Open the HomeSafe app on your phone to check Wi-Fi."}</p></div></div>
    {!offer && <DriveCard status={drive} />}
    {offer ? <div className="space-y-6">
      <ShieldCheck size={30} className="text-sagedeep" />
      <dl className="space-y-4"><div><dt className="text-xs text-slate">Profile</dt><dd className="mt-1 break-words font-medium">{offer.profile}</dd></div><div><dt className="text-xs text-slate">Phone or tablet</dt><dd className="mt-1 break-words font-medium">{offer.phone}</dd></div></dl>
      <p role="timer" aria-live="polite" className="flex items-center gap-2 text-sm text-slate"><Timer size={16} />Confirm within <span className="font-mono font-medium tabular-nums text-ink">{left}s</span></p>
      <PrimaryButton disabled={busy || left === 0} onClick={confirm}>Confirm & continue<ArrowRight size={18} /></PrimaryButton>
    </div> : <>
      <p className="text-sm leading-6 text-slate">{CODE_HINT}</p>
      {vaults.length > 0 && <ul className="mt-6 space-y-3" aria-label="Vaults on this Wi-Fi">{vaults.map(v => <li key={v.fingerprint + v.address}><GhostButton disabled={busy} aria-pressed={method?.kind === "found" && method.vault === v} onClick={() => { setMethod({ kind: "found", vault: v }); setError(""); }} className="h-16 w-full justify-start rounded-xl px-4"><HardDrive size={22} /><span className="text-left"><span className="block font-medium">{v.name}</span><span className="block text-xs text-slate">Found on this Wi-Fi</span></span></GhostButton></li>)}</ul>}
      <div className="mt-6 grid grid-cols-2 gap-3"><GhostButton disabled={busy} onClick={scan} className="h-24 flex-col rounded-xl"><QrCode size={25} />Scan QR code</GhostButton><GhostButton disabled={busy} aria-pressed={method?.kind === "manual"} onClick={() => { setMethod({ kind: "manual" }); setError(""); }} className="h-24 flex-col rounded-xl"><Keyboard size={25} />Enter manually</GhostButton></div>
      {method?.kind === "found" && <form className="mt-8 space-y-5" onSubmit={submit}><p className="text-sm">Pairing with <span className="font-medium">{method.vault.name}</span></p>{codeField}{submitButton}</form>}
      {method?.kind === "manual" && <form className="mt-8 space-y-5" onSubmit={submit}>
        <label className="block text-sm font-medium">Vault address<input className={connectionInput + " font-mono"} aria-label="Vault address" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={address} onChange={e => setAddress(e.target.value.trim())} placeholder="https://192.168.1.20:7443" required /></label>
        <label className="block text-sm font-medium">Fingerprint<textarea className={connectionInput + " h-auto min-h-20 py-3 font-mono text-xs"} aria-label="Vault fingerprint" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={fingerprint} onChange={e => setFingerprint(e.target.value)} placeholder="64 characters shown on your Vault" required /></label>
        {codeField}{submitButton}
      </form>}
    </>}
    {error && <p role="alert" className="mt-6 text-sm leading-6 text-destructive">{error}</p>}
  </ConnectionShell>;
}
