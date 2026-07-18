import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { fetchDecisions, BRIDGE_URL } from "../../lib/bridge.js";
import type { DecisionOutcome, DecisionStatus, DecisionsQuery, DecisionView, RuleId } from "../../lib/types.js";
import {
  RULE_META,
  explainDecision,
  formatMoney,
  formatRelative,
  formatTimestamp,
  outcomeChip,
  paymentChip,
  ruleBlurb,
  ruleTitle,
  verificationChip,
} from "../../lib/format.js";
import { agentLabel, vendorLabel } from "../../lib/identity.js";
import { BridgeErrorState, StateCard } from "../../components/ui/state-card.js";
import { StatusChip } from "../../components/StatusChip.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { cn } from "../../lib/utils.js";

const PAGE_SIZE = 25;
const RULE_IDS: RuleId[] = Object.keys(RULE_META) as RuleId[];
const ALL = "__all__";

interface Filters {
  outcome: DecisionOutcome | "";
  status: DecisionStatus | "";
  agentId: string;
  firedRule: RuleId | "";
}

function filtersFromParams(params: URLSearchParams): Filters {
  return {
    outcome: (params.get("outcome") as DecisionOutcome | null) ?? "",
    status: (params.get("status") as DecisionStatus | null) ?? "",
    agentId: params.get("agentId") ?? "",
    firedRule: (params.get("firedRule") as RuleId | null) ?? "",
  };
}

