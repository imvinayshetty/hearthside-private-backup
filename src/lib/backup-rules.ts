// Shared naming rules from HomeSafe Vault (snapshot 78a55767).
export const ROOT_FOLDER = "HomeSafeBckup";
export type BackupKind = "Full" | "Custom";

export function safeSegment(value: string): string {
  const name = value.trim();
  if (!name || name.length > 80 || /[\\/<>:"|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name) || name === "." || name === ".." || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) {
    throw new Error("Use a name of 1–80 characters without slashes, reserved names or trailing dots.");
  }
  return name;
}
export function dateCode(date: Date): string {
  return [date.getDate(), date.getMonth() + 1, date.getFullYear() % 100].map(n => String(n).padStart(2, "0")).join("");
}
export function defaultBackupName(kind: BackupKind, date: Date): string { return `${kind}_Bckup_${dateCode(date)}`; }
export function validateBackupName(name: string, kind: BackupKind, date: Date): string {
  const clean = safeSegment(name);
  const base = defaultBackupName(kind, date);
  if (clean !== base && !clean.startsWith(`${base}_`)) throw new Error(`Keep ${base} at the start; add a unique suffix to rename this backup.`);
  return clean;
}
export function requireAvailableBackup(name: string, kind: BackupKind, date: Date, entries: { name: string; date: string }[]): string {
  const clean = validateBackupName(name, kind, date);
  if (entries.some(e => e.name.toLowerCase() === clean.toLowerCase())) throw new Error("That backup already exists. Existing files will not be overwritten.");
  if (entries.some(e => e.date === dateCode(date)) && clean === defaultBackupName(kind, date)) throw new Error("A backup already exists for today. Add a unique suffix before continuing.");
  return clean;
}

// Accept only literal private IPv4 addresses; no public hosts, redirects or DNS.
export function localVaultAddress(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Enter a local HTTPS address, such as https://192.168.1.108:7443."); }
  const parts = url.hostname.split(".");
  const bytes = parts.map(Number);
  const valid = parts.length === 4 && parts.every(p => /^(0|[1-9]\d{0,2})$/.test(p)) && bytes.every(b => b >= 0 && b <= 255);
  const [a, b] = bytes;
  const privateIp = a === 10 || (a === 172 && b !== undefined && b >= 16 && b <= 31) || (a === 192 && b === 168);
  if (!valid || !privateIp || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use an HTTPS address on your private home network, without a path or login details.");
  }
  return url.origin;
}
// Approved hierarchy: HomeSafeBckup / <profile> / <phone> / <Kind>_Bckup_DDMMYY
export function backupPath(profile: string, phone: string, backup: string): string {
  return [ROOT_FOLDER, safeSegment(profile), safeSegment(phone), safeSegment(backup)].join("/");
}
// Phone names are unique per profile (case-insensitive); a duplicate never creates a second folder.
export function requireNewPhoneName(name: string, existing: string[]): string {
  const clean = safeSegment(name);
  if (existing.some(n => n.toLowerCase() === clean.toLowerCase())) throw new Error("That phone name is already used in this profile. Choose a different name on your Vault.");
  return clean;
}
// Local email is an account identifier only; Vault confirms registration.
export function vaultEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter the email address you registered on your Vault.");
  return email;
}
export function pairingCode(value: string): string {
  const code = value.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) throw new Error("Enter the six-digit pairing code shown on your Vault.");
  return code;
}
