import type { JSX } from "react";
import { AlertTriangle } from "lucide-react";

/**
 * @ramp/dashboard — "these totals are not totals" notice
 *
 * Rendered when the shared decision window hit its cap and stopped short of the
 * full log (see lib/decisionsWindow.tsx). Every per-agent and per-vendor figure on
 * the page is then a prefix of the truth, not the truth.
 *
 * This component exists because the previous version of the window computed exactly
 * this signal and no caller ever read it. The window fetched the newest 200 rows,
 * knew perfectly well the log was longer, and every page presented its slice as
 * lifetime totals — an agent card reading "82 decisions / $11,543" for an agent the
 * ledger says did 347 and $50,492. The bug was not the bound; a browser has to stop
 * somewhere. The bug was stopping SILENTLY, which is the one thing an audit console
 * may never do about its own numbers.
 */
export function TruncationNotice({ truncated }: { truncated: boolean }): JSX.Element | null {
  if (!truncated) return null;
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-flag/25 bg-flag-soft/40 px-4 py-3">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-flag-ink" />
      <p className="text-[13px] text-ink-muted">
        <strong className="font-semibold text-ink">Showing part of the ledger.</strong> The decision log is longer than
        this console reads in one pass, so the figures below count only the most recent decisions and are lower than the
        real totals. Every decision is still in the ledger; use{" "}
        <code className="rounded bg-surface px-1 text-[12px]">pnpm --filter @ramp/ledger audit:consistency</code> for
        totals over the whole log.
      </p>
    </div>
  );
}

export default TruncationNotice;
