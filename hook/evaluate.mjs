#!/usr/bin/env node
// ============================================================================
// Provable Agent Spend — the GATE (PreToolUse hook) — hook/evaluate.mjs
// ============================================================================
// This is the ONLY enforcement point. The MCP payments tool is an honest,
// non-enforcing stub; policy is decided HERE, out of band, before the tool is
// allowed to run.
//
// All four pillars meet in this file, in this order:
//
//   1. QUARANTINE (@ramp/quarantine) — the invoice document and invoiceRef are
//      attacker-authored prose. They are wrapped at the boundary and can never
//      be coerced into a string, a log line, or a fact. The only way anything
//      escapes is a total declassifier into a bounded codomain.
//   2. ATTESTATION (@ramp/attestation) — the attestation blob is verified
//      against a trusted notary keyring AND checked to bind to THIS payment
//      (invoice digest, the vendor's REGISTERED domain, amount, currency,
//      freshness). Only the resulting boolean becomes a fact.
//   3. AUTHORITATIVE FACTS (@ramp/ledger) — every gating fact is a DB read keyed
//      by the request's identity fields. Nothing is copied out of the request.
//   4. KERNEL (@ramp/gate) — pure, deterministic, deny-dominates.
//
// ...and then TWO complementary records are written, which is deliberate:
//
//   - @ramp/provenance seals a portable BUNDLE (decision + facts + where every
//     fact came from). Its verifier re-runs the kernel on the recorded facts and
//     checks the verdict falls out — SOUNDNESS. An auditor can check it with
//     nothing but the file and a kernel of their own.
//   - @ramp/ledger persists a decision row + a tamper-evident LedgerProof, which
//     recomputes its own id from its content — INTEGRITY. This is the
//     operational store the dashboard reads, and it is what makes an allow
//     auditable after the fact.
//
// Integrity ("the record was not altered") and soundness ("the decision follows
// from the facts") are different guarantees. We want both, so we keep both.
//
// FAIL-CLOSED INVARIANT (crux #1): ANY problem — malformed stdin, a tool_input
// that is not a SpendRequest, an unreachable ledger, a kernel that throws, a
// failed audit write, a bad import — results in a DENY payload on stdout AND
// process.exit(2). We NEVER exit 0 on an error path. A command hook (not HTTP)
// is used precisely because it fails closed even under
// --dangerously-skip-permissions.
//
// NOTE ON THE CLOCK: this file reads Date.now() and passes it in to the
// attestation layer. That is deliberate and it is the ONLY clock read on the
// decision path. The kernel never sees a clock — it sees `attestation_present`,
// a boolean. Fact-gathering is allowed to read the world (a DB, a clock);
// deciding is not. That split is what keeps "same Facts -> same Decision" true.
// ----------------------------------------------------------------------------
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
  let shared, gate, ledger, quarantine, attestationLib, provenanceLib;
  try {
    shared = await import("@ramp/shared");
    gate = await import("@ramp/gate");
    ledger = await import("@ramp/ledger");
    quarantine = await import("@ramp/quarantine");
    attestationLib = await import("@ramp/attestation");
    provenanceLib = await import("@ramp/provenance");
  } catch (err) {
    denyAndExit(
      "gate misconfigured: could not load policy modules (" + errMsg(err) + ")",
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

  // ---- 3. PILLAR 3: quarantine the untrusted prose ---------------------
  // The invoice document and the invoiceRef are attacker-authored. From here on
  // they are opaque: any attempt to interpolate, log, or serialise them throws.
  const qDocument = quarantine.quarantine(req.invoiceDocument ?? "", "invoice_text");
  const qRef = quarantine.quarantine(req.invoiceRef ?? "", "tool_input_field");

  // Telemetry ONLY — this gates nothing. It exists so the demo can say "we saw
  // the attack and it changed nothing." If it returned false for a real attack,
  // every guarantee below would be unchanged.
  const scan = quarantine.scanForInjection(qDocument);
  const refScan = quarantine.scanForInjection(qRef);

  // Declassify the invoiceRef into `request_id` through a bounded codomain.
  // An injection payload has spaces and punctuation, so it cannot pass
  // asIdentifier's alphabet — and when it can't, we fall back to a DIGEST rather
  // than dropping the reference. That keeps the audit trail able to say "this
  // request carried a reference, here is its fingerprint" without ever letting
  // the bytes reach a human reviewer or a downstream model as text.
  const refAsIdentifier = quarantine.declassify(qRef, quarantine.asIdentifier(64));
  const refAsDigest = quarantine.declassify(qRef, quarantine.asDigest());
  const requestId = refAsIdentifier.ok
    ? refAsIdentifier.value
    : `ref_digest_${String(refAsDigest.ok ? refAsDigest.value : "unknown").slice(0, 16)}`;
  const requestIdRecord = refAsIdentifier.ok ? refAsIdentifier.record : refAsDigest.record;

  // ---- 4. open the AUTHORITATIVE fact store ----------------------------
  let db;
  let factSource;
  try {
    if (typeof ledger.openLedgerStrict !== "function") {
      throw new Error("@ramp/ledger.openLedgerStrict missing");
    }
    // STRICT on the enforcement path: never auto-provision, and throw unless the
    // fact store is genuinely populated. `openLedger()` would happily create and
    // seed a brand-new DB if this path were wrong — a pristine ledger reports
    // zero spend today, i.e. a full fresh daily budget, i.e. fail-OPEN.
    db = ledger.openLedgerStrict();
    factSource = new ledger.LedgerFactSource(db);
  } catch (err) {
    // Opening the ledger is what failed, so there is no db to audit into.
    closeQuietly(ledger, db);
    denyAndExit(
      "denied (fail-closed): authoritative fact source unavailable (" + errMsg(err) + ")",
    );
    return;
  }

  try {
    // ---- 4.5. AUTHENTICATE THE CALLER (before the id is trusted) --------
    // `requestingAgent` is untrusted transport — any process can name any agent.
    // If this agent has a PUBLIC key registered in the ledger, the request MUST
    // carry a valid Ed25519 signature by the matching private key, verified HERE
    // before the id is used to look anything up. This closes the impersonation
    // hole: claiming an id you were not issued a key for buys nothing. Agents with
    // no registered key are legacy (unauthenticated) — issuing a key turns this on.
    // Fail-closed: a missing/forged/stale signature, or an unusable registry key,
    // denies. Modelled on the attestation precondition; only the boolean matters.
    const agentPubkey = factSource.getAgentPublicKey(req.requestingAgent);
    let agentAuth = { authenticated: null, keyId: null };
    if (agentPubkey) {
      let agentPublicKey;
      try {
        agentPublicKey = attestationLib.agentPublicKeyFromRegistry(agentPubkey);
      } catch (err) {
        closeQuietly(ledger, db);
        denyAndExit("denied (fail-closed): agent registry key unusable (" + errMsg(err) + ")");
        return;
      }
      agentAuth = attestationLib.verifyAgentRequest(req, req.agentSignature, {
        publicKey: agentPublicKey,
        now: Date.now(),
      });
      if (agentAuth.authenticated !== true) {
        closeQuietly(ledger, db);
        denyAndExit(
          "deny/agent_unauthenticated: " +
            agentAuth.reason +
            " (caller cannot prove it is " +
            req.requestingAgent +
            ")",
          ["agent_unauthenticated"],
        );
        return;
      }
    }

    // ---- 5. PILLAR 4: verify the attestation ---------------------------
    // The vendor's registered domain comes from the LEDGER, not the attestation.
    // That is the whole point: an attestation proves "these bytes came from
    // domain X"; only the registry can say whether X is who we think Acme is.
    const registeredDomain = factSource.getVendorDomain(req.vendorId);

    // Digest the quarantined document WITHOUT declassifying it to text: asDigest
    // is a total declassifier whose codomain is hex strings, so no invoice bytes
    // survive into the fact.
    const docDigest = quarantine.declassify(qDocument, quarantine.asDigest());
    const invoiceDigest = docDigest.ok ? docDigest.value : "";

    const attestationResult = attestationLib.verifyAttestation(req.attestation, {
      keyring: attestationLib.demoKeyring(),
      expect: {
        invoiceDigest,
        registeredDomain,
        amount: req.amount,
        currency: req.currency,
      },
      // The one clock read on the decision path. See the file header.
      now: Date.now(),
    });

    // ---- 6. AUTHORITATIVE facts + their provenance ---------------------
    const ctx = {
      request: req,
      attestationPresent: attestationResult.verified === true,
    };
    const { facts: authoritative, provenance: ledgerProvenance } =
      factSource.contextWithProvenance(ctx);

    const facts = shared.translateToFacts(req, authoritative, { requestId });

    // ---- 7. PILLAR 1: the deterministic kernel -------------------------
    const described = gate.getKernel();
    const kernelId =
      described && typeof described.kind === "string" ? described.kind : undefined;
    const kernel = described && described.kernel ? described.kernel : described;
    if (!kernel || typeof kernel.evaluate !== "function") {
      throw new Error("kernel has no evaluate()");
    }
    const decision = kernel.evaluate(facts);
    if (!decision || typeof decision !== "object") {
      throw new Error("kernel returned no decision");
    }

    // ---- 8. PILLAR 2: seal a portable, re-derivable bundle -------------
    // Each producer records the facts IT sourced: the ledger recorded its six
    // (with the exact SQL it ran); the five identity keys and the attestation
    // verdict are recorded here, by the code that produced them.
    const provenance = [
      {
        fact: "request_id",
        value: facts.request_id,
        source: "tool_args",
        derivation: {
          kind: "declassified",
          contentId: requestIdRecord.contentId,
          declassifier: requestIdRecord.declassifier,
          codomain: requestIdRecord.codomain.description,
          admitted: requestIdRecord.admitted,
        },
      },
      structuredArg("requesting_agent", facts.requesting_agent, "requestingAgent"),
      structuredArg("amount", facts.amount, "amount"),
      structuredArg("vendor", facts.vendor, "vendorId"),
      structuredArg("category", facts.category, "category"),
      ...ledgerProvenance,
      {
        fact: "attestation_present",
        value: facts.attestation_present,
        source: "attestation",
        derivation: {
          kind: "attestation",
          notaryKeyId: attestationResult.verified ? attestationResult.notaryKeyId : "none",
          statementDigest: attestationResult.verified
            ? provenanceLib.digest(attestationResult.statement)
            : "0".repeat(64),
          verified: attestationResult.verified === true,
        },
      },
    ];

    const sealed = provenanceLib.buildBundle({
      requestId: facts.request_id,
      facts,
      provenance,
      decision,
      kernel: { kind: kernelId ?? "reference" },
      evaluatedAt: new Date().toISOString(),
    });

    // SIGN the sealed bundle. Re-derivation already catches an EDITED bundle —
    // you cannot reseal your way out of arithmetic. It cannot catch a FABRICATED
    // one: a forger who writes a new, internally coherent bundle passes every
    // check, because nothing is wrong with it except that it never happened.
    // The signature is what says "the gate produced this", and it separates disk
    // compromise (stopped) from gate compromise (not stopped — they'd have the
    // key). Audit artifacts get copied, synced and archived far more widely than
    // the process that made them, and every copy is a place to tamper.
    const bundle = {
      ...sealed,
      gateSignature: provenanceLib.signBundleDigest(
        sealed.bundleDigest,
        provenanceLib.demoGatePrivateKey(),
        provenanceLib.DEMO_GATE_KEY_ID,
      ),
    };

    // Best-effort: failing to write the PORTABLE bundle must not move the
    // decision. It is a convenience artifact for the auditor CLI; the ledger row
    // below is the authoritative audit record, and THAT one fails closed.
    const bundleWrite = writeBundle(bundle);

    // ---- 9. PERSIST the audit row (allow OR deny) BEFORE enforcing ------
    //   The hook is the only holder of exact facts+decision, so it is the writer.
    //   recordDecision stores facts + decision VERBATIM and derives status from
    //   the decision — it never recomputes policy or fabricates a rule. The proof
    //   is built and persisted ATOMICALLY with the decision.
    //
    //   FAIL-CLOSED: if the audit write throws, we DENY. An un-auditable allow is
    //   not a provable allow. This is an infrastructure deny — the reason says so
    //   and NO fired rule is fabricated, so it is never mislabeled as policy.
    try {
      if (typeof ledger.recordDecision === "function") {
        const decisionId = randomUUID();
        // Derive INDEPENDENT provenance from trusted execution context only (the
        // structured request, the AUTHORITATIVE facts, the decision, the kernel
        // id). The graph is DERIVED here — never accepted from the agent.
        let ledgerProvGraph;
        if (typeof ledger.buildDecisionProvenance === "function") {
          ledgerProvGraph = ledger.buildDecisionProvenance({
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
            // PILLAR 4 CLOSES THIS HOLE. This was pinned at "present_unverified"
            // with the honest note that "verified" would require a real
            // verification result we did not have. We have one now:
            // @ramp/attestation ran the signature and binding checks above, so we
            // report its ACTUAL verdict.
            attestation: attestationStatusOf(req, attestationResult),
            provenance: ledgerProvGraph,
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
    }

    closeQuietly(ledger, db);

    // ---- 10. render the decision ---------------------------------------
    const firedRules = Array.isArray(decision.firedRules) ? decision.firedRules : [];
    const reasons = Array.isArray(decision.reasons) ? decision.reasons : [];

    // Narrate the injection telemetry, so the demo can show it was seen and was
    // irrelevant. Content-free by construction: labels and digests only.
    const notes = [];
    if (scan.suspicious || refScan.suspicious) {
      const markers = [...scan.markers, ...refScan.markers].map((m) => m.marker);
      notes.push(
        `[telemetry] injection markers seen (${[...new Set(markers)].join(", ")}) ` +
          `and ignored — the decision does not consult them`,
      );
    }
    if (attestationResult.verified === false) {
      notes.push(`[attestation] ${attestationResult.code}: ${attestationResult.reason}`);
    }
    if (agentPubkey) {
      notes.push(`[identity] caller authenticated as ${req.requestingAgent} via ${agentAuth.keyId}`);
    }
    if (bundleWrite.error) {
      notes.push(`[provenance] bundle not persisted: ${bundleWrite.error}`);
    } else {
      notes.push(
        `[provenance] bundle ${bundle.bundleDigest.slice(0, 12)}… -> ${bundleWrite.path}`,
      );
    }

    const suffix = notes.length ? " | " + notes.join(" | ") : "";

    if (decision.decision === "allow") {
      const out = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason:
            (reasons.length > 0
              ? reasons.join("; ")
              : "allow: every policy condition held") + suffix,
          firedRules,
        },
      };
      process.stdout.write(JSON.stringify(out) + "\n");
      process.exit(0);
      return;
    }

    // ---- ESCALATE -> "ask": the payment is HELD until a human says yes -------
    //
    // EXIT 0, NOT 2. Exit 2 is the blocking-deny channel; returning it here
    // would turn "a human must approve this" into "denied", and the third
    // outcome would never reach anybody. `ask` is delivered as JSON on stdout
    // with a zero exit, exactly like `allow`.
    //
    // The reason this is a real control and not a suggestion: `ask` STILL
    // PROMPTS under --dangerously-skip-permissions. The bypass flag skips the
    // normal permission flow; an explicit `ask` from a hook is not skipped. So
    // human-in-the-loop is as non-bypassable as the deny is — the model cannot
    // talk its way past it, and neither can a flag.
    //
    // Nothing is executed here and nothing is recorded as allowed: the ledger row
    // is status 'escalated'. A held payment is not a made one.
    if (decision.decision === "escalate") {
      const out = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason:
            (reasons.length > 0
              ? "HELD for human approval: " + reasons.join("; ")
              : "HELD for human approval") + suffix,
          firedRules,
        },
      };
      process.stdout.write(JSON.stringify(out) + "\n");
      process.exit(0);
      return;
    }

    // Anything that is not an explicit allow or escalate denies. Stated as a
    // fall-through on purpose: an outcome this hook does not recognise must fail
    // CLOSED, not sail past a `=== "deny"` check that does not match it.
    denyAndExit(
      (reasons.length > 0 ? "denied: " + reasons.join("; ") : "denied by policy") + suffix,
      firedRules,
    );
  } catch (err) {
    // Infrastructure failure AFTER the ledger opened. Best-effort audit row so an
    // operator can see the gate failed here: status "error", no decision, no
    // fabricated rule — an honest infra row, NOT one of the policy denies. It can
    // never mask the fail-closed deny below.
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
    denyAndExit("denied (fail-closed): " + errMsg(err));
  }
}

/**
 * Map @ramp/attestation's verdict onto the ledger proof's AttestationStatus.
 *
 * The four statuses are honest and distinct, and the distinction matters to
 * whoever reads the audit trail:
 *   - absent               — no attestation accompanied the request at all.
 *   - verified             — signature AND binding checks passed.
 *   - verification_failed  — one WAS presented and it did not verify. A different,
 *                            louder fact than "absent": somebody tried.
 *   - present_unverified   — an attestation exists but nothing checked it. We
 *                            never emit this now that pillar 4 exists. It stays in
 *                            the enum because proofs written BEFORE pillar 4
 *                            legitimately carry it, and rewriting history to claim
 *                            they were verified is exactly the lie this repo is
 *                            about not telling.
 */
function attestationStatusOf(req, result) {
  if (req.attestation === undefined || req.attestation === null) {
    return { status: "absent" };
  }
  if (result && result.verified === true) {
    return { status: "verified", provider: "tlsnotary-style" };
  }
  return { status: "verification_failed", provider: "tlsnotary-style" };
}

/** Provenance entry for a fact copied verbatim from a structured tool arg. */
function structuredArg(fact, value, field) {
  return {
    fact,
    value,
    source: "tool_args",
    derivation: { kind: "structured_arg", field },
  };
}

/**
 * Persist a portable decision bundle as JSON. Never throws — see the call site
 * for why a write failure must not move the decision either way.
 */
function writeBundle(bundle) {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = process.env.RAMP_BUNDLE_DIR ?? join(here, "..", ".ramp", "bundles");
    mkdirSync(dir, { recursive: true });
    // Content-addressed filename: the same decision always lands in the same
    // place, so replaying a scenario cannot silently fork the audit trail.
    const path = join(dir, `${bundle.bundleDigest.slice(0, 16)}.json`);
    writeFileSync(path, JSON.stringify(bundle, null, 2) + "\n", "utf8");
    return { path, error: null };
  } catch (err) {
    return { path: null, error: errMsg(err) };
  }
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
