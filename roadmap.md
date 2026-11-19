# Phone enrollment and local Vault integration

- [x] Separate email-only Login, Wi-Fi/code/QR pairing, and authenticated Backups screens.
- [x] Remove the bundled Python service; the Homesafe Vault Node service (protocol v1) is the source of truth.
- [x] Align with Vault protocol v1: QR URI, three pairing paths, 30 s confirm countdown, reconnect by fingerprint, error codes, manifest paging, signing test vectors.
- [ ] Confirm `protocol/test-vectors.json` is byte-identical to the Vault's copy and that the Vault sends error `code` fields and accepts `/v1/backup/files` — needs the Vault project.

- [x] Inspect HomeSafe Vault's current implementation and backup rules.
- [x] Share and test profile, phone, dated-name and no-overwrite rules.
- [x] Approved pairing plan: Wi-Fi/QR/typed-address options, Vault email, pairing code, profile/phone destination path, truthful "Vault unavailable" state.
- [ ] Verify profile/phone confirmation, returning-device access and saved-backup filters on a real phone — screens and signed service endpoints exist; installed native transport is missing.
- [ ] Run JUnit/XCTest parity tests and verify discovery, QR, pinning on devices — require the user's Mac.
- [x] Native Android/iOS file access, file/folder picking and pinned-TLS transfer to the Vault; Vault upload endpoints with tests and a real TLS round trip.
- [ ] Compile and run on a real Android phone and iPhone — requires the user's Mac (see MOBILE.md).
