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
- Vault side: the separate **Homesafe Vault** project's Node.js service (protocol v1, port 7443) — the source of truth for the protocol
- Vitest + Testing Library; JUnit and XCTest signing-parity tests against `protocol/test-vectors.json`

## App workflow

1. **Login (`/`)** — enter your Vault account email only. A labeled **Demo** mode runs the full simulated flow (pairing, Face ID, MFA, live backup, snapshots, desktop vault dashboard).
2. **Pair (`/pair`)** — shows Wi-Fi status and the hint "Press Pair mobile device on the Vault to get a 2-minute code." Three ways to pair:
   - **Found on this Wi-Fi:** Vaults announcing `_homesafe._tcp` with TXT `v=1` (others ignored); tap one and type its code.
   - **Scan QR code:** `homesafe://pair?v=1&host=&port=&fp=&code=&email=` (private IPv4 host, port 1–65535, 64-hex fingerprint, 6-digit code, valid email). The QR email replaces the typed one. Anything else shows "That QR code is not from your HomeSafe Vault".
   - **Enter manually:** Vault address, fingerprint and code.
   Codes: the rotating code lasts 30 s, a minted code 120 s. After the Vault replies, confirm the profile and phone within 30 s (countdown); on expiry the screen starts over cleanly.
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
| `src/lib/vault-protocol.ts` | QR parsing, discovery filter, reconnect match, Vault error messages, manifest paging, timing |
| `protocol/test-vectors.json` | Signing vectors (identical copy of the Vault's) used by JUnit, XCTest and Vitest |
| `scripts/build-mobile.mjs` | Builds the SPA shell into `mobile-web/` for Capacitor |

## Vault side

The Vault runs from the separate **Homesafe Vault** project (Node.js service, protocol v1, port 7443) on the computer with the drive. This project no longer ships a Vault service. Phone-facing endpoints: `/v1/pair/begin`, `/v1/pair/confirm`, `/v1/device/challenge`, `/v1/backups`, `/v1/backup/start`, `/v1/backup/files` (manifest pages of 5,000 when a backup has more than 5,000 files; start then sends `files: []` plus `fileCount` and `bytes`), `/v1/backup/chunk` (≤4 MiB, SHA-256 checked), `/v1/backup/finish`.

Vault errors carry a `code` the app turns into clear messages: `code_expired`, `wrong_account`, `phone_revoked` (clears the pairing and returns to Pair), `drive_unavailable`, `name_exists`, `no_space`, `transfer_active`, `too_many_files`, `rate_limited`.

**Reconnect after IP change:** if the saved Vault is unreachable the app searches the Wi-Fi, matches the Vault by its pinned fingerprint, and updates the saved address in Keychain/Keystore (`relocate`). A different fingerprint is never accepted.

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
# Android signing parity: cd android && ./gradlew :homesafe-vault-native:testDebugUnitTest (after npx cap add android)
# iPhone signing parity: swift test --package-path native/homesafe-vault (on a Mac)
```

## Known limits

- Keep the app open during a backup; no background transfer yet.
- iPhone Full backup covers the Photos library; iCloud-only photos stop the backup with a message.
- Android Full backup covers photos and videos; use Custom for other folders.
- Restore to phone is not implemented in the Vault service.
- Not yet compiled and run on a real Android phone or iPhone.

## Changelog

1. **Initial app** — designed screens (pairing, MFA, selection, live sync) as a full local simulation with snapshot explorer, restore, desktop vault dashboard, Wi-Fi loss / drive unplugged states; generated living-room photo.
2. **Identity** — mobile app named HomeSafe ("HomeSafe (Mobile)"); host product is Homesafe Vault.
3. **Enrollment** — Vault-compatible naming/path rules with tests; truthful setup screen; simulation moved behind a Demo label.
4. **Approved pairing plan** — Wi-Fi/QR/typed address, Vault email, pairing code, profile/phone destination path.
5. **Separate screens** — Login → Pair → Backups routes; memory-only connection context; LAN pairing service (since replaced by the Vault project's Node service).
6. **New backup screen** — Full/Custom, picker, dated name, same-day suffix warning, progress/completion/failure; shown only after pairing is verified.
7. **Native mobile** — Capacitor config, `native/homesafe-vault` plugin (file access, pickers, Keychain/Keystore keys, pinned TLS upload, QR scan), Vault upload endpoints with chunk hashing and no-overwrite; `MOBILE.md` build guide.
8. **Documentation** — this README captures all workflows and changes and is kept current.

- **Pairing simplified (Nov 17 2026):** Pair screen asks only for the 6-digit code or a QR scan. Vault address and certificate pin are found automatically (Wi-Fi discovery `_homesafe._tcp` with `fp` TXT record, or the QR payload) and kept in native secure storage. Wi-Fi status now shows the real network name on Android (WifiManager + location permission) and iOS (NEHotspotNetwork + Access Wi-Fi Information entitlement). Vault service advertises itself when `zeroconf` is installed.
- **Aligned with Vault protocol v1 (Nov 18 2026):** removed the bundled Python service (`public/local-vault`); the Homesafe Vault Node service is the source of truth. New `homesafe://pair?v=1` QR format; three pairing paths (found on Wi-Fi, QR, manual); 30 s confirmation countdown; reconnect by pinned fingerprint after IP change (`savedVault`/`relocate`/`forget` in Java and Swift); Vault error codes mapped to messages with `phone_revoked` forcing re-pair; manifest paging via `/v1/backup/files` above 5,000 files; `protocol/test-vectors.json` with JUnit and XCTest signing-parity tests.
