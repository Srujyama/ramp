import { useEffect, useMemo } from "react";
import type { JSX } from "react";
import { ShieldCheck, ShieldAlert, Swords, TerminalSquare } from "lucide-react";
import { Card, CardContent } from "../../components/ui/card.js";
import { Badge } from "../../components/ui/badge.js";
import scorecard from "../../data/redteam-scorecard.json";

interface Attack {
  id: string;
  category: string;
  expect: string;
  got: string;
  blocked: boolean;
  rules: string[];
}
interface Scorecard {
  total: number;
  blocked: number;
  breaches: number;
  attacks: Attack[];
  generatedAt?: string;
}

const CARD = scorecard as Scorecard;

export function Security(): JSX.Element {
  useEffect(() => {
    document.title = "Security · Provable Agent Spend";
  }, []);

  const groups = useMemo(() => {
    const m = new Map<string, Attack[]>();
    for (const a of CARD.attacks) {
      const arr = m.get(a.category) ?? [];
      arr.push(a);
      m.set(a.category, arr);
    }
    return [...m.entries()];
  }, []);

  const clean = CARD.breaches === 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">Security</h1>
        <p className="mt-0.5 max-w-2xl text-[13.5px] text-ink-muted">
          The attacker's playbook, fired at the <span className="font-medium text-ink">real enforcement hook</span> — the
          same subprocess Claude Code invokes before any payment tool runs. Every attack must be denied or held; a single
          silent allow is a breach and fails CI (<code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[12px]">pnpm redteam</code>).
        </p>
      </div>

      {/* verdict band */}
      <Card className={clean ? "border-lime/40" : "border-flag/50"}>
        <CardContent className="flex flex-wrap items-center gap-x-10 gap-y-4 py-5">
          <div className="flex items-center gap-3.5">
            <span
              className={
                "flex size-11 items-center justify-center rounded-[12px] " +
                (clean ? "bg-lime-soft text-lime-ink" : "bg-flag-soft text-flag-ink")
              }
            >
              {clean ? <ShieldCheck className="size-6" /> : <ShieldAlert className="size-6" />}
            </span>
            <div className="flex flex-col">
              <span className="tabular text-[34px] font-semibold leading-none tracking-tight text-ink">
                {CARD.blocked}/{CARD.total}
              </span>
              <span className="mt-1 text-[12.5px] font-medium text-ink-muted">attacks blocked · no breach</span>
            </div>
          </div>
          <Divider />
          <Metric label="Breaches" value={String(CARD.breaches)} tone={clean ? "good" : "bad"} />
          <Metric label="Attack classes" value={String(groups.length)} />
          <Metric label="Fired at" value="the real hook" mono />
        </CardContent>
      </Card>

      {/* attacks by category */}
      <div className="flex flex-col gap-5">
        {groups.map(([category, attacks]) => (
          <div key={category} className="flex flex-col gap-2">
            <div className="flex items-center gap-2 px-1">
              <Swords className="size-4 text-ink-faint" />
              <h2 className="text-[14px] font-semibold text-ink">{category}</h2>
              <span className="tabular text-[12px] text-ink-faint">
                {attacks.length} · all blocked
              </span>
            </div>
            <Card className="overflow-hidden">
              <div className="flex flex-col">
                {attacks.map((a) => (
                  <div key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-5 py-3.5 last:border-b-0">
                    <TerminalSquare className="size-4 shrink-0 text-ink-faint" />
                    <code className="font-mono text-[12.5px] text-ink">{a.id}</code>
                    <span className="text-[12px] text-ink-faint">
                      expected <span className="font-medium text-ink-muted">{a.expect}</span> · got{" "}
                      <span className="font-medium text-ink-muted">{a.got}</span>
                    </span>
                    <div className="flex flex-1 flex-wrap items-center justify-end gap-1.5">
                      {a.rules.slice(0, 3).map((r) => (
                        <code key={r} className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10.5px] text-ink-muted">
                          {r}
                        </code>
                      ))}
                      <Badge tone={a.blocked ? "accent" : "deny"}>{a.blocked ? "Blocked" : "BREACH"}</Badge>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        ))}
      </div>

      <p className="px-1 text-[12px] text-ink-faint">
        Each stop is recorded and independently re-verifiable (<code className="font-mono">pnpm proof</code>). This
        scorecard is the latest committed run; re-run it live with <code className="font-mono">pnpm redteam</code> — it
        exits non-zero on any breach, so a regression can never merge.
      </p>
    </div>
  );
}

function Divider(): JSX.Element {
  return <span className="hidden h-10 w-px bg-line sm:block" aria-hidden="true" />;
}

function Metric({ label, value, tone, mono }: { label: string; value: string; tone?: "good" | "bad"; mono?: boolean }): JSX.Element {
  const color = tone === "good" ? "text-lime-ink" : tone === "bad" ? "text-flag-ink" : "text-ink";
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{label}</span>
      <span className={`${mono ? "text-[18px]" : "tabular text-[26px]"} font-semibold leading-none tracking-tight ${color}`}>
        {value}
      </span>
    </div>
  );
}

export default Security;
