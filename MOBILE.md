# Building the HomeSafe Android and iPhone apps (free, on a Mac)

The phone apps contain their own copy of the screens plus native code in
`native/homesafe-vault` that:

- asks for file access (Photos/Videos for Full backup; the system file/folder picker for Custom),
- lists the chosen files and folders,
- pairs with the Vault using a device key kept in the Keychain (iPhone) or Android Keystore,
- sends files straight to the Vault on your Wi-Fi over HTTPS pinned to the Vault's certificate fingerprint.

Nothing goes through the internet or any hosted server.

## One-time setup

Install Xcode, Android Studio, Node.js LTS and CocoaPods (`sudo gem install cocoapods`).

```sh
git clone <your repo> && cd <repo>
npm install
npm run build:mobile      # builds the screens into mobile-web/
npx cap add android
npx cap add ios
npx cap sync
```

### iPhone / iPad — add to `ios/App/App/Info.plist`

```xml
<key>NSPhotoLibraryUsageDescription</key><string>Back up your photos and videos to your Vault at home.</string>
<key>NSCameraUsageDescription</key><string>Scan the pairing QR code shown by your Vault.</string>
<key>NSLocalNetworkUsageDescription</key><string>Send backups to your Vault on your home Wi-Fi.</string>
<key>UISupportsDocumentBrowser</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
```

Open with `npx cap open ios`, choose your free Personal Team under Signing & Capabilities, plug in the iPhone and press Run.

### Android

Permissions are added automatically. Open with `npx cap open android`, plug in the phone (USB debugging on) and press Run, or Build → Build APK(s).

## Every update

```sh
git pull && npm install && npm run cap:sync
```

## Limits to know

- Keep HomeSafe open during a backup (the screen stays awake); background transfers are not implemented.
- iPhone Full backup covers the Photos library. Photos stored only in iCloud are never downloaded — the backup stops with a message instead.
- Android Full backup covers photos and videos the system allows; use Custom for other folders.
- Wi-Fi discovery is not available; pair with the code or QR from the Vault console.


### Wi-Fi name and automatic Vault finding
- **iPhone/iPad:** in Xcode → Signing & Capabilities add **Access Wi-Fi Information**. Add to Info.plist:
  `NSLocationWhenInUseUsageDescription` = "Show which Wi-Fi you're on so you know you're at home." and `NSBonjourServices` = `_homesafe._tcp`.
  Note: a free Personal Team may not offer the Wi-Fi capability; the app then shows "Wi-Fi connected" without the name.
- **Android:** the plugin adds location, Wi-Fi state and multicast permissions. Android asks for location once — it is how Android protects Wi-Fi names.
- **Vault computer:** `pip install zeroconf` so phones find the Vault by themselves. Without it, pair by scanning the QR code.