function toQuery(f: Filters): DecisionsQuery {
  const q: DecisionsQuery = { limit: PAGE_SIZE };
  if (f.outcome !== "") q.outcome = f.outcome;
  if (f.status !== "") q.status = f.status;
  const agent = f.agentId.trim();
  if (agent !== "") q.agentId = agent;
  if (f.firedRule !== "") q.firedRule = f.firedRule;
  return q;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** Does a live-streamed decision belong in the current filtered view? */
function matchesFilters(v: DecisionView, f: Filters): boolean {
  if (f.outcome !== "" && v.outcome !== f.outcome) return false;
  if (f.status !== "" && v.status !== f.status) return false;
  if (f.agentId.trim() !== "" && v.agentId !== f.agentId.trim()) return false;
  if (f.firedRule !== "" && !v.firedRules.includes(f.firedRule)) return false;
  return true;
}

function isDecisionView(v: unknown): v is DecisionView {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return typeof d.decisionId === "string" && typeof d.status === "string" && Array.isArray(d.firedRules);
}

export function Activity(): JSX.Element {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filters = filtersFromParams(params);

  const [rows, setRows] = useState<DecisionView[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const loadMoreCtrl = useRef<AbortController | null>(null);

  const anyFilter = filters.outcome !== "" || filters.status !== "" || filters.agentId.trim() !== "" || filters.firedRule !== "";

  // Kept in refs so the single long-lived SSE subscription always sees the CURRENT
  // filters and row ids without re-subscribing on every keystroke/render.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const idsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    idsRef.current = new Set(rows.map((r) => r.decisionId));
  }, [rows]);
  const [liveCount, setLiveCount] = useState(0);

  useEffect(() => {
    document.title = "Activity · Provable Agent Spend";
  }, []);

  // Live tail: prepend new decisions (that match the active filters) as the gate
  // records them, via the bridge's read-only SSE stream. A new row slides in at the
  // top without a manual reload; the "live" pill counts how many arrived.
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    try {
      es = new EventSource(`${BRIDGE_URL}/events`);
    } catch {
      return;
    }
    const onDecision = (ev: Event): void => {
      try {
        const data: unknown = JSON.parse((ev as MessageEvent).data);
        if (!isDecisionView(data)) return;
        if (idsRef.current.has(data.decisionId)) return;
        if (!matchesFilters(data, filtersRef.current)) return;
        idsRef.current.add(data.decisionId);
        setRows((prev) => [data, ...prev]);
        setLiveCount((n) => n + 1);
      } catch {
        /* ignore a malformed frame */
      }
    };
    es.addEventListener("decision", onDecision);
    return () => es?.close();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);

    fetchDecisions(toQuery(filters), ctrl.signal)
      .then((res) => {
        if (cancelled) return;
        setRows(res.decisions);
        setCursor(res.nextCursor);
      })
      .catch((err: unknown) => {
        if (cancelled || isAbort(err)) return;
        setError(err);
        setRows([]);
        setCursor(undefined);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      ctrl.abort();
      loadMoreCtrl.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.outcome, filters.status, filters.agentId, filters.firedRule, reloadKey]);

  function setFilter(patch: Partial<Filters>): void {
    const next = { ...filters, ...patch };
    const p = new URLSearchParams();
    if (next.outcome) p.set("outcome", next.outcome);
    if (next.status) p.set("status", next.status);
    if (next.agentId.trim()) p.set("agentId", next.agentId.trim());
    if (next.firedRule) p.set("firedRule", next.firedRule);
    setParams(p, { replace: true });
  }

  function loadMore(): void {
    if (cursor === undefined || loadingMore) return;
    const ctrl = new AbortController();
    loadMoreCtrl.current = ctrl;
    setLoadingMore(true);
    fetchDecisions({ ...toQuery(filters), cursor }, ctrl.signal)
      .then((res) => {
        setRows((prev) => [...prev, ...res.decisions]);
        setCursor(res.nextCursor);
      })
      .catch((err: unknown) => {
        if (isAbort(err)) return;
        setError(err);
      })
      .finally(() => {
        if (loadMoreCtrl.current === ctrl) loadMoreCtrl.current = null;
        setLoadingMore(false);
      });
  }

  const now = new Date();

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">Activity</h1>
        <p className="text-[13.5px] text-ink-muted">
          Every evaluated spend request: outcome, independent proof verification, and payment. Newest first.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-3">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-ink-faint">Outcome</label>
          <Select value={filters.outcome || ALL} onValueChange={(v) => setFilter({ outcome: v === ALL ? "" : (v as DecisionOutcome) })}>
            <SelectTrigger className="h-8 w-36 text-[12.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All</SelectItem>
              <SelectItem value="allow">Allowed</SelectItem>
              <SelectItem value="deny">Denied</SelectItem>
              <SelectItem value="escalate">Needs approval</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-ink-faint">Status</label>
          <Select value={filters.status || ALL} onValueChange={(v) => setFilter({ status: v === ALL ? "" : (v as DecisionStatus) })}>
            <SelectTrigger className="h-8 w-36 text-[12.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All</SelectItem>
              <SelectItem value="allowed">Allowed</SelectItem>
              <SelectItem value="denied">Denied</SelectItem>
              <SelectItem value="escalated">Escalated</SelectItem>
              <SelectItem value="error">Error</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-ink-faint">Agent</label>
          <Input
            value={filters.agentId}
            onChange={(e) => setFilter({ agentId: e.target.value })}
            placeholder="agentId"
            className="h-8 w-36 text-[12.5px]"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-ink-faint">Fired rule</label>
          <Select value={filters.firedRule || ALL} onValueChange={(v) => setFilter({ firedRule: v === ALL ? "" : (v as RuleId) })}>
            <SelectTrigger className="h-8 w-52 text-[12.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All</SelectItem>
              {RULE_IDS.map((id) => (
                <SelectItem key={id} value={id}>
                  {ruleTitle(id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {anyFilter ? (
          <Button variant="ghost" size="sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            Clear
          </Button>
        ) : null}
      </div>

      {loading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : error !== null ? (
        <BridgeErrorState error={error} onRetry={() => setReloadKey((k) => k + 1)} />
      ) : rows.length === 0 ? (
        <StateCard icon="activity" title="No decisions yet">
          Trigger a payment through the MCP <code>pay_vendor</code> tool. Decisions stream in here with full
          provenance.
        </StateCard>
      ) : (
        <>
          {/* Stacked cards below md — a wide data table with horizontal scroll is
              unreadable at phone widths (row heights look broken with columns
              scrolled out of view), so this collapses to one card per decision. */}
          <ul className="flex flex-col gap-2 md:hidden">
            {rows.map((v) => (
              <li key={v.decisionId}>
                <button
                  type="button"
                  onClick={() => navigate(`/app/activity/${encodeURIComponent(v.decisionId)}`)}
                  className={cn(
                    "w-full rounded-xl border border-line bg-surface p-4 text-left transition-colors hover:bg-surface-hover",
                    v.corrupt && "bg-flag-soft/40",
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[13.5px] font-medium text-ink">
                      {agentLabel(v.agentId)} <span className="text-ink-faint">→</span> {vendorLabel(v.vendorId)}
                    </span>
                    <span className="tabular shrink-0 text-[13.5px] font-semibold text-ink">
                      {formatMoney(v.amount, v.request?.currency ?? "USD")}
                    </span>
                  </div>
                  <div className="mt-1 text-[11.5px] text-ink-faint" title={formatTimestamp(v.ts)}>
                    {formatRelative(v.ts, now)}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {v.corrupt ? <span className="text-[11px] font-semibold text-flag">⚠ Corrupt</span> : null}
                    <StatusChip chip={outcomeChip(v)} />
                    <StatusChip chip={verificationChip(v.proofVerification.reason)} />
                    <StatusChip chip={paymentChip(v)} />
                  </div>
                  <p className="mt-2 text-[12px] leading-snug text-ink-faint">{explainDecision(v)}</p>
                </button>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-hidden rounded-xl border border-line bg-surface md:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                    <th className="px-4 py-2.5 font-medium">Time</th>
                    <th className="px-4 py-2.5 font-medium">Agent</th>
                    <th className="px-4 py-2.5 font-medium">Vendor</th>
                    <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                    <th className="px-4 py-2.5 font-medium">Outcome</th>
                    <th className="px-4 py-2.5 font-medium">Proof</th>
                    <th className="px-4 py-2.5 font-medium">Payment</th>
                    <th className="px-4 py-2.5 font-medium">Explanation</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((v) => (
                    <tr
                      key={v.decisionId}
                      onClick={() => navigate(`/app/activity/${encodeURIComponent(v.decisionId)}`)}
                      className={cn(
                        "cursor-pointer border-b border-line align-top last:border-0 hover:bg-surface-hover",
                        v.corrupt && "bg-flag-soft/40",
                      )}
                    >
                      <td className="whitespace-nowrap px-4 py-3 text-ink-faint" title={formatTimestamp(v.ts)}>
                        {formatRelative(v.ts, now)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-medium text-ink">{agentLabel(v.agentId)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-ink-muted">{vendorLabel(v.vendorId)}</td>
                      <td className="tabular whitespace-nowrap px-4 py-3 text-right font-medium text-ink">
                        {formatMoney(v.amount, v.request?.currency ?? "USD")}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1">
                          {v.corrupt ? <span className="text-[11px] font-semibold text-flag">⚠ Corrupt</span> : null}
                          <StatusChip chip={outcomeChip(v)} />
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <StatusChip chip={verificationChip(v.proofVerification.reason)} />
                      </td>
                      <td className="px-4 py-3">
                        <StatusChip chip={paymentChip(v)} />
                      </td>
                      <td className="max-w-[320px] px-4 py-3">
                        <p className="text-[12px] leading-snug text-ink-faint">{explainDecision(v)}</p>
                        {v.firedRules.length > 0 ? (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {v.firedRules.map((r) => (
                              <span
                                key={r}
                                title={ruleBlurb(r)}
                                className="rounded bg-surface-sunken px-1.5 py-0.5 text-[10.5px] text-ink-muted"
                              >
                                {ruleTitle(r)}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-[12.5px] text-ink-faint">
              {rows.length} decision{rows.length === 1 ? "" : "s"}
              {liveCount > 0 ? (
                <span className="inline-flex items-center gap-1.5 text-chart-allow">
                  <span className="size-1.5 animate-pulse rounded-full bg-chart-allow" aria-hidden="true" />
                  {liveCount} streamed in live
                </span>
              ) : null}
            </span>
            {cursor !== undefined ? (
              <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

export default Activity;
