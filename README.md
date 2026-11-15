# HomeSafe

Create new project and name the project HomeSafe and continue with the task: an app that connects to home WiFi using MFA and performs customized backup of mobile (Android or iOS) into a hard drive connected to the same app on the same WiFi, with zero data leaving the local network.

Locked:
- Product identity: HomeSafe — Local-first, zero-cloud private backup system for home networks.
- Visual direction: Calm Privacy-first look.
  - Palette: Muted sage green accents, warm slate neutrals, crisp white/soft off-white backgrounds, reassuring green status indicators.
  - Typography: Clean sans-serif typography, highly legible numbers and metrics, generous whitespace and card paddings.
  - Shapes & controls: Rounded corners (12-16px radius), soft borders, high-affordance buttons, subtle shadows.
  - Design spec rules:
    - Layout: Apply generous whitespace, open card paddings, rounded corners, and simple, high-affordance controls.
    - Type-and-color: Use a calm, minimal palette with muted sage green accents, warm slate neutrals, and clean sans-serif typography.
    - Content: Display clear offline indicators highlighting that all traffic is strictly local and zero-cloud.
- Designed screens and flow sequence (device: mobile, phone 393×764):
  1. Screen 1: LAN Discovery & Pairing (pairing-screen)
     - App opens here on launch.
     - Header: "HomeSafe", local connection indicator ("Local WiFi Only • Encrypted").
     - Content: Scans for local backup host daemon on LAN. Shows discovered daemon "HomeSafe Vault (192.168.1.142)", storage capacity ("2.4 TB free on WD Elements 4TB"), and "Pair with Vault" action with pinned certificate fingerprint preview.
  2. Screen 2: Local MFA Verification (mfa-screen)
     - Secure authorization step before backup or settings access.
     - Biometric authentication prompt (Face ID / Fingerprint simulation) and local TOTP/pin verification card ("Enter 6-digit vault authenticator code").
     - Reassurance badge: "Keys verified on-device. No cloud relay."
  3. Screen 3: Backup Customization (selection-screen)
     - Granular backup source selection with storage calculation and toggles:
       - Photos & Videos (e.g. 42.8 GB, 3,420 items)
       - Documents & Downloads (e.g. 4.1 GB, 280 files)
       - App Data & Contacts (e.g. 1.2 GB, 1,140 contacts)
     - Target drive status: "Mounted: WD My Passport (3.2 TB free)".
     - Deduplication & encryption toggles (BLAKE3 chunking, FastCDC, local AES-GCM-256 client encryption).
     - Primary button: "Start Backup".
  4. Screen 4: Live Sync & Status (sync-status-screen)
     - Live transfer progress bar with speed ("48.5 MB/s LAN"), transferred bytes ("12.4 GB / 48.1 GB"), remaining time.
     - Deduplication efficiency indicator ("6.2 GB deduplicated / saved").
     - Current chunk hash and file being transferred.
     - Controls: Pause / Resume, Cancel, and View Transfer Logs.
     - Completed state summary and snapshot history log.

Open:
- Responsive layout across desktop (1280×832), tablet, and mobile (393×764). On desktop/tablet, show a split-pane vault dashboard with host daemon management, drive health, snapshot explorer, and connected device manager alongside mobile backup controls.
- Full local interactive simulation:
  - Discovered daemons, pairing handshake, certificate pinning simulation.
  - Interactive MFA verification (PIN entry / Biometric trigger).
  - Configurable backup sets with item count and size calculations.
  - Live animated backup simulation with realistic speed metrics, deduplication counters, chunk hashing displays, and snapshot history commit.
  - Snapshot explorer allowing browsing previous local snapshots and initiating local file restore flows.
  - Zero-cloud indicators and local network status banner always visible.
- Accessibility, keyboard navigation, crisp empty states, and error handling for disconnected drives or WiFi loss.

build a real working app, not a clickable prototype; the screen and kit files show layout, content and look (a wireframe's, structure only) and are never code to copy. The screens are the moments the user designed, not the whole product. Before building, walk through each flow as its user would and design what the pictures leave out, as a product designer would for this product: the steps a flow needs to finish and how the app responds to what the user does, including the moments its users will actually run into, like waiting on something or finding nothing yet. Add nothing a user of this product would never meet, and keep an app the user wants simple, simple. Never leave a step the product's core flows need as "coming soon", unless the brief says the user chose to. Where such a step needs an outside service, build every part up to it and say in your reply what's left to connect. Fill product gaps only, never a look the design set: an added step reuses the UI kit's tokens, chrome and parts and the nearest designed screen's layout, with no new visual direction. Look at every screen's picture before writing code; design.md says which picture or sheet holds each screen. Open the UI kit's shells and parts HTML for the header, tab bar, composer and components, not only its tokens. Use each finished screen's copy exactly as design.md lists it; never invent copy for one. A wireframe under design.md's Wireframes gives structure only: build it in the design's look, as design.md says. The screens' photos are placeholders for the mockups only: replace every photo design.md lists with the user's own upload for it, else as design.md says (a photo without people re-composed with imagegen--edit_image from it as a reference, a photo of people generated from its brief and never from the photo), and ship no set photo or its URL. For a design that came with no design.md, every photo on assets.lovable.dev or images.unsplash.com is a set photo: replace it with the user's own upload for it, else a new image generated for its slot, any person in it one who doesn't exist, never from the photo or a picture showing it. Build and check each screen at the canvas it was drawn at: phone 393×764, tablet landscape 1133×744, tablet portrait 744×1133, desktop 1280×832. After building, screenshot the app at those sizes and states, compare each finished screen with its picture, and fix every visual difference you didn't choose; check a wireframe's screen against its structure, never its grey look. End your reply with "Changed from the mockups": each deliberate change and why, and "Added beyond the mockups": each step, state or interaction you built that no screen shows.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/fca0802a-c29e-44e2-9c74-0c2c2159d5ba).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
