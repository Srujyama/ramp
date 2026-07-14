/**
 * @ramp/dashboard — read-only ledger bridge client
 *
 * Talks to the `@ramp/ledger` HTTP bridge (`GET /decisions`, `/decisions/:id`).
 * The bridge is READ-ONLY and append-only-audited; this client never mutates.
 *
 * Every failure the UI must distinguish is modeled as a typed {@link BridgeError}
 * `kind`, so screens can render the right state instead of a generic "error":
 *   - `unavailable` — the bridge didn't answer (down, wrong URL, CORS, offline).
 *   - `malformed`   — it answered, but the body wasn't the JSON shape we expect.
 *   - `not_found`   — a specific decision id doesn't exist (404).
 *   - `http`        — some other non-2xx status.
 */
import type { DecisionListResponse, DecisionView, DecisionsQuery } from "./types.js";

/** Bridge base URL. Override per-deploy with VITE_BRIDGE_URL. */
export const BRIDGE_URL: string =
  (import.meta.env.VITE_BRIDGE_URL as string | undefined)?.replace(/\/$/, "") ??
  "http://localhost:8787";

export type BridgeErrorKind =
  | "unavailable"
  | "malformed"
  | "not_found"
  | "http";

export class BridgeError extends Error {
  readonly kind: BridgeErrorKind;
  readonly status?: number;
  constructor(kind: BridgeErrorKind, message: string, status?: number) {
    super(message);
    this.name = "BridgeError";
    this.kind = kind;
    this.status = status;
  }
}

/** Minimal structural guard — a body that isn't a decision is `malformed`. */
function looksLikeDecision(v: unknown): v is DecisionView {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.decisionId === "string" &&
    typeof d.status === "string" &&
    typeof d.proofVerified === "boolean" &&
    Array.isArray(d.firedRules)
  );
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${BRIDGE_URL}${path}`, {
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (err) {
    // Network-level failure: DNS, connection refused, CORS block, offline.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new BridgeError(
      "unavailable",
      `Could not reach the ledger bridge at ${BRIDGE_URL}.`,
    );
  }

  if (res.status === 404) {
    throw new BridgeError("not_found", "Decision not found.", 404);
  }
  if (!res.ok) {
    throw new BridgeError("http", `Bridge returned HTTP ${res.status}.`, res.status);
  }

  try {
    return await res.json();
  } catch {
    throw new BridgeError("malformed", "Bridge returned a non-JSON response.");
  }
}

/** Fetch a page of decisions (newest first). */
export async function fetchDecisions(
  query: DecisionsQuery = {},
  signal?: AbortSignal,
): Promise<DecisionListResponse> {
  const params = new URLSearchParams();
  if (query.agentId) params.set("agentId", query.agentId);
  if (query.vendorId) params.set("vendorId", query.vendorId);
  if (query.outcome) params.set("outcome", query.outcome);
  if (query.status) params.set("status", query.status);
  if (query.firedRule) params.set("firedRule", query.firedRule);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  const qs = params.toString();

  const body = await getJson(`/decisions${qs ? `?${qs}` : ""}`, signal);
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { decisions?: unknown }).decisions)
  ) {
    throw new BridgeError("malformed", "Bridge list response was not { decisions: [...] }.");
  }
  const list = body as DecisionListResponse;
  // Guard each row so a single corrupt shape can't crash the table.
  if (!list.decisions.every(looksLikeDecision)) {
    throw new BridgeError("malformed", "Bridge list contained a decision of the wrong shape.");
  }
  return list;
}

/** Fetch one decision by id. Throws `BridgeError("not_found")` on a 404. */
export async function fetchDecision(
  id: string,
  signal?: AbortSignal,
): Promise<DecisionView> {
  const body = await getJson(`/decisions/${encodeURIComponent(id)}`, signal);
  if (!looksLikeDecision(body)) {
    throw new BridgeError("malformed", "Bridge decision response had the wrong shape.");
  }
  return body;
}
