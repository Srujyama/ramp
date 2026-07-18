/**
 * @ramp/control-plane — the DEMO CONTROL PLANE (NOT the audit bridge, NOT the gate)
 *
 * ============================================================================
 * WHAT THIS IS, AND ITS CONSTITUTION
 * ============================================================================
 * A separate, clearly-labeled, DEMO-ONLY process (its own port, default 8788),
 * distinct from both the fail-closed enforcement hook and the READ-ONLY audit
 * bridge (:8787). It exists so the dashboard demo can be interactive without
 * making the audit console able to write. Its hard rules:
 *
 *   1. It NEVER writes a decision record. To "run a transaction" it drives the
 *      REAL `requestPurchase` lifecycle (via @ramp/client) — the kernel decides,
 *      both proofs are sealed, the row is hash-chained. A simulated transaction
 *      is a REAL gated decision (allow or deny), not a fabricated row.
 *   2. It NEVER decides. It only administers INPUT tables (agents, dials, budgets,
 *      vendors) and triggers the real gate.
 *   3. External network (live pricing) lives HERE, out of band — never on the
 *      enforcement path. The hook and kernel stay network-free and deterministic.
 *   4. Separate process/port: if this crashes, the enforcement hook is unaffected
 *      (it can't fail-open something it never depended on).
 *
 * Phase 1 surface: read-only pricing (GET /pricing, GET /health) + a background
 * refresh job. Later phases add POST /transaction (drives requestPurchase), and
 * typed admin writes to input tables — each documented against the constitution.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { LedgerDb } from "@ramp/ledger";
import { listModelPricing } from "@ramp/ledger";
import type { RampClient } from "@ramp/client";
import { refreshPricing } from "./pricing.js";
import { parseIntent, runTransaction } from "./transactions.js";
import { adminState, runCreateAgent, runUpdateDials } from "./admin.js";
import { listPending, listApprovers, runResolve } from "./approvals.js";
import { chainStatus, makeReceipt, checkReceipt } from "./integrity.js";
import { runSetDemoData } from "./demo.js";

/** What the control-plane request handler needs: the ledger + the real gate driver. */
export interface ControlPlaneDeps {
  readonly db: LedgerDb;
  /** Drives the REAL requestPurchase lifecycle. The control plane never decides itself. */
  readonly ramp: RampClient;
}

/** Read a JSON request body up to a small cap. Rejects oversized/malformed bodies. */
async function readJsonBody(req: IncomingMessage, maxBytes = 16 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) {
      req.destroy();
      throw new Error("payload too large");
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  return JSON.parse(raw);
}

/** The demo dashboard origin allowed to call this plane. `*` for local demos. */
const ALLOW_ORIGIN = process.env.RAMP_CONTROL_PLANE_ORIGIN ?? "*";

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  cors(res);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body) + "\n");
}

/**
 * Build the control-plane request handler over an open ledger. Pure wiring — does
 * NOT open/close the DB or call listen(); importing this never starts a server.
 */
