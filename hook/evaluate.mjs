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
// ...and then PROVENANCE (@ramp/provenance) seals a bundle recording the
// decision, the facts, and where each fact came from — so an auditor can
// re-derive the verdict without trusting this process at all.
//
// FAIL-CLOSED INVARIANT (crux #1): ANY problem — malformed stdin, a tool_input
// that is not a SpendRequest, an unreachable ledger, an unverifiable
// attestation, a kernel that throws, a bad import — results in a DENY payload on
// stdout AND process.exit(2). We NEVER exit 0 on an error path, and we never let
// a spend through by accident. A command hook (not HTTP) is used precisely
// because it fails closed even under --dangerously-skip-permissions.
//
// NOTE ON THE CLOCK: this file reads Date.now() and passes it in to the
// attestation layer. That is deliberate and it is the ONLY clock read on the
// path. The kernel never sees a clock — it sees `attestation_present`, a
// boolean. Fact-gathering is allowed to read the world (a DB, a clock);
// deciding is not. That split is what keeps "same Facts -> same Decision" true.
// ----------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
    closeQuietly(ledger, db);
    denyAndExit(
      "denied (fail-closed): authoritative fact source unavailable (" + errMsg(err) + ")",
    );
    return;
  }

  try {
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
      // The one clock read on the path. See the file header.
      now: Date.now(),
    });
    const attestationPresent = attestationResult.verified === true;

    // ---- 6. AUTHORITATIVE facts + their provenance ---------------------
    const ctx = { request: req, attestationPresent };
    const { facts: authoritative, provenance: ledgerProvenance } =
      factSource.contextWithProvenance(ctx);

    const facts = shared.translateToFacts(req, authoritative, { requestId });

    // ---- 7. PILLAR 1: the deterministic kernel -------------------------
    const described = gate.getKernel();
    const kernel = described && described.kernel ? described.kernel : described;
    if (!kernel || typeof kernel.evaluate !== "function") {
      throw new Error("kernel has no evaluate()");
    }
    const decision = kernel.evaluate(facts);
    if (!decision || typeof decision !== "object") {
      throw new Error("kernel returned no decision");
    }

    // ---- 8. PILLAR 2: seal a verifiable provenance bundle --------------
    // Each producer records the facts IT sourced: the ledger recorded its six
    // above (with the exact SQL it ran); the five identity keys and the
    // attestation verdict are recorded here, by the code that produced them.
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
          notaryKeyId: attestationResult.verified
            ? attestationResult.notaryKeyId
            : "none",
          statementDigest: attestationResult.verified
            ? provenanceLib.digest(attestationResult.statement)
            : "0".repeat(64),
          verified: attestationPresent,
        },
      },
    ];

    const bundle = provenanceLib.buildBundle({
      requestId: facts.request_id,
      facts,
      provenance,
      decision,
      kernel: { kind: described?.kind ?? "reference" },
      evaluatedAt: new Date().toISOString(),
    });

    // Persist for the dashboard / auditor. Best-effort: a failure to WRITE THE
    // RECORD must not change the DECISION. Losing an audit record is bad;
    // letting a payment through because we couldn't write a file is worse, and
    // denying a legitimate payment because a disk was full is also wrong. So the
    // decision below stands either way, and the write failure is reported.
    const bundleWrite = writeBundle(bundle);

    closeQuietly(ledger, db);

    // ---- 9. render the decision ----------------------------------------
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
    if (!attestationPresent && attestationResult.verified === false) {
      notes.push(`[attestation] ${attestationResult.code}: ${attestationResult.reason}`);
    }
    if (bundleWrite.error) {
      notes.push(`[provenance] bundle not persisted: ${bundleWrite.error}`);
    } else {
      notes.push(`[provenance] bundle ${bundle.bundleDigest.slice(0, 12)}… -> ${bundleWrite.path}`);
    }

    if (decision.decision === "allow") {
      const out = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason:
            (reasons.length > 0 ? reasons.join("; ") : "allow: every policy condition held") +
            (notes.length ? " | " + notes.join(" | ") : ""),
          firedRules,
        },
      };
      process.stdout.write(JSON.stringify(out) + "\n");
      process.exit(0);
      return;
    }

    denyAndExit(
      (reasons.length > 0 ? "denied: " + reasons.join("; ") : "denied by policy") +
        (notes.length ? " | " + notes.join(" | ") : ""),
      firedRules,
    );
  } catch (err) {
    closeQuietly(ledger, db);
    denyAndExit("denied (fail-closed): " + errMsg(err));
  }
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
 * Persist a decision bundle as JSON. Never throws — see the call site for why a
 * write failure must not move the decision either way.
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
