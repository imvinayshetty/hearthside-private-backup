# Phone enrollment and local Vault integration

- [ ] Separate email-only Login, Wi-Fi/code/QR pairing, and authenticated Backups screens.
- [ ] Add and test an installable LAN-only Vault pairing service in this project; installation and integration in the separate Vault project require that project's chat.

- [x] Inspect HomeSafe Vault's current implementation and backup rules.
- [x] Share and test profile, phone, dated-name and no-overwrite rules.
- [x] Approved pairing plan: Wi-Fi/QR/typed-address options, Vault email, pairing code, profile/phone destination path, truthful "Vault unavailable" state.
- [ ] Confirm profile & phone, reconnect, saved-backup filters — need the Vault's phone connection service to supply real data.
- [ ] Native discovery, QR reading, device identity, certificate pinning — require installed Android/iPhone apps.
