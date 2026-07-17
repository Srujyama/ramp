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