export function createControlPlane(deps: ControlPlaneDeps): Server {
  const { db, ramp } = deps;
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch(() => {
      // A handler that threw before responding — fail closed with a 500, never a stack.
      if (!res.headersSent) json(res, 500, { error: "internal_error", plane: "demo-control-plane" });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (method === "OPTIONS") {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    // Liveness — also states plainly what this process is.
    if (method === "GET" && path === "/health") {
      json(res, 200, { ok: true, plane: "demo-control-plane", note: "demo-only; not the audit bridge, not the gate" });
      return;
    }

    // Read-only pricing reference (informational; never a fact).
    if (method === "GET" && path === "/pricing") {
      const prices = listModelPricing(db);
      json(res, 200, {
        prices,
        count: prices.length,
        // Freshness the UI can label: the newest fetched_at across rows.
        refreshedAt: prices.reduce((max, p) => (p.fetchedAt > max ? p.fetchedAt : max), ""),
      });
      return;
    }

    // POST /transaction — drive a REAL gated decision through requestPurchase. The
    // control plane supplies only the untrusted intent; the kernel decides, the
    // decision is recorded + hash-chained, and it appears live on the dashboard.
    if (method === "POST" && path === "/transaction") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        json(res, 400, { error: "request body must be small, well-formed JSON" });
        return;
      }
      const intent = parseIntent(body);
      if ("error" in intent) {
        json(res, 400, { error: intent.error });
        return;
      }
      const result = await runTransaction(ramp, db, intent, Date.now());
      json(res, 200, result);
      return;
    }

    // GET /admin/state — the current dials + approved categories the admin UI needs.
    if (method === "GET" && path === "/admin/state") {
      json(res, 200, adminState(db));
      return;
    }

    // GET /chain/head — current chain head + length + an internal-consistency walk.
    if (method === "GET" && path === "/chain/head") {
      json(res, 200, chainStatus(db));
      return;
    }

    // GET /chain/receipt — a SIGNED head receipt to publish off-box. Read-only.
    if (method === "GET" && path === "/chain/receipt") {
      json(res, 200, makeReceipt(db, new Date().toISOString()));
      return;
    }

    // POST /chain/verify — prove a previously-published receipt is still a PREFIX
    // of today's chain (catches a self-consistent full rewrite / truncation).
    if (method === "POST" && path === "/chain/verify") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        json(res, 400, { error: "request body must be a small, well-formed head receipt" });
        return;
      }
      const out = checkReceipt(db, body);
      if ("error" in out) {
        json(res, 400, out);
        return;
      }
      json(res, 200, out);
      return;
    }

    // GET /approvals — the queue of held (escalated) decisions still awaiting a
    // human, plus the demo approvers a viewer may act as. Read-only.
    if (method === "GET" && path === "/approvals") {
      json(res, 200, { pending: listPending(db), approvers: listApprovers() });
      return;
    }

    // POST /approvals — HUMAN CHANNEL. Resolve a held decision as a chosen demo
    // approver: mints a real Ed25519-signed approval bound to the decision's digest
    // and records it. Never an MCP path; never writes a decision.
    if (method === "POST" && path === "/approvals") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        json(res, 400, { error: "request body must be small, well-formed JSON" });
        return;
      }
      const out = runResolve(db, body, new Date().toISOString());
      if ("error" in out) {
        json(res, 400, out);
        return;
      }
      json(res, 201, out);
      return;
    }

    // POST /agents — register a new agent + its clearances (INPUT tables only).
    // Never writes a decision; changes what the NEXT decision for this agent will be.
    if (method === "POST" && path === "/agents") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        json(res, 400, { error: "request body must be small, well-formed JSON" });
        return;
      }
      const out = runCreateAgent(db, body);
      if ("error" in out) {
        json(res, 400, out);
        return;
      }
      json(res, 201, out);
      return;
    }

    // PATCH /policy — retune the org policy dials (single-row policy_limits only).
    // Never writes a decision; changes what EVERY subsequent decision is measured against.
    if (method === "PATCH" && path === "/policy") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        json(res, 400, { error: "request body must be small, well-formed JSON" });
        return;
      }
      const out = runUpdateDials(db, body);
      if ("error" in out) {
        json(res, 400, out);
        return;
      }
      json(res, 200, out);
      return;
    }

    // POST /demo/data — the "Enable Dummy Data" toggle (Admin tab). Populates or
    // clears ~90 days of synthetic-but-kernel-derived decision history. Never
    // writes a decision the kernel didn't itself produce; see demo.ts.
    if (method === "POST" && path === "/demo/data") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        json(res, 400, { error: "request body must be small, well-formed JSON" });
        return;
      }
      const out = runSetDemoData(db, body);
      if ("error" in out) {
        json(res, 400, out);
        return;
      }
      json(res, 200, out);
      return;
    }

    json(res, 404, { error: "not found", plane: "demo-control-plane" });
  }
}

/**
 * Entry point: open the ledger (STRICT — never auto-provision on the demo write
 * path either), start the pricing refresh loop, and listen. Importing this module
 * does nothing; only calling main() starts a server.
 */
export async function main(): Promise<void> {
  const { openLedgerStrict, closeLedger } = await import("@ramp/ledger");
  const { createRampClient } = await import("@ramp/client");
  const port = Number(process.env.CONTROL_PLANE_PORT ?? 8788);
  const db = openLedgerStrict();
  // The real gate driver. Writes to the SAME ledger (DEFAULT_DB_PATH) the bridge
  // reads, so UI-triggered transactions are real, recorded, and appear live.
  const ramp = createRampClient();

  // Seed static pricing + attempt a live refresh now, then on an interval. All
  // off the enforcement path; failures are logged, never fatal.
  const refresh = async () => {
    try {
      const r = await refreshPricing(db, new Date().toISOString());
      // eslint-disable-next-line no-console
      console.error(`[control-plane] pricing: ${r.count} model(s), source=${r.source}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[control-plane] pricing refresh failed (kept last-good): ${(err as Error).message}`);
    }
  };
  await refresh();
  const REFRESH_MS = Number(process.env.RAMP_PRICING_REFRESH_MS ?? 15 * 60 * 1000);
  const loop = setInterval(refresh, REFRESH_MS);

  const server = createControlPlane({ db, ramp });
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.error(
      `[control-plane] DEMO control plane on http://localhost:${port} — NOT the audit bridge, NOT the gate.\n` +
        `[control-plane]   GET /health · GET /pricing · POST /transaction · GET /admin/state · POST /agents · PATCH /policy · POST /demo/data · GET/POST /approvals`,
    );
  });

  const shutdown = () => {
    clearInterval(loop);
    server.close();
    ramp.close();
    closeLedger(db);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Start only when run directly (not when imported by a test).
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[control-plane] fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}
