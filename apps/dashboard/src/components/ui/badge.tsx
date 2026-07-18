import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

/**
 * Status stamp. `tone` mirrors the console-wide semantic tones (see `Tone` in
 * lib/format.ts) so every chip in the app — outcome, proof, payment — draws
 * from one palette. A solid fill + bold label is the signal (each tone has a
 * distinct word, e.g. "Allowed" vs "Denied" vs "Held"), not color alone.
 */
const badgeVariants = cva(
  "inline-flex items-center rounded-[3px] px-2 py-[3px] text-[11px] font-bold uppercase tracking-[0.04em] text-white leading-none whitespace-nowrap",
  {
    variants: {
      tone: {
        accent: "bg-badge-accent",
        deny: "bg-badge-deny",
        warn: "bg-badge-warn",
        info: "bg-badge-info",
        neutral: "bg-badge-neutral",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {children}
    </span>
  );
}
