import { Shield, Lock, ArrowLeft } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Display } from "./ui";

export const connectionInput = "mt-2 h-14 w-full rounded-xl border border-ink/15 bg-card px-4 text-ink outline-none focus:border-sage";

export function ConnectionShell({ title, step, back, children }: { title: string; step: number; back?: "/" | "/pair"; children: ReactNode }) {
  return <div className="flex min-h-svh flex-col bg-ground text-ink">
    <header className="border-b border-ink/10 px-6 py-5"><div className="mx-auto flex max-w-5xl items-center gap-2 text-lg font-semibold"><Shield size={23} className="text-sagedeep" />HomeSafe<span className="ml-auto flex items-center gap-1.5 text-xs font-normal text-sagedeep"><Lock size={13} />Zero cloud</span></div></header>
    <main className="mx-auto w-full max-w-md flex-1 px-6 pb-12 pt-12 sm:pt-20">
      <div className="mb-10 flex items-center justify-between">{back ? <Link to={back} aria-label="Go back" className="text-slate"><ArrowLeft size={22} /></Link> : <Shield className="text-sage" size={26} />}<ol aria-label="Connection progress" className="flex gap-2">{[1, 2, 3].map(n => <li key={n} aria-current={n === step ? "step" : undefined} className={n <= step ? "h-1.5 w-8 rounded-full bg-sage" : "h-1.5 w-8 rounded-full bg-ink/10"}><span className="sr-only">{["Login", "Pair", "Backups"][n - 1]}</span></li>)}</ol></div>
      <Display>{title}</Display>{children}
    </main>
    <footer className="px-6 pb-6 text-center text-xs text-slate">Your files stay at home.</footer>
  </div>;
}