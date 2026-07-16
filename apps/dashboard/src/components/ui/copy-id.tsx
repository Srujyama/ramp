import { useState } from "react";
import type { JSX } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../../lib/utils.js";

/** A monospace id with click-to-copy — used for decision/proof/digest ids everywhere. */
export function CopyId({ id, label, className }: { id: string; label?: string; className?: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(id).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {},
        );
      }}
      title="Copy to clipboard"
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-line bg-surface-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-muted transition-colors hover:border-line-strong hover:text-ink",
        className,
      )}
    >
      <span className="max-w-[220px] truncate">{label ?? id}</span>
      {copied ? <Check className="size-3 shrink-0 text-lime" /> : <Copy className="size-3 shrink-0 opacity-60" />}
    </button>
  );
}

export default CopyId;
