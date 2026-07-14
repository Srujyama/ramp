import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Link, useNavigate } from "react-router-dom";
import { fetchDecisions } from "../lib/bridge.js";
import type {
  DecisionOutcome,
  DecisionStatus,
  DecisionsQuery,
  DecisionView,
  RuleId,
} from "../lib/types.js";
import {
  RULE_META,
  formatMoney,
  formatRelative,
  formatTimestamp,
  outcomeChip,
  paymentChip,
  ruleBlurb,
  ruleTitle,
  verificationChip,
} from "../lib/format.js";
import { BridgeErrorState, Chip, Skeleton, StateCard } from "../components/ui.js";

/**
 * @ramp/dashboard — Decisions
 *
 * The full audit table: every evaluated spend request the read-only ledger
 * bridge serves, newest first. Each row shows the policy outcome, the
 * independent proof verification, and the sandbox payment — all derived from the
 * append-only trail, nothing fabricated. Filters narrow the query server-side;
 * "Load more" pages via the bridge cursor. Clicking a row opens its provenance.
 */

const PAGE_SIZE = 25;

/** Controlled-filter shape. `""` is the "All" sentinel for each select. */
interface Filters {
  outcome: DecisionOutcome | "";
  status: DecisionStatus | "";
  agentId: string;
  firedRule: RuleId | "";
}

const EMPTY_FILTERS: Filters = {
  outcome: "",
  status: "",
  agentId: "",
  firedRule: "",
};

const RULE_IDS: RuleId[] = Object.keys(RULE_META) as RuleId[];

/** Collapse the controlled sentinels into a real bridge query. */
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

export function Decisions(): JSX.Element {
  const navigate = useNavigate();

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [rows, setRows] = useState<DecisionView[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const loadMoreCtrl = useRef<AbortController | null>(null);

  const anyFilter =
    filters.outcome !== "" ||
    filters.status !== "" ||
    filters.agentId.trim() !== "" ||
    filters.firedRule !== "";

  useEffect(() => {
    document.title = "Decisions · Provable Agent Spend";
  }, []);

  // First page: (re)fetch whenever a filter changes or a retry is requested.
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

  function refetch(): void {
    setReloadKey((k) => k + 1);
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
    <div>
      <div className="page-head">
        <h2>Decisions</h2>
        <p>
          Every evaluated spend request — its policy outcome, independent proof
          verification, and sandbox payment. Newest first.
        </p>
      </div>

      <div className="filter-bar">
        <div className="field">
          <label htmlFor="f-outcome">Outcome</label>
          <select
            id="f-outcome"
            className="select"
            value={filters.outcome}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                outcome: e.target.value as DecisionOutcome | "",
              }))
            }
          >
            <option value="">All</option>
            <option value="allow">Allowed</option>
            <option value="deny">Denied</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="f-status">Status</label>
          <select
            id="f-status"
            className="select"
            value={filters.status}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                status: e.target.value as DecisionStatus | "",
              }))
            }
          >
            <option value="">All</option>
            <option value="allowed">allowed</option>
            <option value="denied">denied</option>
            <option value="error">error</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="f-agent">Agent</label>
          <input
            id="f-agent"
            className="text-input"
            type="text"
            placeholder="agentId"
            value={filters.agentId}
            onChange={(e) =>
              setFilters((f) => ({ ...f, agentId: e.target.value }))
            }
          />
        </div>

        <div className="field">
          <label htmlFor="f-rule">Fired rule</label>
          <select
            id="f-rule"
            className="select"
            value={filters.firedRule}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                firedRule: e.target.value as RuleId | "",
              }))
            }
          >
            <option value="">All</option>
            {RULE_IDS.map((id) => (
              <option key={id} value={id}>
                {ruleTitle(id)}
              </option>
            ))}
          </select>
        </div>

        {anyFilter ? (
          <button
            type="button"
            className="btn ghost"
            onClick={() => setFilters(EMPTY_FILTERS)}
          >
            Clear
          </button>
        ) : null}
      </div>

      {loading ? (
        <div className="table-wrap">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="sk-row" />
          ))}
        </div>
      ) : error !== null ? (
        <BridgeErrorState error={error} onRetry={refetch} />
      ) : rows.length === 0 ? (
        <StateCard icon="⚖" title="No decisions yet">
          Trigger a payment through the MCP <code>pay_vendor</code> tool — the
          gate evaluates it and decisions stream in here with full provenance.
        </StateCard>
      ) : (
        <>
          <div className="table-wrap">
            <table className="dtable">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Agent</th>
                  <th>Vendor</th>
                  <th>Amount</th>
                  <th>Outcome</th>
                  <th>Proof</th>
                  <th>Payment</th>
                  <th>Rules</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => {
                  const to = `/decisions/${encodeURIComponent(v.decisionId)}`;
                  return (
                    <tr
                      key={v.decisionId}
                      className={v.corrupt ? "corrupt-row" : undefined}
                      style={{ cursor: "pointer" }}
                      onClick={() => navigate(to)}
                    >
                      <td data-label="Time" title={formatTimestamp(v.ts)}>
                        {formatRelative(v.ts, now)}
                      </td>
                      <td data-label="Agent" className="mono-cell">
                        {v.agentId}
                      </td>
                      <td data-label="Vendor">
                        <Link
                          to={to}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {v.vendorId}
                        </Link>
                      </td>
                      <td data-label="Amount" className="num">
                        {formatMoney(v.amount, v.request?.currency ?? "USD")}
                      </td>
                      <td data-label="Outcome">
                        {v.corrupt ? (
                          <span className="corrupt-flag">⚠ Corrupt record</span>
                        ) : null}
                        <Chip chip={outcomeChip(v)} />
                      </td>
                      <td data-label="Proof">
                        <Chip chip={verificationChip(v.proofVerification.reason)} />
                      </td>
                      <td data-label="Payment">
                        <Chip chip={paymentChip(v)} />
                      </td>
                      <td data-label="Rules">
                        {v.firedRules.length > 0 ? (
                          <div className="cell-rules">
                            {v.firedRules.map((r) => (
                              <span
                                key={r}
                                className="rule-tag"
                                title={ruleBlurb(r)}
                              >
                                {ruleTitle(r)}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="list-foot">
            <span>
              {rows.length} decision{rows.length === 1 ? "" : "s"}
            </span>
            {cursor !== undefined ? (
              <button
                type="button"
                className="btn primary"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

export default Decisions;
