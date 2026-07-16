import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

/** Compositor-only shimmer (background-position, not layout-affecting props). */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-surface-sunken motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}
