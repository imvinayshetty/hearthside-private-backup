import { createContext, useContext, useState, type ReactNode } from "react";
import { z } from "zod";

const identity = z.object({ email: z.string().email(), profile: z.string(), phone: z.string() });
export const offerSchema = identity.extend({ requestId: z.string(), expiresAt: z.number() });
export const sessionSchema = identity.extend({ connected: z.literal(true) });
export const catalogSchema = z.object({ backups: z.array(z.object({ name: z.string(), kind: z.enum(["Full", "Custom"]), date: z.string(), files: z.number().nonnegative(), bytes: z.number().nonnegative(), complete: z.boolean() })) });
export const pickSchema = z.object({ items: z.array(z.object({ name: z.string(), path: z.string(), bytes: z.number().nonnegative() })) });
export const startSchema = z.object({ transferId: z.string().min(1) });
export const transferSchema = z.object({ state: z.enum(["running", "complete", "failed"]), sentBytes: z.number().nonnegative(), totalBytes: z.number().nonnegative(), reason: z.string().optional() });
export type LocalSession = z.infer<typeof sessionSchema>;
export type PairOffer = z.infer<typeof offerSchema>;

// This interface is implemented only by an installed, audited native companion.
// All TLS, discovery, keys and certificates remain outside the hosted web app.
export interface NativeVault {
  network(): Promise<{ wifi: boolean; name?: string }>;
  discover(): Promise<{ address: string; fingerprint: string }[]>;
  scanQR(): Promise<{ address: string; fingerprint: string; code: string }>;
  begin(input: { email: string; code: string; address: string; fingerprint: string }): Promise<unknown>;
  confirm(requestId: string): Promise<unknown>;
  catalog(): Promise<unknown>;
  pick(input: { kind: "Full" | "Custom" }): Promise<unknown>;
  startBackup(input: { name: string; kind: "Full" | "Custom"; paths: string[] }): Promise<unknown>;
  transferStatus(transferId: string): Promise<unknown>;
  disconnect(): Promise<void>;
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