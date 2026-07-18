import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { Radio, Zap, Pause, Play, ShieldCheck, Ban, Clock, TrendingUp } from "lucide-react";
import { useDecisionsWindow } from "../../lib/decisionsWindow.js";
import type { DecisionView } from "../../lib/types.js";
import { formatMoney, formatRelative, outcomeChip, paymentChip } from "../../lib/format.js";
import { agentLabel, vendorLabel } from "../../lib/identity.js";
import { StatusChip } from "../../components/StatusChip.js";
import { Card, CardContent } from "../../components/ui/card.js";
import { Button } from "../../components/ui/button.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { postTransaction, ControlPlaneError, CONTROL_PLANE_URL, type TxIntent } from "../../lib/controlPlane.js";
import { cn } from "../../lib/utils.js";

/** How many rows the firehose keeps on screen. */
const FEED_CAP = 48;

/* ---------------------------------------------------------------------------
 * Live traffic generator — fires REAL gated transactions (not fake rows).
 * Each intent is a genuine requestPurchase through the kernel; the outcome falls
 * out of policy and streams back over SSE. We only pick the INTENT; the gate
 * decides. Intents are drawn to give a realistic, colorful mix of verdicts.
 * ------------------------------------------------------------------------- */

/** Cleared categories per demo agent — matches the seeded clearances (Policy tab). */
const AGENTS: { id: string; cleared: string[] }[] = [
  { id: "agent_47", cleared: ["office_supplies", "software"] },
  { id: "agent_12", cleared: ["office_supplies"] },
  { id: "agent_23", cleared: ["office_supplies", "software", "travel"] },
  { id: "agent_08", cleared: ["software"] },
];
const VERIFIED = ["acme_corp", "globex_inc", "initech"];
const UNVERIFIED = ["sketchy_llc", "unknown_labs"];
const ALL_CATEGORIES = ["office_supplies", "software", "travel"];

function pick<T>(xs: readonly T[]): T {
  return xs[Math.floor(Math.random() * xs.length)]!;
}
function randInt(lo: number, hi: number): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** Build one intent, weighted toward allows with a healthy spread of denies/holds. */
function nextIntent(): TxIntent {
  const agent = pick(AGENTS);
  const roll = Math.random();
  // ~55% allow, ~15% escalate, ~30% deny (split across four deny causes)
  if (roll < 0.55) {
    return { agent: agent.id, vendor: pick(VERIFIED), amount: randInt(40, 320), category: pick(agent.cleared), attest: true };
  }
  if (roll < 0.7) {
    // over the escalation threshold ($400) but under the cap ($500) -> HELD
    return { agent: agent.id, vendor: pick(VERIFIED), amount: randInt(420, 490), category: pick(agent.cleared), attest: true };
  }
  const cause = Math.random();
  if (cause < 0.3) {
    // over the per-transaction cap ($500) -> DENY
    return { agent: agent.id, vendor: pick(VERIFIED), amount: randInt(540, 880), category: pick(agent.cleared), attest: true };
  }
  if (cause < 0.6) {
    // unverified vendor -> DENY
    return { agent: agent.id, vendor: pick(UNVERIFIED), amount: randInt(60, 300), category: pick(agent.cleared), attest: true };
  }
  if (cause < 0.8) {
    // missing attestation -> DENY
    return { agent: agent.id, vendor: pick(VERIFIED), amount: randInt(60, 300), category: pick(agent.cleared), attest: false };
  }
  // category the agent is not cleared for -> DENY
  const uncleared = ALL_CATEGORIES.filter((c) => !agent.cleared.includes(c));
  return {
    agent: agent.id,
    vendor: pick(VERIFIED),
    amount: randInt(60, 300),
    category: uncleared.length ? pick(uncleared) : "crypto",
    attest: true,
  };
}

/* ------------------------------------------------------------------------- */

interface LiveStats {
  total: number;
  allowed: number;
  held: number;
  denied: number;
  stopped: number; // money that did NOT move (deny + held)
  perMin: number; // decisions in the last 60s
}

function computeStats(decisions: readonly DecisionView[], now: number): LiveStats {
  let allowed = 0,
    held = 0,
    denied = 0,
    stopped = 0,
    perMin = 0;
  for (const d of decisions) {
    if (d.status === "error") continue;
    if (d.outcome === "allow") allowed++;
    else if (d.outcome === "escalate") {
      held++;
      stopped += d.amount;
    } else if (d.outcome === "deny") {
      denied++;
      stopped += d.amount;
    }
    const t = Date.parse(d.ts.includes("T") ? d.ts : d.ts.replace(" ", "T") + "Z");
    if (Number.isFinite(t) && now - t <= 60_000) perMin++;
  }
  return { total: decisions.length, allowed, held, denied, stopped, perMin };
}

