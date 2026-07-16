import { useEffect, useMemo, useState } from "react";
import type { FormEvent, JSX } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  LayoutGrid,
  CreditCard,
  Activity as ActivityIcon,
  Building2,
  ShieldCheck,
  Search,
  Bell,
  Settings,
  Moon,
  Sun,
  Menu,
} from "lucide-react";
import { cn } from "../lib/utils.js";
import { useTheme } from "../lib/useTheme.js";
import { useBridgeHealth } from "../lib/useBridgeHealth.js";
import { DecisionsWindowProvider, useDecisionsWindow } from "../lib/decisionsWindow.js";
import { agentLabel, vendorLabel } from "../lib/identity.js";
import { formatMoney, formatRelative } from "../lib/format.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.js";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog.js";
import { Badge } from "../components/ui/badge.js";
import { SkipLink } from "../components/ui/skip-link.js";

const NAV = [
  { to: "/app", label: "Dashboard", icon: LayoutGrid, end: true },
  { to: "/app/agents", label: "Agent cards", icon: CreditCard },
  { to: "/app/activity", label: "Activity", icon: ActivityIcon },
  { to: "/app/vendors", label: "Vendors", icon: Building2 },
  { to: "/app/policy", label: "Policy", icon: ShieldCheck },
];

function Logo(): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-1">
      <div className="flex size-8 items-center justify-center rounded-lg bg-ink font-display text-[15px] font-bold text-white">
        P
      </div>
      <span className="font-display text-[15px] font-semibold tracking-tight text-ink">Provable</span>
    </div>
  );
}

function ThemeToggle(): JSX.Element {
  const { dark, toggle } = useTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={dark}
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
      className="flex size-9 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
    >
      {dark ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
    </button>
  );
}

const HEALTH_LABEL: Record<string, string> = {
  wait: "Connecting…",
  live: "Bridge live",
  down: "Bridge offline",
};
const HEALTH_DOT: Record<string, string> = {
  wait: "bg-ink-faint",
  live: "bg-chart-allow",
  down: "bg-chart-deny",
};

function Sidebar(): JSX.Element {
  const { health } = useBridgeHealth();
  return (
    <aside className="flex h-screen w-[240px] shrink-0 flex-col gap-6 border-r border-line bg-surface px-4 py-5 max-lg:hidden">
      <Logo />
      <nav className="flex flex-col gap-1" aria-label="Primary">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-[13.5px] font-medium transition-colors",
                isActive ? "bg-lime-soft text-lime-ink" : "text-ink-muted hover:bg-surface-hover hover:text-ink",
              )
            }
          >
            <item.icon className="size-[17px]" strokeWidth={2} />
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-3 border-t border-line pt-4">
        <div className="flex items-center gap-2 px-1 text-[12px] text-ink-faint">
          <span className={cn("size-1.5 rounded-full", HEALTH_DOT[health])} aria-hidden="true" />
          {HEALTH_LABEL[health]}
        </div>
        <div className="rounded-md bg-surface-sunken px-3 py-2 text-[11px] leading-snug text-ink-faint">
          Demo environment · sandbox payments. No real money moves.
        </div>
      </div>
    </aside>
  );
}

/** The sidebar's nav, reachable below `lg` where the sidebar itself is hidden. */
function MobileNav(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex size-9 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink lg:hidden"
        aria-label="Open navigation"
      >
        <Menu className="size-[19px]" />
      </button>
      <DialogContent className="top-0 max-w-none translate-y-0 rounded-none border-0 border-r data-[state=open]:animate-in sm:max-w-xs sm:rounded-r-2xl">
        <DialogTitle className="sr-only">Navigation</DialogTitle>
        <Logo />
        <nav className="mt-6 flex flex-col gap-1" aria-label="Primary">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2.5 text-[14px] font-medium transition-colors",
                  isActive ? "bg-lime-soft text-lime-ink" : "text-ink-muted hover:bg-surface-hover hover:text-ink",
                )
              }
            >
              <item.icon className="size-[18px]" strokeWidth={2} />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </DialogContent>
    </Dialog>
  );
}

