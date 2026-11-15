import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Mail } from "lucide-react";
import { vaultEmail } from "@/lib/backup-rules";
import { useLocalConnection } from "@/lib/local-connection";
import { GhostButton, PrimaryButton } from "./ui";
import { ConnectionShell, connectionInput } from "./ConnectionShell";

export function Enrollment({ onDemo }: { onDemo: () => void }) {
  const connection = useLocalConnection();
  const [email, setEmail] = useState(connection.email);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  return <ConnectionShell title="Login" step={1}>
    <p className="mt-3 text-sm leading-6 text-slate">Use the email registered on your Vault.</p>
    <form className="mt-10 space-y-6" onSubmit={e => { e.preventDefault(); try { connection.setEmail(vaultEmail(email)); connection.setSession(null); void navigate({ to: "/pair" }); } catch (err) { setError(err instanceof Error ? err.message : "Check your email."); } }}>
      <label className="block text-sm font-medium">Email address<div className="relative"><input type="email" aria-label="Email address" autoComplete="email" autoCapitalize="none" maxLength={254} required className={connectionInput + " pr-12"} placeholder="you@example.com" value={email} onChange={e => { setEmail(e.target.value); setError(""); }} /><Mail size={19} className="absolute right-4 top-6 text-slate" /></div></label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <PrimaryButton type="submit">Continue<ArrowRight size={18} /></PrimaryButton>
    </form>
    <GhostButton onClick={onDemo} className="mt-8 h-10 border-none bg-transparent text-sm text-slate">Open demo</GhostButton>
  </ConnectionShell>;
}
