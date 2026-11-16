// Builds a static single-page copy of the screens for the Android/iPhone app.
import { execSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, rmSync, statSync, copyFileSync } from "node:fs";
import { join } from "node:path";

execSync("npx vite build", { stdio: "inherit", env: { ...process.env, CAPACITOR_BUILD: "1" } });
const candidates = ["dist/client", ".output/public", "dist"];
const find = (dir) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (f === "_shell.html" || f === "index.html") return dir; if (statSync(p).isDirectory() && !f.startsWith("server")) { const r = find(p); if (r) return r; } } };
const root = candidates.filter(existsSync).map(find).find(Boolean);
if (!root) throw new Error("No app shell found in the build output.");
rmSync("mobile-web", { recursive: true, force: true });
cpSync(root, "mobile-web", { recursive: true });
if (existsSync("mobile-web/_shell.html")) copyFileSync("mobile-web/_shell.html", "mobile-web/index.html");
console.log(`Mobile web assets copied from ${root} to mobile-web/`);