/** Real notifications: escalations awaiting a human + flagged/tampered proofs — not decorative. */
function NotificationsMenu(): JSX.Element {
  const win = useDecisionsWindow();
  const items = useMemo(() => {
    if (win.status !== "success") return [];
    return win.data.decisions
      .filter(
        (d) =>
          d.outcome === "escalate" ||
          d.proofVerification.reason === "mismatch" ||
          d.proofVerification.reason === "corrupt" ||
          d.execution?.status === "failed",
      )
      .slice(0, 6);
  }, [win]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative flex size-9 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
          aria-label={`Notifications${items.length > 0 ? ` (${items.length})` : ""}`}
        >
          <Bell className="size-[18px]" />
          {items.length > 0 && (
            <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-chart-deny ring-2 ring-surface" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Needs attention</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          <p className="px-2.5 py-3 text-[13px] text-ink-faint">Nothing needs a human right now.</p>
        ) : (
          items.map((d) => {
            const isEscalate = d.outcome === "escalate";
            return (
              <DropdownMenuItem key={d.decisionId} asChild>
                <NavLink to={`/app/activity/${encodeURIComponent(d.decisionId)}`} className="flex-col items-start gap-0.5">
                  <span className="flex w-full items-center justify-between gap-2">
                    <span className="font-medium text-ink">
                      {agentLabel(d.agentId)} → {vendorLabel(d.vendorId)}
                    </span>
                    <Badge tone={isEscalate ? "warn" : "deny"} className="shrink-0">
                      {isEscalate ? "Needs approval" : "Flagged"}
                    </Badge>
                  </span>
                  <span className="tabular text-[12px] text-ink-faint">
                    {formatMoney(d.amount, d.request?.currency ?? "USD")} · {formatRelative(d.ts, new Date())}
                  </span>
                </NavLink>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function QuickSearch(): JSX.Element {
  const [q, setQ] = useState("");
  const navigate = useNavigate();

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    const query = q.trim();
    if (!query) return;
    navigate(`/app/activity?agentId=${encodeURIComponent(query)}`);
  }

  return (
    <form onSubmit={onSubmit} className="relative w-full max-w-xs max-md:hidden">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        type="text"
        placeholder="Search by agent id…"
        className="h-9 w-full rounded-md border border-line bg-field pl-9 pr-3 text-[13px] text-ink placeholder:text-ink-faint outline-none transition-colors focus-visible:border-info focus-visible:ring-2 focus-visible:ring-info/20"
      />
    </form>
  );
}

function Topbar(): JSX.Element {
  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-4 sm:px-6">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <MobileNav />
        <QuickSearch />
      </div>
      <div className="flex items-center gap-1">
        <NotificationsMenu />
        <NavLink
          to="/app/policy"
          className="flex size-9 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
          aria-label="Policy settings"
          title="Policy settings"
        >
          <Settings className="size-[18px]" />
        </NavLink>
        <ThemeToggle />
        <div className="ml-2 flex items-center gap-2 border-l border-line pl-3">
          <div className="flex size-8 items-center justify-center rounded-full bg-surface-sunken text-[12px] font-semibold text-ink-muted">
            DW
          </div>
          <div className="hidden flex-col leading-tight sm:flex">
            <span className="text-[12.5px] font-medium text-ink">Demo Workspace</span>
            <span className="text-[11px] text-ink-faint">Sandbox</span>
          </div>
        </div>
      </div>
    </header>
  );
}

function useDocTitleFromPath(): void {
  useEffect(() => {
    // Individual pages override this; this is just a sane default on first paint.
    if (!document.title || document.title === "Provable Agent Spend") {
      document.title = "Dashboard · Provable Agent Spend";
    }
  }, []);
}

export function AppLayout(): JSX.Element {
  useDocTitleFromPath();
  return (
    <DecisionsWindowProvider>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <SkipLink />
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar />
          <main id="main" className="min-w-0 flex-1 overflow-y-auto px-6 py-6 lg:px-8 lg:py-8">
            <div className="mx-auto w-full max-w-[1320px]">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </DecisionsWindowProvider>
  );
}

export default AppLayout;
