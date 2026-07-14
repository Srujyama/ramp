#!/usr/bin/env node
// ============================================================================
// Provable Agent Spend — the GATE (PreToolUse hook) — hook/evaluate.mjs
// ============================================================================
// This is the ONLY enforcement point. The MCP payments tool is an honest,
// non-enforcing stub; policy is decided HERE, out of band, before the tool is
// allowed to run.
//
// Flow (all synchronous, no clock/randomness in the decision path):
//   1. Read the PreToolUse hook payload as JSON on stdin.
//   2. Validate tool_input as a @ramp/shared SpendRequest.
//   3. Pull AUTHORITATIVE facts from @ramp/ledger (vendor_verified,
//      daily_total_so_far, caps, approved + cleared categories) — keyed by the
//      request's ids. The model's free-text narration is NEVER read as a fact.
//   4. translateToFacts() -> Facts, evaluate with @ramp/gate getKernel().
//   5. deny  -> print hookSpecificOutput { permissionDecision: "deny", ... }.
//      allow -> print hookSpecificOutput { permissionDecision: "allow", ... }.
//
// FAIL-CLOSED INVARIANT (crux #1): ANY problem — malformed stdin, a tool_input
// that is not a SpendRequest, an unreachable ledger, a kernel that throws, a
// bad import — results in a DENY payload on stdout AND process.exit(2). We
// NEVER exit 0 on an error path, and we never let a spend through by accident.
// A command hook (not HTTP) is used precisely because it fails closed even
// under --dangerously-skip-permissions.
// ----------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

/**
 * Emit a PreToolUse deny decision and exit non-zero. This is the ONLY error
 * path — every catch funnels here so a failure can never allow a spend.
 * @param {string} reason human-readable deny reason
 * @param {string[]} [firedRules] rule ids that fired, if known
 * @returns {never}
 */
function denyAndExit(reason, firedRules = []) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
      firedRules,
    },
  };
  try {
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch {
    // If even writing failed, the non-zero exit below still fails closed.
  }
  process.exit(2);
}

