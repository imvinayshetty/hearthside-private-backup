export type SourceId = "photos" | "contacts" | "documents";
export interface Source { id: SourceId; name: string; meta: string; gb: number; items: number }

export const SOURCES: Source[] = [
  { id: "photos", name: "Photos & Videos", meta: "14,200 files · 112.4 GB", gb: 112.4, items: 14200 },
  { id: "contacts", name: "Contacts & Calendars", meta: "840 entries · 42 MB", gb: 0.042, items: 840 },
  { id: "documents", name: "Documents", meta: "23.9 GB", gb: 23.9, items: 2310 },
];

export const FOLDERS = [
  { id: "dcim", name: "DCIM / Camera", gb: 96.1 },
  { id: "whatsapp", name: "WhatsApp Media", gb: 11.8 },
  { id: "screens", name: "Screenshots", gb: 4.5 },
  { id: "downloads", name: "Downloads", gb: 9.2 },
  { id: "docs", name: "Documents", gb: 14.7 },
];

export const DRIVE_FREE_GB = 2800;

/** Total GB selected; contacts round into the figure like the mockup's 136.4. */
export function selectedGb(enabled: Record<SourceId, boolean>): number {
  const t = SOURCES.reduce((s, x) => (enabled[x.id] ? s + x.gb : s), 0);
  return Math.round(t * 10) / 10;
}

export function selectedItems(enabled: Record<SourceId, boolean>): number {
  return SOURCES.reduce((s, x) => (enabled[x.id] ? s + x.items : s), 0);
}

export function fitsOnDrive(gb: number, freeGb = DRIVE_FREE_GB) {
  return gb > 0 && gb <= freeGb;
}

/** 6-digit vault authenticator code for a 30s window (local, deterministic). */
export function vaultCode(now = Date.now()): string {
  const w = Math.floor(now / 30000);
  let h = 2166136261 ^ w;
  for (let i = 0; i < 4; i++) h = Math.imul(h ^ (h >>> 13), 16777619);
  return String(Math.abs(h) % 1_000_000).padStart(6, "0");
}

export function fmtGb(gb: number) {
  return gb >= 1000 ? `${(gb / 1000).toFixed(2)} TB` : `${gb.toFixed(1)} GB`;
}

export function etaText(remainingGb: number, mbps: number) {
  if (mbps <= 0) return "Paused";
  const mins = Math.ceil((remainingGb * 1024) / mbps / 60);
  if (mins <= 1) return "Less than a minute remaining";
  return `About ${mins} mins remaining`;
}

export function hexHash(seed: number) {
  let s = "";
  let h = seed * 2654435761;
  for (let i = 0; i < 16; i++) { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; s += (h & 255).toString(16).padStart(2, "0"); }
  return s;
}

export const FILES = [
  ["family_holiday_2026.mp4", 412], ["IMG_4821.HEIC", 3.4], ["birthday_cake.mov", 188], ["IMG_4822.HEIC", 3.1],
  ["tax_return_2025.pdf", 1.2], ["garden_timelapse.mp4", 264], ["IMG_4830.HEIC", 2.9], ["recipes.docx", 0.4],
] as const;

export interface Snapshot { id: string; date: string; gb: number; files: number; dedupGb: number; label: string }
