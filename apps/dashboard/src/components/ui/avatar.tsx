import { cn } from "../../lib/utils.js";

/**
 * Initials avatar for agents/vendors — there are no profile photos in this
 * domain, so a deterministic color keeps identity recognizable without
 * pretending to have imagery we don't. Same id always gets the same color.
 */
const PALETTE = [
  "bg-lime-soft text-lime-ink",
  "bg-amber-soft text-amber-ink",
  "bg-info-soft text-info-ink",
  "bg-flag-soft text-flag-ink",
];

function hashTone(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length] as string;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] as string).slice(0, 2).toUpperCase();
  return ((parts[0] as string)[0] ?? "") + ((parts[parts.length - 1] as string)[0] ?? "");
}

export function Avatar({
  name,
  size = 36,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold",
        hashTone(name),
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
      aria-hidden="true"
    >
      {initials(name).toUpperCase()}
    </span>
  );
}