const FLASH: Record<string, string> = {
  allow: "var(--lime-soft)",
  escalate: "var(--amber-soft)",
  deny: "var(--flag-soft)",
};

function stripeClass(v: DecisionView): string {
  if (v.status === "error") return "bg-amber";
  if (v.outcome === "allow") return "bg-chart-allow";
  if (v.outcome === "escalate") return "bg-amber";
  return "bg-chart-deny";
}

export function Live(): JSX.Element {
  const win = useDecisionsWindow();
  const navigate = useNavigate();
  const [streaming, setStreaming] = useState(false);
  const [inFlight, setInFlight] = useState(0);
  const [cpError, setCpError] = useState<string | null>(null);
  const [, forceTick] = useState(0);

  // Track which decision ids we've already shown, so only genuinely NEW ones flash.
  const seenRef = useRef<Set<string>>(new Set());
  const primedRef = useRef(false);

  useEffect(() => {
    document.title = "Live · Provable Agent Spend";
  }, []);

  // Re-tick every 5s so "x/min" and relative times stay honest without new events.
  useEffect(() => {
    const iv = setInterval(() => forceTick((n) => n + 1), 5_000);
    return () => clearInterval(iv);
  }, []);

  const decisions = win.status === "success" ? win.data.decisions : [];
  const visible = decisions.slice(0, FEED_CAP);
  const stats = useMemo(() => computeStats(decisions, Date.now()), [decisions]);

  // Mark the first render's ids as "seen" so the initial batch doesn't all flash.
  useEffect(() => {
    if (!primedRef.current && win.status === "success") {
      for (const d of decisions) seenRef.current.add(d.decisionId);
      primedRef.current = true;
    }
  }, [win.status, decisions]);

  function isFresh(id: string): boolean {
    if (!primedRef.current) return false;
    if (seenRef.current.has(id)) return false;
    seenRef.current.add(id);
    return true;
  }

  // The traffic generator: fire one real intent on an interval while streaming.
  useEffect(() => {
    if (!streaming) return;
    let cancelled = false;
    const fire = async () => {
      setInFlight((n) => n + 1);
      try {
        await postTransaction(nextIntent());
        if (!cancelled) setCpError(null);
      } catch (e) {
        if (!cancelled) {
          setCpError(
            e instanceof ControlPlaneError && e.kind === "unavailable"
              ? `Control plane offline — start it with \`pnpm control-plane\` (${CONTROL_PLANE_URL}).`
              : (e as Error).message,
          );
          setStreaming(false);
        }
      } finally {
        if (!cancelled) setInFlight((n) => Math.max(0, n - 1));
      }
    };
    void fire();
    const iv = setInterval(fire, 1250);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [streaming]);

  return (
    <div className="flex flex-col gap-6">
      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">Live</h1>
            <LiveBadge live={win.live} />
          </div>
          <p className="mt-0.5 text-[13.5px] text-ink-muted">
            Every decision the gate makes, the instant it makes it — streamed off the read-only bridge. Newest on top.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {streaming ? (
            <span className="flex items-center gap-1.5 text-[12px] text-ink-faint">
              <span className="size-1.5 rounded-full bg-chart-allow live-dot" />
              firing real transactions{inFlight > 0 ? "…" : ""}
            </span>
          ) : null}
          <Button variant={streaming ? "secondary" : "primary"} onClick={() => setStreaming((s) => !s)}>
            {streaming ? <Pause className="size-4" /> : <Play className="size-4" />}
            {streaming ? "Pause traffic" : "Generate live traffic"}
          </Button>
        </div>
      </div>

      {cpError ? (
        <Card>
          <CardContent className="flex items-center gap-2.5 py-3 text-[13px] text-ink-muted">
            <Ban className="size-4 shrink-0 text-flag" />
            {cpError}
          </CardContent>
        </Card>
      ) : null}

      {/* live stat tiles */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile icon={<TrendingUp className="size-4" />} label="Decisions / min" value={String(stats.perMin)} tone="ink" />
        <StatTile icon={<ShieldCheck className="size-4" />} label="Allowed" value={String(stats.allowed)} tone="allow" />
        <StatTile icon={<Clock className="size-4" />} label="Held for a human" value={String(stats.held)} tone="held" />
        <StatTile icon={<Ban className="size-4" />} label="Denied" value={String(stats.denied)} tone="deny" />
        <StatTile icon={<Zap className="size-4" />} label="Unprovable spend stopped" value={formatMoney(stats.stopped, "USD")} tone="stopped" />
      </div>

      {/* the firehose */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <span className="flex items-center gap-2 text-[12px] font-medium uppercase tracking-wide text-ink-faint">
            <Radio className="size-3.5" /> decision stream
          </span>
          <span className="text-[12px] text-ink-faint">{stats.total} in window</span>
        </div>

        {win.status === "loading" ? (
          <div className="flex flex-col gap-px">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-16" />
                <Skeleton className="ml-auto h-4 w-24" />
              </div>
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-surface-sunken">
              <Radio className="size-5 text-ink-faint live-dot" />
            </span>
            <p className="text-[14px] font-medium text-ink">Waiting for the next decision…</p>
            <p className="max-w-sm text-[13px] text-ink-muted">
              Hit <span className="font-medium text-ink">Generate live traffic</span> to fire real gated transactions, or
              trigger one from the Simulate tab — either way you'll watch it land here the instant the kernel decides.
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {visible.map((d) => (
              <FeedRow key={d.decisionId} d={d} fresh={isFresh(d.decisionId)} onClick={() => navigate(`/app/activity/${encodeURIComponent(d.decisionId)}`)} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function LiveBadge({ live }: { live: boolean }): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide",
        live ? "bg-lime-soft text-lime-ink" : "bg-surface-sunken text-ink-faint",
      )}
      title={live ? "Connected to the live SSE decision stream." : "Not streaming — falling back to polling."}
    >
      <span className={cn("size-1.5 rounded-full", live ? "bg-chart-allow live-dot" : "bg-ink-faint")} />
      {live ? "Live" : "Polling"}
    </span>
  );
}

const TONE: Record<string, string> = {
  ink: "text-ink",
  allow: "text-lime-ink",
  held: "text-amber-ink",
  deny: "text-flag-ink",
  stopped: "text-ink",
};

function StatTile({ icon, label, value, tone }: { icon: JSX.Element; label: string; value: string; tone: keyof typeof TONE }): JSX.Element {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-3.5">
        <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink-faint">
          <span className={TONE[tone]}>{icon}</span>
          {label}
        </span>
        <span className={cn("tabular-nums text-[24px] font-semibold tracking-tight", TONE[tone])}>{value}</span>
      </CardContent>
    </Card>
  );
}

function FeedRow({ d, fresh, onClick }: { d: DecisionView; fresh: boolean; onClick: () => void }): JSX.Element {
  const oc = outcomeChip(d);
  const pc = paymentChip(d);
  const rule = d.firedRules[0];
  return (
    <button
      type="button"
      onClick={onClick}
      style={fresh ? ({ ["--flash" as string]: FLASH[d.outcome ?? "allow"] ?? "var(--lime-soft)" } as React.CSSProperties) : undefined}
      className={cn(
        "group grid w-full grid-cols-[3px_1fr_auto] items-center gap-x-4 border-b border-line px-4 py-3 text-left transition-colors hover:bg-surface-hover",
        fresh ? "stream-row-fresh" : "stream-row",
      )}
    >
      <span className={cn("h-full min-h-[34px] rounded-full", stripeClass(d))} aria-hidden="true" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 truncate text-[13.5px]">
          <span className="font-medium text-ink">{agentLabel(d.agentId)}</span>
          <span className="text-ink-faint">&rarr;</span>
          <span className="text-ink-muted">{vendorLabel(d.vendorId)}</span>
          <span className="tabular-nums font-semibold text-ink">{formatMoney(d.amount, d.request?.currency ?? "USD")}</span>
        </span>
        <span className="flex items-center gap-2 truncate text-[11.5px] text-ink-faint">
          {rule ? <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10.5px] text-ink-muted">{rule}</code> : null}
          <span className="truncate">{d.category.replace(/_/g, " ")}</span>
        </span>
      </span>
      <span className="flex items-center gap-2">
        <StatusChip chip={pc} />
        <StatusChip chip={oc} />
        <span className="w-14 shrink-0 text-right tabular-nums text-[11.5px] text-ink-faint">{formatRelative(d.ts, new Date())}</span>
      </span>
    </button>
  );
}

export default Live;
