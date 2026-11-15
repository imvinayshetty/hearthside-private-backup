import type { ReactNode, ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Pill({ children, tone = "sage", className }: { children: ReactNode; tone?: "sage" | "warn" | "card"; className?: string }) {
  return (
    <div className={cn("inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[12.5px] font-medium",
      tone === "sage" && "bg-sagesoft text-sagedeep", tone === "warn" && "bg-warnsoft text-warn",
      tone === "card" && "bg-card text-sagedeep shadow-[0_6px_18px_-10px_rgba(47,54,51,0.25)]", className)}>{children}</div>
  );
}

export function PrimaryButton({ className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...p} className={cn("flex h-14 w-full items-center justify-center gap-2 rounded-full bg-ink text-[16px] font-medium text-primary-foreground shadow-[0_10px_24px_-10px_rgba(47,54,51,0.5)] transition-colors hover:bg-sagedeep disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-ink", className)}>{children}</button>
  );
}

export function GhostButton({ className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...p} className={cn("flex h-14 w-full items-center justify-center gap-2 rounded-full border border-ink/10 bg-card text-[16px] font-medium text-ink transition-colors hover:bg-sagesoft disabled:opacity-45", className)}>{children}</button>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-[24px] bg-card p-5 shadow-[0_12px_32px_-16px_rgba(47,54,51,0.18)]", className)}>{children}</div>;
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={cn("relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50", on ? "bg-sage" : "bg-ink/15")}>
      <span className={cn("absolute top-1 h-5 w-5 rounded-full bg-card shadow transition-all", on ? "left-6" : "left-1")} />
    </button>
  );
}

export function Display({ children, className }: { children: ReactNode; className?: string }) {
  return <h1 className={cn("font-display text-[34px] leading-[40px] tracking-tight text-ink font-normal", className)}>{children}</h1>;
}
