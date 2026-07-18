import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent, JSX } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  LayoutGrid,
  Radio,
  Activity as ActivityIcon,
  ClipboardCheck,
  Building2,
  ShieldCheck,
  ShieldAlert,
  Link2,
  Play,
  SlidersHorizontal,
  Search,
  Bell,
  Settings,
  Moon,
  Sun,
  Menu,
  ChevronsLeft,
} from "lucide-react";
import { cn } from "../lib/utils.js";
import { useTheme } from "../lib/useTheme.js";
import { useBridgeHealth, type Health } from "../lib/useBridgeHealth.js";
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
  { to: "/app/live", label: "Live", icon: Radio },
  { to: "/app/activity", label: "Activity", icon: ActivityIcon },
  { to: "/app/approvals", label: "Approvals", icon: ClipboardCheck },
  { to: "/app/vendors", label: "Vendors", icon: Building2 },
  { to: "/app/policy", label: "Policy", icon: ShieldCheck },
  { to: "/app/security", label: "Security", icon: ShieldAlert },
  { to: "/app/integrity", label: "Integrity", icon: Link2 },
  { to: "/app/simulate", label: "Simulate", icon: Play },
  { to: "/app/admin", label: "Admin", icon: SlidersHorizontal },
];

const SIDEBAR_KEY = "ramp-sidebar-collapsed";

function useSidebarCollapsed(): { collapsed: boolean; toggle: () => void } {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
    } catch {
      /* ignore persistence failures */
    }
  }, [collapsed]);

  const toggle = useCallback(() => setCollapsed((c) => !c), []);
  return { collapsed, toggle };
}

function Logo({ collapsed }: { collapsed: boolean }): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-1">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-[--radius-sm] bg-ink font-display text-[15px] font-bold text-canvas">
        P
      </div>
      <span className={cn("font-display text-[15px] font-semibold tracking-tight text-ink", collapsed && "sr-only")}>
        Provable
      </span>
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
      className="flex size-9 items-center justify-center rounded-[--radius-sm] text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
    >
      {dark ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
    </button>
  );
}

const HEALTH_LABEL: Record<Health, string> = {
  wait: "Connecting",
  live: "Bridge online",
  down: "Bridge offline",
};
const HEALTH_DOT: Record<Health, string> = {
  wait: "bg-ink-faint",
  live: "bg-chart-allow",
  down: "bg-chart-deny",
};

/** A terse, bold connection indicator — a colored square + label, not a pill. */
function ConnectionStatus({ collapsed }: { collapsed: boolean }): JSX.Element {
  const { health } = useBridgeHealth();
  const { live } = useDecisionsWindow();
  const label = HEALTH_LABEL[health] + (health === "live" && live ? " · streaming" : "");
  return (
    <div
      className={cn("flex items-center gap-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint", collapsed && "justify-center px-0")}
      title={label}
    >
      <span className={cn("size-2 shrink-0", HEALTH_DOT[health])} aria-hidden="true" />
      {collapsed ? null : <span className="truncate">{label}</span>}
    </div>
  );
}

function Sidebar({ collapsed, toggle }: { collapsed: boolean; toggle: () => void }): JSX.Element {
  return (
    <aside
      className={cn(
        "flex h-screen shrink-0 flex-col gap-6 border-r border-line bg-surface px-3 py-5 transition-[width] duration-150 max-lg:hidden",
        collapsed ? "w-[68px]" : "w-[240px]",
      )}
    >
      <div className="flex items-center justify-between">
        <Logo collapsed={collapsed} />
        {!collapsed ? (
          <button
            type="button"
            onClick={toggle}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            className="flex size-7 shrink-0 items-center justify-center rounded-[--radius-sm] text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
          >
            <ChevronsLeft className="size-4" />
          </button>
        ) : null}
      </div>
      {collapsed ? (
        <button
          type="button"
          onClick={toggle}
          aria-label="Expand sidebar"
          title="Expand sidebar"
          className="flex size-7 items-center justify-center self-center rounded-[--radius-sm] text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
        >
          <ChevronsLeft className="size-4 rotate-180" />
        </button>
      ) : null}
      <nav className="flex flex-col gap-1" aria-label="Primary">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            title={collapsed ? item.label : undefined}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-[--radius-md] px-3 py-2 text-[13.5px] font-medium transition-colors",
                collapsed && "justify-center px-0",
                isActive ? "bg-surface-sunken text-ink font-semibold [&_svg]:text-lime" : "text-ink-muted hover:bg-surface-hover hover:text-ink",
              )
            }
          >
            <item.icon className="size-[17px] shrink-0" strokeWidth={1.75} />
            <span className={cn(collapsed && "sr-only")}>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-3 border-t border-line pt-4">
        <ConnectionStatus collapsed={collapsed} />
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
        className="flex size-9 items-center justify-center rounded-[--radius-sm] text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink lg:hidden"
        aria-label="Open navigation"
      >
        <Menu className="size-[19px]" />
      </button>
      <DialogContent className="top-0 max-w-none translate-y-0 rounded-none border-0 border-r data-[state=open]:animate-in sm:max-w-xs">
        <DialogTitle className="sr-only">Navigation</DialogTitle>
        <Logo collapsed={false} />
        <nav className="mt-6 flex flex-col gap-1" aria-label="Primary">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-[--radius-md] px-3 py-2.5 text-[14px] font-medium transition-colors",
                  isActive ? "bg-surface-sunken text-ink font-semibold [&_svg]:text-lime" : "text-ink-muted hover:bg-surface-hover hover:text-ink",
                )
              }
            >
              <item.icon className="size-[18px]" strokeWidth={1.75} />
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
          className="relative flex size-9 items-center justify-center rounded-[--radius-sm] text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
          aria-label={`Notifications${items.length > 0 ? ` (${items.length})` : ""}`}
        >
          <Bell className="size-[18px]" />
          {items.length > 0 && (
            <span className="absolute right-1.5 top-1.5 size-2 bg-chart-deny ring-2 ring-surface" />
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
        className="h-9 w-full rounded-[--radius-sm] border border-line bg-field pl-9 pr-3 text-[13px] text-ink placeholder:text-ink-faint outline-none transition-colors focus-visible:border-info focus-visible:ring-2 focus-visible:ring-info/20"
      />
    </form>
  );
}

function Topbar(): JSX.Element {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-4 sm:px-6">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <MobileNav />
        <QuickSearch />
      </div>
      <div className="flex items-center gap-1">
        <NotificationsMenu />
        <NavLink
          to="/app/policy"
          className="flex size-9 items-center justify-center rounded-[--radius-sm] text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
          aria-label="Policy settings"
          title="Policy settings"
        >
          <Settings className="size-[18px]" />
        </NavLink>
        <ThemeToggle />
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
  const { collapsed, toggle } = useSidebarCollapsed();
  return (
    <DecisionsWindowProvider>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <SkipLink />
        <Sidebar collapsed={collapsed} toggle={toggle} />
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
