/**
 * @ramp/dashboard — dashboard widget visibility
 *
 * Backs the "Add widget" affordance: which dashboard-home widgets are shown,
 * persisted to localStorage so the layout survives a reload. Placeholder
 * widgets (net-new metrics with no real data source — see WIDGETS below)
 * default OFF, so the dashboard opens fully real and a widget only appears
 * once someone deliberately adds it.
 */
import { useCallback, useEffect, useState } from "react";

export interface WidgetDef {
  key: string;
  title: string;
  description: string;
  /** Widgets with no real data source yet — rendered as a labeled placeholder. */
  placeholder?: boolean;
}

export const WIDGETS: readonly WidgetDef[] = [
  { key: "spendOverview", title: "Spend overview", description: "Daily decision volume by outcome" },
  { key: "agentFleet", title: "Agent cards", description: "Your agent spend cards" },
  { key: "trustSummary", title: "Trust summary", description: "Proof verification + flags" },
  { key: "recentActivity", title: "Recent activity", description: "Latest decisions" },
  { key: "categoryBreakdown", title: "Category breakdown", description: "Spend by category" },
  { key: "vendorBreakdown", title: "Vendor breakdown", description: "Spend by vendor" },
  { key: "limitUsage", title: "Daily limit usage", description: "Org-wide cap usage" },
  {
    key: "costPerQuery",
    title: "Cost per query",
    description: "Per-call model cost — not yet tracked by the ledger",
    placeholder: true,
  },
  {
    key: "providerBreakdown",
    title: "LLM provider breakdown",
    description: "Spend by model provider — not yet tracked by the ledger",
    placeholder: true,
  },
];

const KEY = "ramp-widgets-v1";

function defaults(): Record<string, boolean> {
  const d: Record<string, boolean> = {};
  for (const w of WIDGETS) d[w.key] = !w.placeholder;
  return d;
}

function load(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const merged = defaults();
    for (const w of WIDGETS) {
      const v = parsed[w.key];
      if (typeof v === "boolean") merged[w.key] = v;
    }
    return merged;
  } catch {
    return defaults();
  }
}

export function useWidgetPrefs(): {
  enabled: Record<string, boolean>;
  toggle: (key: string) => void;
} {
  const [enabled, setEnabled] = useState<Record<string, boolean>>(load);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(enabled));
    } catch {
      /* ignore persistence failures */
    }
  }, [enabled]);

  const toggle = useCallback((key: string) => {
    setEnabled((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  return { enabled, toggle };
}
