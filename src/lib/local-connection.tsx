import { createContext, useContext, useState, type ReactNode } from "react";
import { z } from "zod";
import { relocatedVault, vaultProblem, type DiscoveredVault, type PairingQr } from "./vault-protocol";

const identity = z.object({ email: z.string().email(), profile: z.string(), phone: z.string() });
export const offerSchema = identity.extend({ requestId: z.string(), expiresAt: z.number() });
export const sessionSchema = identity.extend({ connected: z.literal(true) });
export const catalogSchema = z.object({ backups: z.array(z.object({ name: z.string(), kind: z.enum(["Full", "Custom"]), date: z.string(), files: z.number().nonnegative(), bytes: z.number().nonnegative(), complete: z.boolean() })) });
export const pickSchema = z.object({ items: z.array(z.object({ name: z.string(), path: z.string(), bytes: z.number().nonnegative() })) });
export const startSchema = z.object({ transferId: z.string().min(1) });
export const transferSchema = z.object({ state: z.enum(["running", "waiting", "review", "complete", "failed"]), sentBytes: z.number().nonnegative(), totalBytes: z.number().nonnegative(), bytesPerSecond: z.number().nonnegative().optional(), problems: z.array(z.object({ index: z.number().int().nonnegative(), name: z.string(), reason: z.string() })).default([]), skippedCount: z.number().int().nonnegative().default(0), reason: z.string().optional(), code: z.string().optional() });
export const statusSchema = z.object({ connected: z.boolean(), driveName: z.string(), freeBytes: z.number().nonnegative().optional(), totalBytes: z.number().nonnegative().optional() });
export type DriveStatus = z.infer<typeof statusSchema>;
export const compareSchema = z.discriminatedUnion("found", [z.object({ found: z.literal(false) }), z.object({ found: z.literal(true), name: z.string(), date: z.string(), files: z.number().nonnegative(), bytes: z.number().nonnegative(), changed: z.array(z.string()), changedCount: z.number().nonnegative(), changedBytes: z.number().nonnegative(), unchangedCount: z.number().nonnegative() })]);
export type LocalSession = z.infer<typeof sessionSchema>;
export type PairOffer = z.infer<typeof offerSchema>;

// This interface is implemented only by an installed, audited native companion.
// All TLS, discovery, keys and certificates remain outside the hosted web app.
export interface NativeVault {
  network(): Promise<{ wifi: boolean; name?: string }>;
  /** Vaults announcing _homesafe._tcp with TXT v=1 (others are ignored). */
  discover(): Promise<DiscoveredVault[]>;
  /** Reads a homesafe://pair?v=1 QR code. */
  scanQR(): Promise<PairingQr>;
  begin(input: { email: string; code: string; address: string; fingerprint: string }): Promise<unknown>;
  confirm(requestId: string): Promise<unknown>;
  catalog(): Promise<unknown>;
  pick(input: { kind: "Full" | "Custom" }): Promise<unknown>;
  startBackup(input: { name: string; kind: "Full" | "Custom"; paths: string[]; basedOn?: string }): Promise<unknown>;
  compareWithLastFull(input: { paths: string[] }): Promise<unknown>;
  resolveProblems(input: { transferId: string; actions: { index: number; action: "retry" | "rename" | "skip"; name?: string }[] }): Promise<unknown>;
  cancelBackup(input: { transferId: string }): Promise<unknown>;
  vaultStatus(input?: { address: string; fingerprint: string }): Promise<unknown>;
  transferStatus(transferId: string): Promise<unknown>;
  disconnect(): Promise<void>;
  savedVault(): Promise<{ address?: string; fingerprint?: string }>;
  /** Native side refuses unless the fingerprint equals the pinned one. */
  relocate(input: { address: string; fingerprint: string }): Promise<void>;
  forget(): Promise<void>;
}
declare global { interface Window { HomeSafeNative?: NativeVault } }
export function nativeVault(): NativeVault {
  if (typeof window === "undefined" || !window.HomeSafeNative) throw new Error("Pairing needs the installed HomeSafe app and a Vault running on your computer. This web preview cannot connect to your home Wi-Fi.");
  return window.HomeSafeNative;
}

type Connection = { email: string; setEmail: (email: string) => void; session: LocalSession | null; setSession: (session: LocalSession | null) => void };
const ConnectionContext = createContext<Connection | null>(null);
export function LocalConnectionProvider({ children }: { children: ReactNode }) {
  const [email, setEmail] = useState("");
  const [session, setSession] = useState<LocalSession | null>(null);
  return <ConnectionContext.Provider value={{ email, setEmail, session, setSession }}>{children}</ConnectionContext.Provider>;
}
export function useLocalConnection() {
  const value = useContext(ConnectionContext);
  if (!value) throw new Error("Local connection is unavailable.");
  return value;
}
/** Runs a Vault call; if the saved Vault is unreachable (IP changed), finds it again by its pinned fingerprint and retries once. */
export async function withReconnect<T>(bridge: NativeVault, run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (e) {
    if ((e as { code?: string })?.code !== "unreachable") throw e;
    const saved = await bridge.savedVault().catch(() => ({} as { address?: string; fingerprint?: string }));
    if (!saved.fingerprint) throw e;
    const match = relocatedVault(await bridge.discover().catch(() => []), saved.fingerprint);
    if (!match || match.address === saved.address) throw e;
    await bridge.relocate({ address: match.address, fingerprint: match.fingerprint });
    return run();
  }
}

/** Clear message for a Vault error; phone_revoked also clears the saved pairing so the user re-pairs. */
export async function handleVaultError(error: unknown, fallback: string, onRepair: () => void): Promise<string> {
  const problem = vaultProblem(error, fallback);
  if (problem.repair) { try { await nativeVault().forget(); } catch { /* already cleared */ } onRepair(); }
  return problem.message;
}
