import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

/**
 * Status pill. `tone` mirrors the console-wide semantic tones (see `Tone` in
 * lib/format.ts) so every chip in the app — outcome, proof, payment — draws
 * from one palette. A dot precedes the label so status is never color-only.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium leading-none whitespace-nowrap",
  {
    variants: {
      tone: {
        accent: "bg-lime-soft text-lime-ink",
        deny: "bg-flag-soft text-flag-ink",
        warn: "bg-amber-soft text-amber-ink",
        info: "bg-info-soft text-info-ink",
        neutral: "bg-surface-sunken text-ink-muted",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

const dotTone: Record<string, string> = {
  accent: "bg-lime",
  deny: "bg-flag",
  warn: "bg-amber",
  info: "bg-info",
  neutral: "bg-ink-faint",
};

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean;
}

export function Badge({ className, tone, dot = true, children, ...props }: BadgeProps) {
  const t = tone ?? "neutral";
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot ? <span className={cn("size-1.5 rounded-full", dotTone[t])} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
