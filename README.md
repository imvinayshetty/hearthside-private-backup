# HomeSafe (Mobile)

Local-first, zero-cloud private backup of Android and iPhone/iPad devices to an external hard drive on your home Wi-Fi. The companion host product is **Homesafe Vault** (a separate project). Nothing ever leaves your local network.

> This README is the living record of the project. It is updated with every change.

## Privacy boundary

- Phones talk only to a Vault on a private IPv4 address (`10.x`, `172.16–31.x`, `192.168.x`) over HTTPS on port `7443`.
- The Vault's TLS certificate SHA-256 fingerprint is checked by the user and pinned on the phone.
- Device keys (Ed25519) live in the iOS Keychain / Android Keystore — never in browser storage.
- The hosted web app never proxies backup bytes; no cloud relay, no telemetry of files.

## Tech stack

- React 19, TanStack Start v1 / TanStack Router (file routes in `src/routes`), Vite, TypeScript
- Tailwind CSS v4 (OKLCH tokens in `src/styles.css`, sage/slate palette, Fraunces + Inter), Radix UI, lucide icons, sonner
- Capacitor mobile shell + local native plugin `native/homesafe-vault` (Swift + Java)
- Python 3.11+ LAN Vault service in `public/local-vault` (`cryptography`)
- Vitest + Testing Library; Python `unittest` for the Vault service

## App workflow

1. **Login (`/`)** — enter your Vault account email only. A labeled **Demo** mode runs the full simulated flow (pairing, Face ID, MFA, live backup, snapshots, desktop vault dashboard).
2. **Pair (`/pair`)** — shows Wi-Fi status and two options: **Enter code** or **Scan QR code**. Enter the Vault address (`https://<private-ip>:7443`) and fingerprint, confirm the fingerprint matches the Vault's screen, enter the 6-digit pairing code (valid 120 s, 5 attempts then lockout), then confirm the profile and phone name the Vault assigned.
3. **Backups (`/backups`)** — only after the Vault sends `pairing_verified`:
   - **New backup:** Full backup (all files the phone allows) or Custom folders; file/folder picker; name prefilled `Full_Bckup_DDMMYY` / `Custom_Bckup_DDMMYY`; warning when today's backup exists, requiring a suffix like `_2`; **Start backup** reports progress, completion or failure with a reason.
   - **Saved backups:** catalog filtered by type and date.

Backups are stored at `HomeSafeBckup/<profile>/<phone>/<Full|Custom>_Bckup_DDMMYY[_suffix]`. Existing backups are never overwritten; phone names are unique per profile. Rules live in `src/lib/backup-rules.ts`.

## Key code

| Path | Purpose |
| --- | --- |
| `src/routes/index.tsx`, `pair.tsx`, `backups.tsx` | Login, pairing, backups screens |
| `src/components/homesafe/` | Shell, New backup, Enrollment, demo simulation (`HomeSafe.tsx`), UI parts |
| `src/lib/local-connection.tsx` | Memory-only session context and `window.HomeSafeNative` contract |
| `src/lib/native-bridge.ts` | Bridge to the Capacitor plugin; web works without native APIs |
| `src/lib/backup-rules.ts` | Vault-compatible names, paths, address and code validation |
| `src/lib/vault.ts` | Demo simulation data and helpers |
| `native/homesafe-vault` | iOS/Android file access, pickers, device keys, pinned TLS, upload |
| `public/local-vault` | Python LAN Vault service, tests and protocol docs |
| `scripts/build-mobile.mjs` | Builds the SPA shell into `mobile-web/` for Capacitor |

## Local Vault service

Runs on the computer with the drive (never on hosting):

```sh
cd public/local-vault
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python service.py --drive /media/your-drive --host 192.168.1.108
```

Console: `register EMAIL PROFILE`, `pair EMAIL PHONE` (shows code, fingerprint, QR payload), `revoke DEVICE_ID`. Protocol v1 (TLS 1.3, ECDSA P-256 cert): `/v1/pair/begin`, `/v1/pair/confirm`, `/v1/device/challenge`, `/v1/backups`, `/v1/backup/start`, `/v1/backup/chunk` (≤4 MiB, SHA-256 checked), `/v1/backup/finish`. Full details: `public/local-vault/README.md`. If you ran an older version, delete `vault.pem` and `vault-key.pem` and re-pair.

## Building the phone apps (free, on a Mac)

```sh
npm install
npm run build:mobile
npx cap add ios && npx cap add android
npx cap sync
npx cap open ios      # or: npx cap open android
```

Info.plist entries and signing steps: see `MOBILE.md`. After each update: `git pull && npm install && npm run cap:sync`.

## Development and tests

```sh
npm i
npm run dev
bunx vitest run
python3 -m unittest public/local-vault/test_service.py
```

## Known limits

- Keep the app open during a backup; no background transfer yet.
- iPhone Full backup covers the Photos library; iCloud-only photos stop the backup with a message.
- Android Full backup covers photos and videos; use Custom for other folders.
- No Wi-Fi (mDNS) discovery yet — pair with the code or QR.
- Restore to phone is not implemented in the Vault service.
- Integration with the existing Homesafe Vault account login is pending (Vault project).
- Not yet compiled and run on a real Android phone or iPhone.

## Changelog

1. **Initial app** — designed screens (pairing, MFA, selection, live sync) as a full local simulation with snapshot explorer, restore, desktop vault dashboard, Wi-Fi loss / drive unplugged states; generated living-room photo.
2. **Identity** — mobile app named HomeSafe ("HomeSafe (Mobile)"); host product is Homesafe Vault.
3. **Enrollment** — Vault-compatible naming/path rules with tests; truthful setup screen; simulation moved behind a Demo label.
4. **Approved pairing plan** — Wi-Fi/QR/typed address, Vault email, pairing code, profile/phone destination path.
5. **Separate screens** — Login → Pair → Backups routes; memory-only connection context; installable Python LAN pairing service with security tests and real TLS round trip.
6. **New backup screen** — Full/Custom, picker, dated name, same-day suffix warning, progress/completion/failure; shown only after pairing is verified.
7. **Native mobile** — Capacitor config, `native/homesafe-vault` plugin (file access, pickers, Keychain/Keystore keys, pinned TLS upload, QR scan), Vault upload endpoints with chunk hashing and no-overwrite; `MOBILE.md` build guide.
8. **Documentation** — this README captures all workflows and changes and is kept current.
