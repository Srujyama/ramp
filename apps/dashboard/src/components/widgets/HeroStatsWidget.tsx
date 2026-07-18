import { useMemo } from "react";
import type { JSX } from "react";
import { ShieldCheck } from "lucide-react";
import { Card, CardContent } from "../ui/card.js";
import { formatMoney } from "../../lib/format.js";
import type { DecisionView } from "../../lib/types.js";

/**
 * The hero stat band — the pitch numbers, oversized and tabular, in the Ramp
 * "one confident number per tile" idiom. Everything is derived from the same
 * decision window the rest of the dashboard reads (no extra endpoint): money
 * that cleared, money the gate STOPPED (deny + held), how many decisions were
 * judged, and how many carry an intact, independently-recomputable proof.
 */
export function HeroStatsWidget({ decisions }: { decisions: readonly DecisionView[] }): JSX.Element {
  const s = useMemo(() => {
    let allowed = 0,
      stopped = 0,
      verified = 0,
      tampered = 0;
    for (const d of decisions) {
      if (d.status === "error") continue;
      if (d.outcome === "allow") allowed += d.amount;
      else if (d.outcome === "deny" || d.outcome === "escalate") stopped += d.amount;
      const r = d.proofVerification.reason;
      if (r === "ok") verified++;
      else if (r === "mismatch" || r === "corrupt") tampered++;
    }
    return { allowed, stopped, judged: decisions.length, verified, tampered };
  }, [decisions]);

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Stat
        overline="Money stopped"
        value={formatMoney(s.stopped, "USD")}
        sub="denied + held for review"
        dot="var(--flag)"
      />
      <Stat
        overline="Money allowed"
        value={formatMoney(s.allowed, "USD")}
        sub="cleared through the gate"
        dot="var(--lime)"
      />
      <Stat overline="Decisions judged" value={s.judged.toLocaleString()} sub="every one recorded" />
      <Stat
        overline="Proofs verified"
        value={s.verified.toLocaleString()}
        sub={s.tampered === 0 ? "0 tampered · chain intact" : `${s.tampered} tampered — flagged`}
        badge={s.tampered === 0}
      />
    </div>
  );
}

function Stat({
  overline,
  value,
  sub,
  dot,
  badge,
}: {
  overline: string;
  value: string;
  sub: string;
  dot?: string;
  badge?: boolean;
}): JSX.Element {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1.5">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
          {dot ? <span className="size-1.5 rounded-full" style={{ backgroundColor: dot }} aria-hidden="true" /> : null}
          {overline}
        </span>
        <span className="tabular text-[30px] font-semibold leading-none tracking-tight text-ink">{value}</span>
        <span className="flex items-center gap-1 text-[12px] text-ink-muted">
          {badge ? <ShieldCheck className="size-3.5 text-lime" /> : null}
          {sub}
        </span>
      </CardContent>
    </Card>
  );
}

export default HeroStatsWidget;
