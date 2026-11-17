import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Wifi, QrCode, Keyboard, ArrowRight, Loader2, ShieldCheck } from "lucide-react";
import { ConnectionShell, connectionInput } from "@/components/homesafe/ConnectionShell";
import { GhostButton, PrimaryButton } from "@/components/homesafe/ui";
import { localVaultAddress, pairingCode } from "@/lib/backup-rules";
import { nativeVault, offerSchema, sessionSchema, useLocalConnection, type PairOffer } from "@/lib/local-connection";

export const Route = createFileRoute("/pair")({
  head: () => ({ meta: [{ title: "Pair on home Wi-Fi — HomeSafe" }, { name: "description", content: "Securely pair HomeSafe with your local Vault using a code or QR." }, { property: "og:title", content: "Pair on home Wi-Fi — HomeSafe" }, { property: "og:description", content: "Connect privately to your Vault at home." }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }] }),
  component: PairPage,
});

function PairPage() {
  const connection = useLocalConnection();
  const navigate = useNavigate();
  const [wifi, setWifi] = useState<boolean | null>(null);
  const [network, setNetwork] = useState("");
  const [method, setMethod] = useState<"code" | "qr" | null>(null);
  const [address, setAddress] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [searching, setSearching] = useState(true);
  const [vaultName, setVaultName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [offer, setOffer] = useState<PairOffer | null>(null);
  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const bridge = nativeVault();
        const result = await bridge.network();
        if (!live) return;
        setWifi(result.wifi); setNetwork(result.name || "");
        if (!result.wifi) return;
        const vaults = await bridge.discover();
        const vault = vaults.length === 1 ? vaults[0] : undefined;
        if (live && vault) { setAddress(localVaultAddress(vault.address)); setFingerprint(vault.fingerprint); setVaultName((vault as { name?: string }).name || "HomeSafe Vault"); }
      } catch { /* No browser claim of Wi-Fi discovery or verified identity. */ }
      finally { if (live) setSearching(false); }
    }
    void load(); return () => { live = false; };
  }, []);

  async function begin(qr?: { address: string; fingerprint: string; code: string }) {
    setError(""); setBusy(true);
    try {
      const bridge = nativeVault();
      if (wifi !== true) throw new Error("Connect to your home Wi-Fi first.");
      const input = qr || { address, fingerprint, code };
      if (!input.address) throw new Error("No Vault found on this Wi-Fi. Scan the QR code on your Vault instead.");
      const pin = input.fingerprint.replace(/:/g, "").toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(pin)) throw new Error("Your Vault's identity could not be read. Scan the QR code on your Vault instead.");
      const result = offerSchema.parse(await bridge.begin({ email: connection.email, code: pairingCode(input.code), address: localVaultAddress(input.address), fingerprint: pin }));
      if (result.email !== connection.email) throw new Error("Vault account mismatch. Pairing stopped.");
      setOffer(result);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to pair. Request a new code on your Vault."); }
    finally { setBusy(false); }
  }
  async function scan() {
    setMethod("qr"); setError(""); setBusy(true);
    try {
      const qr = await nativeVault().scanQR();
      setAddress(localVaultAddress(qr.address)); setFingerprint(qr.fingerprint); setCode(pairingCode(qr.code));
      setMethod("code");
      await begin(qr);
    } catch (e) { setError(e instanceof Error ? e.message : "Camera unavailable. Enter the code instead."); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!offer) return;
    setBusy(true); setError("");
    try {
      if (offer.expiresAt <= Date.now() / 1000) throw new Error("Pairing expired. Request a new code on your Vault.");
      const session = sessionSchema.parse(await nativeVault().confirm(offer.requestId));
      if (session.email !== connection.email || session.profile !== offer.profile || session.phone !== offer.phone) throw new Error("Device destination mismatch. Pairing stopped.");
      connection.setSession(session); await navigate({ to: "/backups" });
    } catch (e) { setError(e instanceof Error ? e.message : "Pairing could not be confirmed."); }
    finally { setBusy(false); }
  }
  if (!connection.email) return <ConnectionShell title="Login first" step={1}><Link to="/" className="mt-8 inline-block text-sagedeep underline">Go to Login</Link></ConnectionShell>;
  return <ConnectionShell title={offer ? "Confirm your phone" : "Connect your Vault"} step={2} back="/">
    <div role="status" className="my-8 flex items-center gap-3 border-y border-ink/10 py-5"><Wifi size={24} className="text-sagedeep" /><div><p className="text-sm font-medium">{wifi === true ? (network ? <>Connected to <span className="break-all">{network}</span></> : "Wi-Fi connected") : wifi === false ? "Wi-Fi disconnected" : "Wi-Fi can't be checked here"}</p><p className="mt-1 text-xs text-slate">{wifi === true ? (searching ? "Looking for your Vault…" : vaultName ? `${vaultName} found on this Wi-Fi` : "No Vault found yet — scan its QR code") : wifi === false ? "Connect to the same home Wi-Fi as your Vault." : "Open the HomeSafe app on your phone to check Wi-Fi."}</p></div></div>
    {offer ? <div className="space-y-6"><ShieldCheck size={30} className="text-sagedeep" /><dl className="space-y-4"><div><dt className="text-xs text-slate">Profile</dt><dd className="mt-1 break-words font-medium">{offer.profile}</dd></div><div><dt className="text-xs text-slate">Phone or tablet</dt><dd className="mt-1 break-words font-medium">{offer.phone}</dd></div></dl><PrimaryButton disabled={busy} onClick={confirm}>Confirm & continue<ArrowRight size={18} /></PrimaryButton></div> : <>
      <div className="grid grid-cols-2 gap-3"><GhostButton disabled={busy} aria-pressed={method === "code"} onClick={() => { setMethod("code"); setError(""); }} className="h-24 flex-col rounded-xl"><Keyboard size={25} />Enter code</GhostButton><GhostButton disabled={busy} aria-pressed={method === "qr"} onClick={scan} className="h-24 flex-col rounded-xl"><QrCode size={25} />Scan QR code</GhostButton></div>
      {method === "code" && <form className="mt-8 space-y-5" onSubmit={e => { e.preventDefault(); void begin(); }}><label className="block text-sm font-medium">Code shown on your Vault<input className={connectionInput + " text-center font-mono text-xl"} aria-label="Pairing code" inputMode="numeric" maxLength={6} autoComplete="one-time-code" pattern="[0-9]{6}" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))} placeholder="000000" required /></label><PrimaryButton type="submit" disabled={busy || code.length !== 6}>{busy ? <Loader2 size={18} className="animate-spin motion-reduce:animate-none" /> : <ArrowRight size={18} />}Pair with Vault</PrimaryButton></form>}
    </>}
    {error && <p role="alert" className="mt-6 text-sm leading-6 text-destructive">{error}</p>}
  </ConnectionShell>;
}