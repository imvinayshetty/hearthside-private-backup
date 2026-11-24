import { useEffect, useRef, useState } from "react";
import { nativeVault, statusSchema, type DriveStatus } from "@/lib/local-connection";

export type Route = "staged" | "direct";
export interface RouteState { /** The Vault saves to an external drive, so the owner chooses how. */ external: boolean; route: Route | null; /** Start is allowed (not external, direct, or fast with room ready). */ ready: boolean }

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

/** What the owner sees for the fast option, from the Vault's answer. */
export function stagingAdvice(staging: DriveStatus["staging"]): { state: "checking" | "unavailable" | "needs-folder" | "ready"; text: string } {
  if (!staging) return { state: "checking", text: "Checking your computer…" };
  if (!staging.available) return { state: "unavailable", text: "Saving to the computer first is not available for this drive, so the backup will go straight to the drive." };
  if (!staging.ready) return { state: "needs-folder", text: `Your computer needs ${gb(staging.needBytes ?? 0)} free to receive this backup first (its size plus 2 GB)${staging.freeBytes !== undefined ? `, and has ${gb(staging.freeBytes)}` : ""}. Open HomeSafe Vault on your computer and choose a HomeSafeTemp folder on a drive with enough room. Waiting…` };
  return { state: "ready", text: "Ready. Your phone is free as soon as the files reach your computer; the computer saves them to the drive in the background." };
}

/** Before a backup to an external drive: fast (phone to computer first, drive in the background) or direct to the drive. */
export function SaveRoute({ needed, onChange }: { needed: number; onChange: (s: RouteState) => void }) {
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const external = status?.external === true;
  const advice = stagingAdvice(status?.staging);

  async function check(ask: boolean) {
    try { setStatus(statusSchema.parse(await nativeVault().vaultStatus({ bytes: needed, ask }))); } catch { setStatus(s => s ?? { connected: true, driveName: "", external: false }); }
  }
  useEffect(() => { void check(route === "staged" && advice.state === "needs-folder"); }, [needed]); // eslint-disable-line react-hooks/exhaustive-deps
  // After the fast option is chosen: ask once, then keep checking until the owner has chosen a folder on the computer.
  useEffect(() => {
    if (poll.current) { clearInterval(poll.current); poll.current = null; }
    if (route !== "staged") return;
    void check(true);
    poll.current = setInterval(() => void check(false), 3000);
    return () => { if (poll.current) clearInterval(poll.current); };
  }, [route]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (route === "staged" && advice.state === "unavailable") setRoute("direct"); }, [route, advice.state]);
  useEffect(() => { onChange({ external, route, ready: !external || route === "direct" || (route === "staged" && advice.state === "ready") }); }, [external, route, advice.state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (poll.current) clearInterval(poll.current); }, []);

  if (!external) return null;
  const card = (id: Route, title: string, body: string) => (
    <button type="button" aria-pressed={route === id} onClick={() => setRoute(id)} className={`w-full rounded-xl border p-3 text-left text-sm ${route === id ? "border-sagedeep bg-sage/10" : "border-ink/10"}`}>
      <span className="block font-medium">{title}</span><span className="mt-1 block text-slate">{body}</span>
    </button>
  );
  return <fieldset className="mt-4 space-y-2">
    <legend className="mb-1 text-sm font-medium">Your backup drive is external. How should this backup be saved?</legend>
    {card("staged", "Fast: phone to computer first", "Your phone sends to your computer at Wi-Fi speed and is free sooner. The computer then saves the files to the drive in the background.")}
    {card("direct", "Direct to the drive", "Saves straight to the external drive. It depends on your Wi-Fi and the drive's cable speed, and your phone stays busy until it finishes.")}
    {route === "staged" && <p role="status" className="text-xs leading-5 text-slate">{advice.text}</p>}
  </fieldset>;
}
