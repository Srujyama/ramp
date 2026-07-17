/**
 * @ramp/control-plane — pricing service (live fetch + static fallback)
 *
 * Pulls model prices for OpenAI / Anthropic / Google into the `model_pricing`
 * REFERENCE table. This is DEMO / INFORMATIONAL data — it never enters a Facts
 * object, never gates a decision, and lives entirely off the enforcement path
 * (the fail-closed hook and the kernel make ZERO network calls; this job runs in
 * the separate control-plane process).
 *
 * ROBUSTNESS (per the spec): the fetch must fail gracefully.
 *   - A live source is used only if `RAMP_PRICING_URL` is configured AND reachable
 *     AND returns the expected shape within the timeout.
 *   - On ANY failure (no URL, timeout, non-2xx, bad JSON), we keep whatever is
 *     already loaded; and if the table is empty we seed a checked-in STATIC table
 *     so the UI is never blank.
 *   - Every row carries its `source` (`live` | `static-fallback`) and `fetchedAt`,
 *     so the dashboard can label exactly how fresh the number is. We never present
 *     a stale or fallback price as if it were live.
 */
import type { LedgerDb, ModelPrice } from "@ramp/ledger";
import { listModelPricing, upsertModelPricing } from "@ramp/ledger";

/**
 * Checked-in fallback prices (USD per 1M tokens). Representative, clearly labeled
 * `static-fallback` — used only when no live source is available. Update as needed;
 * the point is that the demo always has a sane, honestly-sourced table to show.
 */
const STATIC_PRICING: ReadonlyArray<Omit<ModelPrice, "source" | "fetchedAt">> = [
  { provider: "anthropic", model: "claude-opus-4-8", inputPrice: "15.00", outputPrice: "75.00", currency: "USD" },
  { provider: "anthropic", model: "claude-sonnet-5", inputPrice: "3.00", outputPrice: "15.00", currency: "USD" },
  { provider: "anthropic", model: "claude-haiku-4-5", inputPrice: "1.00", outputPrice: "5.00", currency: "USD" },
  { provider: "openai", model: "gpt-5.6", inputPrice: "1.25", outputPrice: "10.00", currency: "USD" },
  { provider: "openai", model: "gpt-5.6-mini", inputPrice: "0.25", outputPrice: "2.00", currency: "USD" },
  { provider: "openai", model: "o4", inputPrice: "15.00", outputPrice: "60.00", currency: "USD" },
  { provider: "google", model: "gemini-3-pro", inputPrice: "1.25", outputPrice: "10.00", currency: "USD" },
  { provider: "google", model: "gemini-3-flash", inputPrice: "0.30", outputPrice: "2.50", currency: "USD" },
];

/** How long to wait for a live pricing source before falling back. */
const FETCH_TIMEOUT_MS = 5000;

/** True iff `v` is a plausible live-pricing row we can trust into the table. */
function isPriceShape(v: unknown): v is { provider: string; model: string; inputPrice: string | number; outputPrice: string | number; currency?: string } {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.provider === "string" &&
    typeof o.model === "string" &&
    (typeof o.inputPrice === "string" || typeof o.inputPrice === "number") &&
    (typeof o.outputPrice === "string" || typeof o.outputPrice === "number")
  );
}

/**
 * Attempt to fetch live prices from `RAMP_PRICING_URL`. Returns null on ANY
 * problem (unset URL, timeout, non-2xx, malformed body) — the caller falls back.
 * Never throws.
 */
export async function fetchLivePricing(now: string): Promise<ModelPrice[] | null> {
  const url = process.env.RAMP_PRICING_URL;
  if (!url) return null; // no live source configured — static is the honest default
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const rows = Array.isArray(body) ? body : (body as { prices?: unknown }).prices;
    if (!Array.isArray(rows)) return null;
    const parsed: ModelPrice[] = [];
    for (const r of rows) {
      if (!isPriceShape(r)) continue;
      parsed.push({
        provider: r.provider,
        model: r.model,
        inputPrice: String(r.inputPrice),
        outputPrice: String(r.outputPrice),
        currency: typeof r.currency === "string" ? r.currency : "USD",
        source: "live",
        fetchedAt: now,
      });
    }
    return parsed.length > 0 ? parsed : null;
  } catch {
    return null; // timeout / network / parse — graceful fallback
  } finally {
    clearTimeout(timer);
  }
}

/** The static fallback rows, stamped with `source` + `fetchedAt`. */
export function staticPricing(now: string): ModelPrice[] {
  return STATIC_PRICING.map((p) => ({ ...p, source: "static-fallback" as const, fetchedAt: now }));
}

/**
 * Refresh the pricing table: seed static if empty, then upgrade to live if a
 * source is reachable. Returns what actually happened, for logging. Never throws.
 */
export async function refreshPricing(db: LedgerDb, now: string): Promise<{ source: "live" | "static-fallback"; count: number }> {
  // Guarantee the table is never blank for the demo.
  if (listModelPricing(db).length === 0) {
    upsertModelPricing(db, staticPricing(now));
  }
  const live = await fetchLivePricing(now);
  if (live && live.length > 0) {
    upsertModelPricing(db, live);
    return { source: "live", count: live.length };
  }
  return { source: "static-fallback", count: listModelPricing(db).length };
}
