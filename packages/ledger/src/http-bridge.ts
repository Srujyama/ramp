/**
 * @ramp/ledger — http-bridge.ts
 *
 * A READ-ONLY HTTP bridge that exposes the audit trail (the decision log) to the
 * dashboard. It is the trust boundary between an untrusted browser and the
 * authoritative SQLite fact store, so it is deliberately narrow:
 *
 *   - GET-only. There is NO mutation route, ever — the ledger is append-only and
 *     is written ONLY by the hook. A bridge that could write would be a way to
 *     forge audit rows, so it simply cannot.
 *   - CORS is pinned to ONE `allowedOrigin` (never `*`).
 *   - Every response is bounded: pagination is delegated to `listDecisions`
 *     (which clamps to `[1, MAX_LIMIT]`), the URL length is capped, and any
 *     request body is rejected (this is a GET API).
 *   - Errors never leak a stack trace, SQL, DB text, or a file path — the client
 *     gets a stable `{ "error": ... }` shape and nothing else.
 *
 * `proofVerified` is INDEPENDENTLY RECOMPUTED from the stored proof (via
 * `verifyDecisionProof`) rather than echoed from stored bytes, so a tampered
 * proof surfaces as `proofVerified: false` even if the stored blob claims
 * otherwise. `provenance` is surfaced top-level for convenient dashboard reads.
 *
 * Uses `node:http` only. The caller owns the DB and the server lifecycle: the
 * factory NEVER calls `listen()` and NEVER opens/closes the DB.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import type { LedgerDb } from "./db.js";
import {
  getDecision,
  listDecisions,
  type DecisionRecord,
  type ListDecisionsQuery,
} from "./decision-log.js";
import type { DecisionOutcome, RuleId } from "@ramp/shared";
import type { DecisionStatus } from "./decision-log.js";
import type { ProvenanceGraph } from "./provenance.js";
// SEAM: independent proof re-verification lives in its own module (Agent B).
import { verifyDecisionProof, type DecisionProofVerification } from "./proof-verification.js";

/** Options for {@link createLedgerBridge}. */
export interface LedgerBridgeOptions {
  /** The open ledger DB (injected). The bridge NEVER opens or closes it. */
  readonly db: LedgerDb;
  /** The ONE dashboard origin allowed for CORS. Never `"*"`. */
  readonly allowedOrigin: string;
  /** Max `req.url` length before a 414. Default 2048. */
  readonly maxUrlLength?: number;
  /** Max request `Content-Length` before a 413. Default 0 — this is a GET API. */
  readonly maxBodyBytes?: number;
}

/**
 * A single decision as returned by the bridge: the full {@link DecisionRecord}
 * PLUS derived, independently-verified trust fields.
 */
export interface DecisionView extends DecisionRecord {
  /** `record.proof?.provenance ?? null`, surfaced top-level for the dashboard. */
  readonly provenance: ProvenanceGraph | null;
  /** Independently recomputed — NOT the stored bytes. See {@link verifyDecisionProof}. */
  readonly proofVerified: boolean;
  /** The full verification result (present/verified/expected/actual/reason). */
  readonly proofVerification: DecisionProofVerification;
}

const DEFAULT_MAX_URL_LENGTH = 2048;
const DEFAULT_MAX_BODY_BYTES = 0;

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/** Map one stored record into the dashboard-facing view (derives trust fields). */
function toDecisionView(record: DecisionRecord): DecisionView {
  const proofVerification = verifyDecisionProof(record);
  return {
    ...record,
    provenance: record.proof?.provenance ?? null,
    proofVerified: proofVerification.proofVerified,
    proofVerification,
  };
}

/**
 * Parse the URL query into a {@link ListDecisionsQuery}. Only known filters are
 * honored; unknown params are ignored. `limit`, when present, MUST be an integer
 * (else the caller returns 400) — the actual clamping is done by `listDecisions`.
 *
 * @throws {BadRequestError} if `limit` is present but not an integer.
 */
function parseListQuery(params: URLSearchParams): ListDecisionsQuery {
  const query: {
    -readonly [K in keyof ListDecisionsQuery]: ListDecisionsQuery[K];
  } = {};

  const agentId = params.get("agentId");
  if (agentId !== null) query.agentId = agentId;

  const vendorId = params.get("vendorId");
  if (vendorId !== null) query.vendorId = vendorId;

  const outcome = params.get("outcome");
  if (outcome !== null) query.outcome = outcome as DecisionOutcome;

  const status = params.get("status");
  if (status !== null) query.status = status as DecisionStatus;

  const firedRule = params.get("firedRule");
  if (firedRule !== null) query.firedRule = firedRule as RuleId;

  const since = params.get("since");
  if (since !== null) query.since = since;

  const until = params.get("until");
  if (until !== null) query.until = until;

  const cursor = params.get("cursor");
  if (cursor !== null) query.cursor = cursor;

  const limit = params.get("limit");
  if (limit !== null) {
    // Strict integer only — reject "abc", "", "1.5", " 3". listDecisions clamps
    // the numeric value into [1, MAX_LIMIT]; we only gate that it's an integer.
    if (!/^-?\d+$/.test(limit)) {
      throw new BadRequestError("invalid limit");
    }
    query.limit = Number(limit);
  }

  return query;
}

