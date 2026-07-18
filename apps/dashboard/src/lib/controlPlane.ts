/**
 * Dashboard client for the DEMO CONTROL PLANE (NOT the read-only audit bridge).
 *
 * The audit bridge (`bridge.ts`, :8787) is strictly GET-only and is the security
 * boundary — it can never write. The control plane (:8788) is a SEPARATE demo-only
 * process that serves reference data (model pricing) and, in later phases, triggers
 * REAL gated transactions and typed admin writes. Keeping this in its own client
 * file makes the split obvious: `bridge.ts` reads the audit trail; this talks to the
 * demo control plane.
 */

/** Control-plane base URL. Override per-deploy with VITE_CONTROL_PLANE_URL. */
export const CONTROL_PLANE_URL: string =
  (import.meta.env.VITE_CONTROL_PLANE_URL as string | undefined)?.replace(/\/$/, "") ??
  "http://localhost:8788";

/** One model's prices, as served by the control plane's /pricing endpoint. */
export interface ModelPrice {
  readonly provider: string;
  readonly model: string;
  readonly inputPrice: string;
  readonly outputPrice: string;
  readonly currency: string;
  readonly source: "live" | "cached" | "static-fallback";
  readonly fetchedAt: string;
}

export interface PricingResponse {
  readonly prices: readonly ModelPrice[];
  readonly count: number;
  readonly refreshedAt: string;
}

export class ControlPlaneError extends Error {
  readonly kind: "unavailable" | "http" | "malformed";
  constructor(kind: "unavailable" | "http" | "malformed", message: string) {
    super(message);
    this.name = "ControlPlaneError";
    this.kind = kind;
  }
}

function isPrice(v: unknown): v is ModelPrice {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.provider === "string" &&
    typeof p.model === "string" &&
    typeof p.inputPrice === "string" &&
    typeof p.outputPrice === "string" &&
    typeof p.source === "string"
  );
}

/** The intent a "Simulate Transaction" sends — only keys, never a verdict. */
export interface TxIntent {
  readonly agent: string;
  readonly vendor: string;
  readonly amount: number;
  readonly category: string;
  readonly currency?: string;
  readonly attest: boolean;
}

/** The REAL recorded verdict the control plane returns. */
export interface TxResult {
  readonly status: string;
  readonly outcome: "allow" | "deny" | "escalate" | null;
  readonly decisionId: string | null;
  readonly firedRules: readonly string[];
  readonly reasons: readonly string[];
}

/**
 * Drive a REAL gated transaction through the control plane (which runs
 * requestPurchase — the kernel decides, the decision is recorded, and it appears
 * live on the dashboard). NOT a fake row.
 */
export async function postTransaction(intent: TxIntent, signal?: AbortSignal): Promise<TxResult> {
  let res: Response;
  try {
    res = await fetch(`${CONTROL_PLANE_URL}/transaction`, {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify(intent),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ControlPlaneError("unavailable", `Could not reach the demo control plane at ${CONTROL_PLANE_URL}. Start it with \`pnpm control-plane\`.`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ControlPlaneError("malformed", "Control plane returned a non-JSON response.");
  }
  if (!res.ok) {
    const msg = typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : `HTTP ${res.status}`;
    throw new ControlPlaneError("http", msg);
  }
  return body as TxResult;
}

// --- admin: typed writes to INPUT tables (never a decision) -------------------

/** The org policy dials the admin surface may read/retune. */
export interface Dials {
  readonly perTxnCap: number;
  readonly dailyLimit: number;
  readonly escalationThreshold: number;
  readonly velocityLimit: number;
  readonly velocityWindowMinutes: number;
  readonly dedupWindowMinutes: number;
  readonly currency: string;
}

/** What the admin form needs to render: current dials + the approved categories. */
export interface AdminState {
  readonly dials: Dials;
  readonly categories: readonly string[];
}

export interface NewAgentInput {
  readonly agentId: string;
  readonly displayName: string;
  readonly clearedCategories: readonly string[];
}

export interface DialPatchInput {
  readonly perTxnCap?: number;
  readonly dailyLimit?: number;
  readonly escalationThreshold?: number;
  readonly velocityLimit?: number;
}

/** Small helper: fetch JSON from the control plane with typed errors + optional method/body. */
async function cpFetch<T>(path: string, init?: RequestInit, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${CONTROL_PLANE_URL}${path}`, {
      ...init,
      headers: { Accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ControlPlaneError("unavailable", `Could not reach the demo control plane at ${CONTROL_PLANE_URL}. Start it with \`pnpm control-plane\`.`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ControlPlaneError("malformed", "Control plane returned a non-JSON response.");
  }
  if (!res.ok) {
    const msg = typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : `HTTP ${res.status}`;
    throw new ControlPlaneError("http", msg);
  }
  return body as T;
}

/** Current dials + approved categories for the admin form. */
export function fetchAdminState(signal?: AbortSignal): Promise<AdminState> {
  return cpFetch<AdminState>("/admin/state", undefined, signal);
}

/** Register a new agent + its category clearances (INPUT tables only, never a decision). */
export function createAgent(input: NewAgentInput, signal?: AbortSignal): Promise<{ agentId: string; displayName: string; clearedCategories: string[] }> {
  return cpFetch("/agents", { method: "POST", body: JSON.stringify(input) }, signal);
}

/** Retune the org policy dials; returns the resulting dials. */
export function updateDials(patch: DialPatchInput, signal?: AbortSignal): Promise<Dials> {
  return cpFetch<Dials>("/policy", { method: "PATCH", body: JSON.stringify(patch) }, signal);
}

/** Result of toggling the "Enable Dummy Data" switch (Admin tab). */
export interface DemoDataResult {
  readonly enabled: boolean;
  readonly written?: number;
  readonly days?: number;
  readonly problems?: readonly string[];
}

/**
 * Populate (~90 days of synthetic-but-kernel-derived history) or clear the demo
 * dataset. Fully reversible: disabling wipes the decision log and restores the
 * base seed's calibrated spend — see @ramp/ledger's clearDemoHistory.
 */
export function setDemoData(enabled: boolean, signal?: AbortSignal): Promise<DemoDataResult> {
  return cpFetch<DemoDataResult>("/demo/data", { method: "POST", body: JSON.stringify({ enabled }) }, signal);
}

/** Fetch model pricing from the control plane. Never throws for a demo-down plane; surfaces a typed error. */
export async function fetchPricing(signal?: AbortSignal): Promise<PricingResponse> {
  let res: Response;
  try {
    res = await fetch(`${CONTROL_PLANE_URL}/pricing`, { headers: { Accept: "application/json" }, signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ControlPlaneError(
      "unavailable",
      `Could not reach the demo control plane at ${CONTROL_PLANE_URL}. Start it with \`pnpm control-plane\`.`,
    );
  }
  if (!res.ok) throw new ControlPlaneError("http", `Control plane returned HTTP ${res.status}.`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ControlPlaneError("malformed", "Control plane returned a non-JSON response.");
  }
  const prices = (body as { prices?: unknown }).prices;
  if (!Array.isArray(prices)) throw new ControlPlaneError("malformed", "Expected { prices: [...] }.");
  return {
    prices: prices.filter(isPrice),
    count: typeof (body as { count?: unknown }).count === "number" ? (body as { count: number }).count : prices.length,
    refreshedAt: typeof (body as { refreshedAt?: unknown }).refreshedAt === "string" ? (body as { refreshedAt: string }).refreshedAt : "",
  };
}
