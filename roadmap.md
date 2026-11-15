# Phone enrollment and local Vault integration

- [x] Separate email-only Login, Wi-Fi/code/QR pairing, and authenticated Backups screens.
- [x] Add and test an installable LAN-only Vault pairing service in this project, including real TLS requests and authorized catalog readback.
- [ ] Install the local service and integrate existing Vault login — requires the user's Vault computer and changes from the separate Vault project's chat.

- [x] Inspect HomeSafe Vault's current implementation and backup rules.
- [x] Share and test profile, phone, dated-name and no-overwrite rules.
- [x] Approved pairing plan: Wi-Fi/QR/typed-address options, Vault email, pairing code, profile/phone destination path, truthful "Vault unavailable" state.
- [ ] Verify profile/phone confirmation, returning-device access and saved-backup filters on a real phone — screens and signed service endpoints exist; installed native transport is missing.
- [ ] Native discovery, QR reading, device identity, certificate pinning — require installed Android/iPhone apps.
