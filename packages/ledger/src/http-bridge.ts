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
  tailDecisions,
  latestDecisionSeq,
  type DecisionRecord,
  type ListDecisionsQuery,
} from "./decision-log.js";
import type { DecisionOutcome, RuleId, PolicyKernel } from "@ramp/shared";
import { getKernel } from "@ramp/gate";
import type { DecisionStatus } from "./decision-log.js";
import type { ProvenanceGraph } from "./provenance.js";
// SEAM: independent proof re-verification lives in its own module (Agent B).
import { verifyDecisionProof, type DecisionProofVerification } from "./proof-verification.js";
// SEAM: the read-only Policy Simulator (no persistence, no execution).
import { simulate } from "./simulate.js";

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
  /**
   * OPTIONAL policy kernel for the read-only `/simulate` route. When omitted, the
   * simulator defaults to `getKernel().kernel`. Injectable so tests can pin the
   * reference kernel.
   */
  readonly kernel?: PolicyKernel;
  /** How often the `/events` SSE tail polls for new decisions, ms. Default `EVENTS_POLL_MS`. */
  readonly eventsPollMs?: number;
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

/** How often the SSE tail polls the append-only log for new decisions. */
const EVENTS_POLL_MS = Number(process.env.RAMP_EVENTS_POLL_MS ?? 800);

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

/**
 * Parse + validate the `/simulate` query into a {@link SimulationInput}. All of
 * `agent`, `vendor`, `amount`, `category` are REQUIRED; `currency` is optional.
 * `amount` MUST be an integer (whole currency units) — anything else is a 400.
 *
 * @throws {BadRequestError} on a missing required param or a non-integer amount.
 */
function parseSimulateQuery(params: URLSearchParams): {
  agent: string;
  vendor: string;
  amount: number;
  category: string;
  currency?: string;
} {
  const agent = params.get("agent");
  const vendor = params.get("vendor");
  const amountRaw = params.get("amount");
  const category = params.get("category");
  const currency = params.get("currency");

  if (agent === null || agent === "") throw new BadRequestError("missing agent");
  if (vendor === null || vendor === "") throw new BadRequestError("missing vendor");
  if (category === null || category === "") throw new BadRequestError("missing category");
  if (amountRaw === null || amountRaw === "") throw new BadRequestError("missing amount");

  // Strict integer only (whole currency units) — reject "abc", "", "1.5", " 3".
  if (!/^-?\d+$/.test(amountRaw)) {
    throw new BadRequestError("invalid amount");
  }
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount)) {
    throw new BadRequestError("invalid amount");
  }

  const input: {
    agent: string;
    vendor: string;
    amount: number;
    category: string;
    currency?: string;
  } = { agent, vendor, amount, category };
  if (currency !== null && currency !== "") input.currency = currency;
  return input;
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
  const eventsPollMs = options.eventsPollMs ?? EVENTS_POLL_MS;

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

      // GET /simulate — READ-ONLY policy preview. Persists nothing, executes
      // nothing; it reuses the real kernel over authoritative DB reads.
      if (segments.length === 1 && segments[0] === "simulate") {
        const input = parseSimulateQuery(parsed.searchParams);
        let result;
        try {
          result =
            options.kernel !== undefined
              ? simulate(db, input, options.kernel)
              : simulate(db, input);
        } catch (err) {
          // simulate() throws on an invalid amount (e.g. negative) → 400.
          if (err instanceof Error) {
            send(400, { error: "bad_request", detail: "invalid amount" });
            return;
          }
          throw err;
        }
        send(200, result);
        return;
      }

      // GET /events — a real-time Server-Sent-Events TAIL of the append-only log.
      //
      // Read-only by construction: SSE is a GET returning `text/event-stream`; it
      // adds ZERO write capability and rides the same 405/413/CORS guards. It polls
      // the log for rows with `seq` beyond what this client has seen and streams the
      // SAME `DecisionView` payload as `GET /decisions`. Resumable: the browser's
      // auto-sent `Last-Event-ID` (or `?lastSeq=`) tells us where to continue, so a
      // reconnect never drops or duplicates a decision. This never decides, never
      // writes — it only lets the read-only dashboard update without a manual reload.
      if (segments.length === 1 && segments[0] === "events") {
        const headerLast = req.headers["last-event-id"];
        const queryLast = parsed.searchParams.get("lastSeq");
        // Careful: `Number("")` is 0, not NaN — an empty cursor must NOT be read as
        // "replay from seq 0" (the whole log). Only parse when a value is present.
        const rawLast = typeof headerLast === "string" ? headerLast : queryLast;
        const parsedLast = rawLast != null && rawLast !== "" ? Number(rawLast) : Number.NaN;
        // No cursor supplied → tail only NEW decisions from the current head.
        let lastSeq = Number.isFinite(parsedLast) && parsedLast >= 0 ? parsedLast : latestDecisionSeq(db);

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no", // disable proxy buffering if one sits in front
          ...corsHeaders,
        });
        res.write("retry: 2000\n"); // client reconnect backoff
        res.write(": connected\n\n");

        const tick = (): void => {
          try {
            const rows = tailDecisions(db, lastSeq);
            for (const { seq, record } of rows) {
              res.write(`id: ${seq}\nevent: decision\ndata: ${JSON.stringify(toDecisionView(record))}\n\n`);
              lastSeq = seq;
            }
            res.write(": hb\n\n"); // heartbeat keeps the connection (and proxies) alive
          } catch {
            /* a transient read error must not tear down the stream */
          }
        };
        const interval = setInterval(tick, eventsPollMs);
        req.on("close", () => clearInterval(interval));
        return; // keep the connection open — do NOT call send()
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
  // Delegate to resolveDbPath() rather than re-deriving `$RAMP_DB_PATH` here —
  // a second copy of that precedence logic already drifted once (see
  // resolveDbPath's own doc comment for the empty-string fail-open shape it
  // guards against).
  const { openLedger, resolveDbPath } = await import("./db.js");
  const dbPath = resolveDbPath();
  const allowedOrigin = process.env.RAMP_BRIDGE_ORIGIN ?? "http://localhost:5173";
  const port = Number(process.env.PORT ?? "8787");

  const db = openLedger(dbPath, { provisionIfEmpty: true });
  const server = createLedgerBridge({ db, allowedOrigin, kernel: getKernel().kernel });
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