/** A 400 the handler distinguishes from an unknown 500. */
class BadRequestError extends Error {
  readonly detail?: string;
  constructor(detail?: string) {
    super(detail ?? "bad_request");
    this.name = "BadRequestError";
    this.detail = detail;
  }
}

/**
 * Build a read-only ledger bridge HTTP server. The caller controls
 * `listen()`/`close()`; this factory only wires the request handler.
 */
export function createLedgerBridge(options: LedgerBridgeOptions): Server {
  const { db, allowedOrigin } = options;
  const maxUrlLength = options.maxUrlLength ?? DEFAULT_MAX_URL_LENGTH;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    // CORS headers computed once per request. ACAO is set ONLY when the request's
    // Origin exactly equals the single allowed origin — never `*`, never an echo
    // of an arbitrary origin. `Vary: Origin` keeps caches from mixing responses.
    const origin = req.headers.origin;
    const corsHeaders: Record<string, string> = { Vary: "Origin" };
    if (typeof origin === "string" && origin === allowedOrigin) {
      corsHeaders["Access-Control-Allow-Origin"] = allowedOrigin;
    }

    const send = (
      status: number,
      body: unknown,
      extraHeaders: Record<string, string> = {},
    ): void => {
      res.writeHead(status, {
        "Content-Type": JSON_CONTENT_TYPE,
        ...corsHeaders,
        ...extraHeaders,
      });
      res.end(JSON.stringify(body));
    };

    try {
      const url = req.url ?? "";

      // URL length cap — a cheap early guard against pathological requests.
      if (url.length > maxUrlLength) {
        send(414, { error: "uri_too_long" });
        return;
      }

      // Preflight: answer with CORS + allowed methods, no body.
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          ...corsHeaders,
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        });
        res.end();
        return;
      }

      // GET-only API. Everything else is 405 with an Allow header.
      if (req.method !== "GET") {
        send(405, { error: "method_not_allowed" }, { Allow: "GET, OPTIONS" });
        return;
      }

      // Request-size protection: reject any body over the (tiny) cap and drain
      // the stream so the socket isn't left with unread bytes.
      const contentLength = Number(req.headers["content-length"] ?? "0");
      if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
        req.resume(); // consume/discard any incoming body
        send(413, { error: "payload_too_large" });
        return;
      }

      const parsed = new URL(url, "http://localhost");
      const segments = parsed.pathname.split("/").filter((s) => s.length > 0);

      // GET /decisions  and  GET /decisions/:id
      if (segments.length === 1 && segments[0] === "decisions") {
        const query = parseListQuery(parsed.searchParams);
        let result;
        try {
          result = listDecisions(db, query);
        } catch (err) {
          // The one KNOWN 400 from listDecisions: a malformed keyset cursor.
          if (err instanceof Error && err.message.includes("malformed cursor")) {
            send(400, { error: "bad_request", detail: "malformed cursor" });
            return;
          }
          throw err;
        }
        const view: { decisions: DecisionView[]; nextCursor?: string } = {
          decisions: result.decisions.map(toDecisionView),
        };
        if (result.nextCursor !== undefined) view.nextCursor = result.nextCursor;
        send(200, view);
        return;
      }

      if (segments.length === 2 && segments[0] === "decisions" && segments[1] !== undefined) {
        const id = decodeURIComponent(segments[1]);
        const record = getDecision(db, id);
        if (record === undefined) {
          send(404, { error: "not_found" });
          return;
        }
        send(200, toDecisionView(record));
        return;
      }

      send(404, { error: "not_found" });
    } catch (err) {
      // KNOWN client error (bad limit) → 400; everything else is an opaque 500.
      // NEVER write a stack trace, SQL, DB text, or a file path to the response.
      if (err instanceof BadRequestError) {
        const body: { error: string; detail?: string } = { error: "bad_request" };
        if (err.detail !== undefined) body.detail = err.detail;
        send(400, body);
        return;
      }
      send(500, { error: "internal_error" });
    }
  });
}

/**
 * Thin env-driven launcher. Reads `RAMP_DB_PATH`, `RAMP_BRIDGE_ORIGIN`, and
 * `PORT`, opens the ledger, and starts listening. Kept minimal and guarded so
 * that IMPORTING this module never starts a server.
 */
export async function startLedgerBridge(): Promise<Server> {
  const { openLedger, DEFAULT_DB_PATH } = await import("./db.js");
  const dbPath = process.env.RAMP_DB_PATH ?? DEFAULT_DB_PATH;
  const allowedOrigin = process.env.RAMP_BRIDGE_ORIGIN ?? "http://localhost:5173";
  const port = Number(process.env.PORT ?? "8787");

  const db = openLedger(dbPath, { provisionIfEmpty: true });
  const server = createLedgerBridge({ db, allowedOrigin });
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`@ramp/ledger bridge listening on :${port} (origin ${allowedOrigin})`);
  });
  return server;
}

// Only auto-start when executed directly (not when imported).
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // Best-effort launch; a failure prints and exits non-zero.
  startLedgerBridge().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`@ramp/ledger bridge failed to start: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
