import { useMemo } from "react";
import type { JSX } from "react";
import { HelpCircle, ArrowDownRight, UserCheck, Ban, Gauge } from "lucide-react";
import type { Facts, Decision } from "@ramp/shared";
import { referenceKernel } from "@ramp/gate/reference";
import { explainDecision, type Explanation } from "@ramp/gate/explain";
import { formatMoney, ruleTitle } from "../lib/format.js";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card.js";

/**
 * The kernel-confirmed counterfactual — "why was this stopped, and what would
 * clear it?" — computed the same way Rederive re-runs the decision: the REAL
 * reference kernel, probed IN YOUR BROWSER over the recorded facts. For a stopped
 * payment it probes DOWN (the largest amount that would allow / un-deny it); for an
 * allowed or held one it probes UP (how close it came to being stopped). No server
 * is asked whether this is true.
 */
export function Explain({ facts, decision }: { facts: Facts | null; decision: Decision | null }): JSX.Element | null {
  const ex = useMemo<Explanation | null>(() => {
    if (!facts || !decision) return null;
    try {
      return explainDecision(facts, decision, referenceKernel);
    } catch {
      return null;
    }
  }, [facts, decision]);

  if (!ex) return null;
  const cf = ex.counterfactual;
  const stopped = ex.outcome === "deny" || ex.outcome === "escalate";
  const money = (n: number) => formatMoney(n, "USD");

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{stopped ? "Why it was stopped, and what would clear it" : "How close it came to being stopped"}</CardTitle>
          <CardDescription>The real kernel, probed in your browser. Not asked of any server.</CardDescription>
        </div>
        <HelpCircle className="size-4 shrink-0 text-ink-faint" />
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pt-4">
        {/* headline — leads with the money */}
        <p className="text-[14px] font-medium leading-relaxed text-ink">{ex.headline}</p>

        {/* the counterfactual, as concrete lines */}
        <div className="flex flex-col gap-2">
          {cf.maxAllowAmount !== null ? (
            <Line icon={<ArrowDownRight className="size-4" />} tone="good">
              Would clear <span className="font-semibold">unattended</span> at any amount{" "}
              <span className="tabular font-semibold text-ink">&le; {money(cf.maxAllowAmount)}</span>.
            </Line>
          ) : null}
          {ex.outcome === "deny" && cf.maxNonDenyAmount !== null ? (
            <Line icon={<UserCheck className="size-4" />} tone="warn">
              A human could approve it at{" "}
              <span className="tabular font-semibold text-ink">&le; {money(cf.maxNonDenyAmount)}</span>. Below that it's
              held, not denied.
            </Line>
          ) : null}
          {cf.categoricalBlockers.length > 0 ? (
            <Line icon={<Ban className="size-4" />} tone="bad">
              No amount clears it. Categorical{" "}
              {cf.categoricalBlockers.map((r, i) => (
                <span key={r}>
                  {i > 0 ? ", " : ""}
                  <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[11px] text-ink-muted">{r}</code>
                </span>
              ))}
              .
            </Line>
          ) : null}
          {ex.nearestStop ? (
            <Line icon={<Gauge className="size-4" />} tone="warn">
              Safety margin{" "}
              <span className="tabular font-semibold text-ink">{money(ex.nearestStop.margin)}</span>. The next{" "}
              <span className="tabular font-semibold text-ink">{money(ex.nearestStop.amount)}</span> would be{" "}
              <span className="font-medium">{ex.nearestStop.outcome === "deny" ? "denied" : "held"}</span> (
              <code className="font-mono text-[11px]">{ex.nearestStop.rule}</code>).
            </Line>
          ) : null}
        </div>

        {/* per-rule fixes */}
        {ex.firedRules.length > 0 ? (
          <ul className="flex flex-col gap-2.5 border-t border-line pt-3.5">
            {ex.firedRules.map((r) => (
              <li key={r.id} className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2 text-[13px] font-medium text-ink">
                  <span className="size-1.5 rounded-full bg-flag" aria-hidden="true" />
                  {ruleTitle(r.id)}
                </span>
                <span className="pl-3.5 text-[12.5px] text-ink-muted">{r.reason}</span>
                {r.fix ? <span className="pl-3.5 text-[12.5px] text-ink-faint">Fix: {r.fix}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Line({ icon, tone, children }: { icon: JSX.Element; tone: "good" | "warn" | "bad"; children: React.ReactNode }): JSX.Element {
  const color = tone === "good" ? "text-lime-ink" : tone === "warn" ? "text-amber-ink" : "text-flag-ink";
  return (
    <div className="flex items-start gap-2.5 text-[13px] text-ink-muted">
      <span className={`mt-0.5 shrink-0 ${color}`}>{icon}</span>
      <span className="leading-relaxed">{children}</span>
    </div>
  );
}

export default Explain;
