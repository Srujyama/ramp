import type { JSX } from "react";
import { useEffect } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import Sidebar from "./components/Sidebar.js";
import { SkipLink } from "./components/ui.js";
import { useTheme } from "./lib/useTheme.js";
import { useBridgeHealth, type Health } from "./lib/useBridgeHealth.js";
import Overview from "./pages/Overview.js";
import Decisions from "./pages/Decisions.js";
import DecisionDetail from "./pages/DecisionDetail.js";
import Policy from "./pages/Policy.js";

/**
 * @ramp/dashboard — App
 *
 * The audit console for Provable Agent Spend: the trust layer between AI agents
 * and money. Reads the append-only decision log through the read-only ledger
 * bridge and shows, per autonomous purchase, the policy outcome, its independent
 * proof verification, its provenance, and its sandbox payment — nothing
 * fabricated. Enforcement lives in the policy gate, not this UI.
 */

const CRUMBS: Record<string, string> = {
  "/": "Overview",
  "/decisions": "Decisions",
  "/policy": "Policy",
};

function crumbFor(pathname: string): string {
  if (pathname.startsWith("/decisions/")) return "Decision";
  return CRUMBS[pathname] ?? "…";
}

function useDocTitle(section: string): void {
  useEffect(() => {
    document.title = `${section} · Provable Agent Spend`;
  }, [section]);
}

const CONN_LABEL: Record<Health, string> = {
  wait: "Connecting…",
  live: "Bridge live",
  down: "Bridge offline",
};

function ConnPill({ health }: { health: Health }): JSX.Element {
  return (
    <span className={`conn ${health}`} title="Read-only ledger audit bridge">
      <span className="cdot" aria-hidden="true" />
      {CONN_LABEL[health]}
    </span>
  );
}

function ThemeToggle(): JSX.Element {
  const { dark, toggle } = useTheme();
  return (
    <button
      type="button"
      className="btn ghost"
      onClick={toggle}
      aria-pressed={dark}
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
    >
      {dark ? "☾ Dark" : "☀ Light"}
    </button>
  );
}

function Header({
  crumb,
  health,
}: {
  crumb: string;
  health: Health;
}): JSX.Element {
  return (
    <header className="app-header">
      <h1>
        Provable Agent Spend <span className="crumb">/ {crumb}</span>
      </h1>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <ConnPill health={health} />
        <ThemeToggle />
      </div>
    </header>
  );
}

function NotFound(): JSX.Element {
  useDocTitle("Not found");
  return (
    <div className="state-card">
      <div className="s-icon" aria-hidden="true">
        ✧
      </div>
      <h4>Off the map</h4>
      <p>That route does not exist.</p>
    </div>
  );
}

export function App(): JSX.Element {
  const loc = useLocation();
  const crumb = crumbFor(loc.pathname);
  const { health, bump } = useBridgeHealth();

  return (
    <div className="app-shell">
      <SkipLink />
      <Sidebar />
      <div className="app-main">
        <Header crumb={crumb} health={health} />
        <main className="app-content" id="main">
          <Routes>
            <Route path="/" element={<Overview onHealth={bump} />} />
            <Route path="/decisions" element={<Decisions />} />
            <Route path="/decisions/:id" element={<DecisionDetail />} />
            <Route path="/policy" element={<Policy />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export default App;