/** Read all of stdin as a UTF-8 string. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  // ---- 1. read + parse the hook payload --------------------------------
  let payload;
  try {
    const raw = await readStdin();
    payload = JSON.parse(raw);
  } catch {
    denyAndExit("malformed hook payload: stdin was not valid JSON");
    return;
  }

  const toolInput =
    payload && typeof payload === "object" ? payload.tool_input : undefined;

  // ---- 2. load the contract + validate the SpendRequest ----------------
  let shared, gate, ledger;
  try {
    shared = await import("@ramp/shared");
    gate = await import("@ramp/gate");
    ledger = await import("@ramp/ledger");
  } catch (err) {
    denyAndExit(
      "gate misconfigured: could not load policy modules (" +
        errMsg(err) +
        ")",
    );
    return;
  }

  if (typeof shared.isSpendRequest !== "function") {
    denyAndExit("gate misconfigured: @ramp/shared.isSpendRequest missing");
    return;
  }
  if (!shared.isSpendRequest(toolInput)) {
    denyAndExit("rejected: tool_input is not a well-formed SpendRequest");
    return;
  }
  /** @type {import("@ramp/shared").SpendRequest} */
  const req = toolInput;

  // ---- 3. pull AUTHORITATIVE facts from the ledger ---------------------
  //   The fact source reads the DB + vendor registry ONLY. Never narration.
  let db;
  let facts;
  try {
    if (typeof ledger.openLedger !== "function") {
      throw new Error("@ramp/ledger.openLedger missing");
    }
    db = ledger.openLedger();

    const FactSourceCtor = ledger.LedgerFactSource;
    if (typeof FactSourceCtor !== "function") {
      throw new Error("@ramp/ledger.LedgerFactSource missing");
    }
    const factSource = new FactSourceCtor(db);

    if (typeof shared.translateToFacts !== "function") {
      throw new Error("@ramp/shared.translateToFacts missing");
    }
    if (typeof factSource.contextFor !== "function") {
      throw new Error("@ramp/ledger.LedgerFactSource.contextFor missing");
    }
    // Read the AUTHORITATIVE facts from the ledger (pure DB/registry reads,
    // keyed by the request's ids — never the model's narration), then map the
    // structured request ids onto Facts. attestation defaults to false unless
    // the attestation layer supplies one.
    const authoritative = await factSource.contextFor(req);
    facts = shared.translateToFacts(req, authoritative);
  } catch (err) {
    // Unreachable/malformed authoritative source -> fail closed.
    // Best-effort audit of the infrastructure failure: we have `req` and (usually)
    // an open `db`. status:"error", no decision, no fabricated rule — an honest
    // infra row, NOT one of the five policy denies. Never blocks the fail-closed
    // deny below (a failed audit here must not mask the original error).
    try {
      if (db && typeof ledger.recordDecision === "function") {
        ledger.recordDecision(db, {
          decisionId: randomUUID(),
          request: req,
          status: "error",
        });
      }
    } catch {
      /* best-effort; the deny below still fails closed */
    }
    closeQuietly(ledger, db);
    denyAndExit(
      "denied (fail-closed): authoritative fact source unavailable (" +
        errMsg(err) +
        ")",
    );
    return;
  }

  // ---- 4. evaluate with the deterministic kernel -----------------------
  let decision;
  let kernelId;
  try {
    if (typeof gate.getKernel !== "function") {
      throw new Error("@ramp/gate.getKernel missing");
    }
    const described = gate.getKernel();
    kernelId =
      described && typeof described.kind === "string" ? described.kind : undefined;
    const kernel = described && described.kernel ? described.kernel : described;
    if (!kernel || typeof kernel.evaluate !== "function") {
      throw new Error("kernel has no evaluate()");
    }
    decision = kernel.evaluate(facts);
  } catch (err) {
    closeQuietly(ledger, db);
    denyAndExit("denied (fail-closed): kernel failed (" + errMsg(err) + ")");
    return;
  }

  // ---- 4b. PERSIST the audit row (allow OR deny) BEFORE enforcing ------
  //   The hook is the only holder of exact facts+decision, so it is the writer.
  //   A fresh hook-minted UUID is the stable correlation id (no native tool_use_id
  //   exists, and no frozen shape carries one). recordDecision stores facts +
  //   decision VERBATIM and derives status from the decision — it never recomputes
  //   policy or fabricates a rule. A tamper-evident proof is built and persisted
  //   ATOMICALLY with the decision; attestation is reported honestly
  //   (present_unverified when an attestation accompanied the request, else absent
  //   — never "verified", which would require an actual verification result we do
  //   not have here). policy/kernel-version digests we lack stay null, unfabricated.
  //   FAIL-CLOSED: if the audit write throws, we DENY (an un-auditable allow is not
  //   a provable allow). This is an infrastructure deny — the reason says so and NO
  //   fired rule is fabricated, so it is never mislabeled as a policy deny.
  try {
    if (
      typeof ledger.recordDecision === "function" &&
      decision &&
      typeof decision === "object"
    ) {
      const decisionId = randomUUID();
      // Derive INDEPENDENT provenance from trusted execution context only (the
      // structured request, the AUTHORITATIVE facts, the decision, the kernel id).
      // The graph is DERIVED here — never accepted from the agent — and folded into
      // the proof hash by buildProof (which validates it first). If provenance
      // construction is unavailable OR the graph is invalid, buildProof throws and
      // this whole block fails closed below, exactly like an audit-write failure —
      // an un-provable allow is never persisted as an incomplete proof.
      let provenance;
      if (typeof ledger.buildDecisionProvenance === "function") {
        provenance = ledger.buildDecisionProvenance({
          request: req,
          decision,
          facts,
          kernelId,
        });
      }
      let proof;
      if (typeof ledger.buildProof === "function") {
        proof = ledger.buildProof({
          decisionId,
          request: req,
          decision,
          facts,
          kernelId,
          attestation: {
            status:
              facts && facts.attestation_present ? "present_unverified" : "absent",
          },
          provenance,
        });
      }
      ledger.recordDecision(db, {
        decisionId,
        request: req,
        facts,
        decision,
        kernelId,
        proof,
      });
    }
  } catch (err) {
    closeQuietly(ledger, db);
    denyAndExit(
      "denied (fail-closed): could not persist audit record (" + errMsg(err) + ")",
    );
    return;
  } finally {
    closeQuietly(ledger, db);
  }

  // ---- 5. render the decision ------------------------------------------
  if (!decision || typeof decision !== "object") {
    denyAndExit("denied (fail-closed): kernel returned no decision");
    return;
  }

  const firedRules = Array.isArray(decision.firedRules)
    ? decision.firedRules
    : [];
  const reasons = Array.isArray(decision.reasons) ? decision.reasons : [];

  if (decision.decision === "allow") {
    const out = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason:
          reasons.length > 0
            ? reasons.join("; ")
            : "allow: every policy condition held",
        firedRules,
      },
    };
    process.stdout.write(JSON.stringify(out) + "\n");
    process.exit(0);
    return;
  }

  // Any non-allow (including an explicit deny) fails closed.
  denyAndExit(
    reasons.length > 0
      ? "denied: " + reasons.join("; ")
      : "denied by policy",
    firedRules,
  );
}

/** Best-effort close of the ledger handle; never throws. */
function closeQuietly(ledger, db) {
  try {
    if (ledger && typeof ledger.closeLedger === "function" && db) {
      ledger.closeLedger(db);
    } else if (db && typeof db.close === "function") {
      db.close();
    }
  } catch {
    // ignore — closing must never turn an allow into a crash or vice versa.
  }
}

/** Extract a short message from an unknown thrown value. */
function errMsg(err) {
  if (err && typeof err === "object" && "message" in err) {
    return String(err.message);
  }
  return String(err);
}

// Top-level guard: absolutely nothing escapes without failing closed.
main().catch((err) => {
  denyAndExit("denied (fail-closed): unhandled error (" + errMsg(err) + ")");
});
