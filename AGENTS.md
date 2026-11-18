<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

## What Lovable manages

Rules outside this block are the project's own. Change the pieces below in
Lovable, not by hand. With the [Lovable MCP](https://mcp.lovable.dev)
connected, `send_message` asks Lovable to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask Lovable to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI gateway.** Keep model calls on Lovable's gateway, and keep
  `LOVABLE_API_KEY` out of browser code.
- **Connectors.** Lovable provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `LOVABLE_API_KEY`. When Lovable does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** Lovable manages them. Do not put secret values in the repo.
<!-- LOVABLE:END -->

<!-- AGENT-MEMORY:BEGIN -->
- Keep Vault-compatible path and naming validation in `src/lib/backup-rules.ts` with concrete tests so mobile setup follows the companion's storage rules.
- Separate real enrollment readiness from the simulated phone flow; never treat draft setup, browser identity or demo MFA as verified native phone enrollment.
- Connect backup data only through a native local transport after identity and certificate verification; the hosted app must never proxy backup bytes or claim an unavailable Vault protocol exists.
- The separate Homesafe Vault Node service (protocol v1, port 7443) is the protocol source of truth; this project ships no Vault service. Protocol rules live in `src/lib/vault-protocol.ts`, and `protocol/test-vectors.json` must stay identical to the Vault's copy so JUnit/XCTest signing parity holds.
- Keep Login, pairing and Backups as separate content routes sharing memory-only connection context; native secure storage owns device credentials, not browser storage.
- Native file access, device keys, pinned TLS and Vault upload live in the local Capacitor plugin `native/homesafe-vault` (Swift + Java), exposed to screens only via `src/lib/native-bridge.ts`; the web code must keep working with no native APIs.
- Mobile builds use `scripts/build-mobile.mjs` (CAPACITOR_BUILD SPA shell into `mobile-web/`) so phones bundle the screens instead of loading the hosted site.
- Update README.md (workflows, key code, limits, changelog) with every change so it stays the living project record.
<!-- AGENT-MEMORY:END -->
