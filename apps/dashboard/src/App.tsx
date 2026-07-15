import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import type { RuleId } from "@ramp/shared";
import Sidebar from "./components/Sidebar.js";
import StatTile from "./components/StatTile.js";
import ProofView from "./components/ProofView.js";

/**
 * @ramp/dashboard — App
 *
 * Layout frame + routing ONLY. Every panel is an honest Phase-0 placeholder:
 * the shell renders real structure with "no data yet" empty states, never
 * fabricated decisions. Live data will arrive from the ledger + audit trail
 * in a later phase; the gate itself is the hook, not this UI.
 */

const RULE_CATALOG: readonly { id: RuleId; blurb: string }[] = [
  { id: "allow/all_conditions_met", blurb: "Every condition held — proven allow." },
  { id: "deny/vendor_not_verified", blurb: "Vendor absent/unverified in registry." },
  { id: "deny/over_per_txn_cap", blurb: "Amount exceeds the per-transaction cap." },
  {
    id: "deny/agent_uncleared_for_category",
    blurb: "Agent not cleared to spend in this category.",
  },
  { id: "deny/category_not_approved", blurb: "Category is not on the approved list." },
  {
    id: "deny/daily_limit_exceeded",
    blurb: "This spend would push the daily total over the limit.",
  },
  {
    id: "deny/attestation_invalid",
    blurb: "No verified attestation binds this invoice to the vendor's registered domain.",
  },
];

function useDocTitle(section: string): void {
  const loc = useLocation();
  useEffect(() => {
    document.title = `${section} · Provable Agent Spend`;
  }, [section, loc.pathname]);
}

function Header({ crumb }: { crumb: string }): JSX.Element {
  return (
    <header className="app-header">
      <h1>
        Provable Agent Spend <span className="crumb">/ {crumb}</span>
      </h1>
      <ThemeToggle />
    </header>
  );
}

function ThemeToggle(): JSX.Element {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    if (dark) root.setAttribute("data-theme", "dark");
    else root.removeAttribute("data-theme");
  }, [dark]);
  return (
    <button
      type="button"
      className="badge info"
      style={{ cursor: "pointer", border: "none" }}
      onClick={() => setDark((v) => !v)}
      aria-pressed={dark}
    >
      {dark ? "☾ Dark" : "☀ Light"}
    </button>
  );
}

function PageHead({ title, sub }: { title: string; sub: string }): JSX.Element {
  return (
    <div className="page-head">
      <h2>{title}</h2>
      <p>{sub}</p>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  children,
}: {
  icon: string;
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="empty">
      <div className="em-icon" aria-hidden="true">
        {icon}
      </div>
      <h4>{title}</h4>
      <p>{children}</p>
    </div>
  );
}

function Overview(): JSX.Element {
  useDocTitle("Overview");
  return (
    <>
      <PageHead
        title="Overview"
        sub="Live posture of the spend gate. Numbers populate once the ledger and audit trail are wired; the shell shows structure only."
      />
      <div className="grid tiles" style={{ marginBottom: 20 }}>
        <StatTile label="Decisions today" tone="info" hint="allow + deny" />
        <StatTile label="Allowed" tone="accent" hint="proven by the kernel" />
        <StatTile label="Denied" tone="deny" hint="deny dominates" />
        <StatTile label="Daily budget used" tone="warn" hint="vs. daily limit" />
      </div>
      <div className="grid two">
        <div className="card">
          <h3>Spend vs. daily limit</h3>
          <p className="card-sub">Aggregate against the org daily cap.</p>
          <EmptyState icon="▤" title="No data yet">
            Connect the ledger fact source to plot today&apos;s running total
            against the daily limit.
          </EmptyState>
        </div>
        <div className="card">
          <h3>Policy kernel</h3>
          <p className="card-sub">
            Deterministic Datalog rules. Same facts → same answer.
          </p>
          <div className="pill-row">
            {RULE_CATALOG.map((r) => (
              <span
                key={r.id}
                className={`badge ${r.id.startsWith("allow/") ? "allow" : "deny"}`}
                title={r.blurb}
              >
                {r.id}
              </span>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function CardsAndLimits(): JSX.Element {
  useDocTitle("Cards & Limits");
  return (
    <>
      <PageHead
        title="Cards & Limits"
        sub="Org policy limits and per-agent clearances — the authoritative caps the kernel evaluates against."
      />
      <div className="grid tiles" style={{ marginBottom: 20 }}>
        <StatTile label="Per-transaction cap" hint="policy_config" />
        <StatTile label="Daily limit" hint="policy_config" />
        <StatTile label="Approved categories" hint="from the ledger" />
        <StatTile label="Cleared agents" hint="agent clearances" />
      </div>
      <div className="card">
        <h3>Agent clearances</h3>
        <p className="card-sub">
          Which categories each agent may spend in. Sourced from the ledger, not
          model narration.
        </p>
        <EmptyState icon="▤" title="No data yet">
          The clearance matrix renders here once the ledger fact source is
          connected to the dashboard.
        </EmptyState>
      </div>
    </>
  );
}

function Decisions(): JSX.Element {
  useDocTitle("Decisions");
  return (
    <>
      <PageHead
        title="Decisions"
        sub="Every evaluated spend request with the facts that drove it and the rules that fired — the provenance behind each allow/deny."
      />
      <div className="card">
        <h3>Decision log</h3>
        <p className="card-sub">
          One row per request: outcome, fired rules, and the authoritative facts.
        </p>
        <EmptyState icon="⚖" title="No decisions yet">
          Trigger a payment through the MCP tool; the PreToolUse hook evaluates
          it and decisions stream in here with full provenance.
        </EmptyState>
      </div>
    </>
  );
}

function Audit(): JSX.Element {
  useDocTitle("Audit");
  return (
    <>
      <PageHead
        title="Audit"
        sub="Prove a decision to an auditor: the exact facts, their sources, and the deterministic rules that produced the outcome — re-derived in your browser from the record alone."
      />
      <ProofView />
    </>
  );
}

function NotFound(): JSX.Element {
  useDocTitle("Not found");
  return (
    <>
      <PageHead title="Not found" sub="That route does not exist." />
      <div className="card">
        <EmptyState icon="✧" title="Off the map">
          <NavLink to="/" className="badge info">
            Back to Overview
          </NavLink>
        </EmptyState>
      </div>
    </>
  );
}

const CRUMBS: Record<string, string> = {
  "/": "Overview",
  "/cards": "Cards & Limits",
  "/decisions": "Decisions",
  "/audit": "Audit",
};

export function App(): JSX.Element {
  const loc = useLocation();
  const crumb = CRUMBS[loc.pathname] ?? "…";
  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <Header crumb={crumb} />
        <main className="app-content">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/cards" element={<CardsAndLimits />} />
            <Route path="/decisions" element={<Decisions />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export default App;
