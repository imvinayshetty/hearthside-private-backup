import { z } from "zod";

// Vault protocol v1 (Node Vault service, port 7443). The Vault is the source of truth.
export const PROTOCOL_VERSION = "1";
export const VAULT_PORT = 7443;
export const QR_ERROR = "That QR code is not from your HomeSafe Vault";
export const CODE_HINT = "Press Pair mobile device on the Vault to get a 2-minute code.";
/** Rotating code shown on the Vault lasts 30 s; a code minted with "Pair mobile device" lasts 120 s. */
export const ROTATING_CODE_SECONDS = 30;
export const MINTED_CODE_SECONDS = 120;
/** After /v1/pair/begin the phone must confirm within this many seconds. */
export const CONFIRM_SECONDS = 30;
/** Manifests above this many files are sent in pages via /v1/backup/files before any chunk. */
export const MANIFEST_PAGE = 5000;

export function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every(p => /^(0|[1-9]\d{0,2})$/.test(p))) return false;
  const [a, b] = parts.map(Number) as [number, number, number, number];
  if (parts.map(Number).some(n => n > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export type PairingQr = { address: string; fingerprint: string; code: string; email: string };

/** Parses homesafe://pair?v=1&host=&port=&fp=&code=&email= ; anything else throws QR_ERROR. */
export function parsePairingUri(raw: string): PairingQr {
  const fail = () => { throw new Error(QR_ERROR); };
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return fail(); }
  if (url.protocol !== "homesafe:" || (url.host !== "pair" && url.pathname.replace(/^\/+/, "") !== "pair")) return fail();
  const q = url.searchParams;
  const v = q.get("v"), host = q.get("host") ?? "", port = q.get("port") ?? "", fp = (q.get("fp") ?? "").toLowerCase(), code = q.get("code") ?? "", email = (q.get("email") ?? "").trim().toLowerCase();
  const portNum = /^\d{1,5}$/.test(port) ? Number(port) : 0;
  if (v !== PROTOCOL_VERSION || !isPrivateIPv4(host) || portNum < 1 || portNum > 65535 || !/^[a-f0-9]{64}$/.test(fp) || !/^\d{6}$/.test(code) || !z.string().email().safeParse(email).success) return fail();
  return { address: `https://${host}:${portNum}`, fingerprint: fp, code, email };
}

/** Normalizes a typed fingerprint (with or without colons) to 64 lowercase hex characters. */
export function fingerprintPin(value: string): string {
  const pin = value.replace(/[\s:]/g, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(pin)) throw new Error("Enter the 64-character fingerprint shown on your Vault.");
  return pin;
}

export const discoveredSchema = z.object({ name: z.string().optional(), v: z.string().optional(), address: z.string(), fingerprint: z.string() });
export type DiscoveredVault = { name: string; address: string; fingerprint: string };
/** Keeps only Vaults announcing TXT v=1 with a private address and a valid fingerprint. */
export function usableVaults(raw: unknown[]): DiscoveredVault[] {
  return raw.flatMap(item => {
    const r = discoveredSchema.safeParse(item);
    if (!r.success || r.data.v !== PROTOCOL_VERSION) return [];
    try {
      const url = new URL(r.data.address);
      if (url.protocol !== "https:" || !isPrivateIPv4(url.hostname)) return [];
      return [{ name: r.data.name || "HomeSafe Vault", address: url.origin, fingerprint: fingerprintPin(r.data.fingerprint) }];
    } catch { return []; }
  });
}

/** Reconnect after an IP change: only a Vault with the same pinned fingerprint qualifies. */
export function relocatedVault(found: DiscoveredVault[], pinned: string): DiscoveredVault | null {
  const pin = pinned.replace(/:/g, "").toLowerCase();
  return found.find(v => v.fingerprint === pin) ?? null;
}

export const VAULT_ERRORS = {
  code_expired: "That code has expired. Press Pair mobile device on the Vault to get a new one.",
  wrong_account: "That code belongs to a different Vault account. Check the email you entered.",
  phone_revoked: "This phone was removed from your Vault. Pair it again to continue.",
  drive_unavailable: "Your Vault's backup drive isn't connected. Plug it in and try again.",
  name_exists: "A backup with that name already exists. Add a suffix such as _2.",
  no_space: "The backup drive doesn't have enough free space for these files.",
  transfer_active: "Another backup is already running on your Vault. Wait for it to finish.",
  too_many_files: "Too many files for one backup. Choose fewer files or folders.",
  rate_limited: "Too many attempts. Wait one minute, then try again.",
} as const;
export type VaultErrorCode = keyof typeof VAULT_ERRORS;

export type VaultProblem = { code: VaultErrorCode | null; message: string; repair: boolean };
/** Maps a native/Vault error (Capacitor `code` or a known code in the message) to a clear message. */
export function vaultProblem(error: unknown, fallback = "Something went wrong talking to your Vault."): VaultProblem {
  const e = error as { code?: unknown; message?: unknown } | null;
  const raw = [typeof e?.code === "string" ? e.code : "", typeof e?.message === "string" ? e.message : typeof error === "string" ? error : ""];
  const code = (Object.keys(VAULT_ERRORS) as VaultErrorCode[]).find(k => raw.some(r => r === k || r.includes(k))) ?? null;
  if (code) return { code, message: VAULT_ERRORS[code], repair: code === "phone_revoked" };
  const message = raw[1] && !/^[a-z_]+$/.test(raw[1]) ? raw[1] : fallback;
  return { code: null, message, repair: false };
}

/** Splits a manifest into /v1/backup/files pages. At or below MANIFEST_PAGE files no paging is needed. */
export function manifestPages<T>(files: T[], size = MANIFEST_PAGE): { inline: T[]; pages: { offset: number; files: T[] }[] } {
  if (files.length <= size) return { inline: files, pages: [] };
  const pages = [];
  for (let offset = 0; offset < files.length; offset += size) pages.push({ offset, files: files.slice(offset, offset + size) });
  return { inline: [], pages };
}

/** Whole seconds left before an epoch-seconds deadline (never negative). */
export function secondsLeft(expiresAt: number, nowMs: number): number {
  return Math.max(0, Math.ceil(expiresAt - nowMs / 1000));
}
/** Confirmation deadline: the Vault's expiresAt, capped at CONFIRM_SECONDS after begin. */
export function confirmDeadline(expiresAt: number, beganMs: number): number {
  return Math.min(expiresAt, beganMs / 1000 + CONFIRM_SECONDS);
}
