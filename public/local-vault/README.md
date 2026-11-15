# HomeSafe local Vault pairing service

This service runs on the computer with the external drive, never on Lovable hosting. It is an independently installable companion, not a modification of the separate HomeSafe Vault web project. Python 3.11+ required. Keep the computer firewall restricted to your home LAN; never forward port 7443.

## Install and run

Download service.py and requirements.txt from `/local-vault/` on this app. Use a private virtual environment:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python service.py --drive /media/your-drive --host 192.168.1.108
```

On Windows use `.venv\Scripts\python.exe`; use your computer's actual private IPv4 and drive path. State is in `~/.homesafe-vault`, separate from backups. Protect it with OS permissions (including Windows ACLs), full-disk encryption and a trusted computer login. Python POSIX mode bits alone do not enforce Windows ACLs. Keep it off shared storage. Certificates and enrollment keys are local; never upload them. Do not deploy this script to a hosted web server.

Only the person signed into the trusted local computer can authorize enrollment using the console. This is NOT integration with the existing browser Vault account database or Authy login. Do not call email entry authentication or verified email ownership. That integration must be built from the Vault project's chat before replacing its account flow.

```text
register you@example.com Your profile
pair you@example.com Blue Pixel
```

The console displays a six-digit code (valid for 120 seconds), address, fingerprint and QR payload. A native app must independently compare the fingerprint against the trusted Vault display before any code or identity leaves the phone. Code/QR possession alone is not server authentication. This release supplies the QR payload, not a QR renderer or mDNS discovery. Revoke with `revoke DEVICE_ID` (available in the native device's enrollment record). Certificate changes require explicit re-pairing; never silently trust a new certificate.

## Protocol version 1

TLS 1.3. Native clients only: no CORS, no cloud proxy, no redirects. Native private keys must be non-exportable and stored in Keychain/Android Keystore; the service accepts Ed25519 public keys in base64. The public key is bound only after the two signed enrollment steps. The native client retains identity/key, pinned certificate and account destination for returning-device access. There are no bearer tokens.

Sign UTF-8 JSON with sorted keys, no whitespace, no ASCII escaping. All native transport calls must check a literal RFC1918 IPv4, the Vault certificate SHA-256 fingerprint, SAN and expiry before transmitting, and reject redirects.

- `POST /v1/pair/begin`: email, code, deviceId (16–128 ASCII letters/digits/underscore/hyphen), publicKey, signature over those four fields. Returns requestId, challenge, expiresAt, email, profile, phone. Verify email and confirm the destination with the user.
- `POST /v1/pair/confirm`: requestId, signature over `{requestId, challenge, profile, phone}` from the offer. Returns `{connected:true,email,profile,phone}`. Confirmation has at most 60 seconds, consumes the request and creates a new phone directory without overwriting anything.
- `POST /v1/device/challenge`: deviceId. Returns a one-use challenge valid for 30 seconds. Only active enrolled identities qualify.
- `POST /v1/backups`: deviceId, challenge, signature over `{deviceId,challenge,action:"catalog"}`. Lists only `HomeSafeBckup/profile/phone` for that identity. Revocation is checked every time. Recognizes dated Full/Custom folders with `manifest.json` containing nonnegative integer files/bytes and boolean complete. This reader does not alter existing Vault data.

Failed pairing is limited to five attempts per peer before a 60-second lockout and five per ticket; no public account lookup. Codes are stored as salted hashes, claimed once; replay/expired confirmations and mismatched signatures are rejected. Requests are limited to 8 KiB. State transactions are serialized. Use trusted home networks; this lightweight service is not hardened against high-volume LAN denial-of-service.

## Mobile boundary and remaining work

The web app's `window.HomeSafeNative` adapter contract expects network, discover, scanQR, begin, confirm, catalog, disconnect. Native `begin` must manage the signed wire exchange; native `confirm` must sign the returned challenge and persist secure enrollment. No implementation is installed in this browser preview. The adapter is a boundary, not a security attestation; security depends on the audited native implementation and trusted app origin.

Android/iOS packaging, native secure keys, certificate pinning, real Wi-Fi discovery, QR decoding, and existing Vault login integration remain required. This service implements pairing and catalog reads, NOT file upload/restore or phone-file permissions. Do not claim a real phone backup until an actual file is written and read back. No test here proves physical device enrollment.
