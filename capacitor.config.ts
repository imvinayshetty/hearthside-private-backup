import type { CapacitorConfig } from "@capacitor/cli";

// The phone app ships its own copy of the screens (no hosted server.url),
// so it works offline and backup bytes only travel phone -> home Vault.
const config: CapacitorConfig = {
  appId: "app.homesafe.mobile",
  appName: "HomeSafe",
  webDir: "mobile-web",
  android: { allowMixedContent: false },
  ios: { contentInset: "always" },
};
export default config;
