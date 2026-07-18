#!/usr/bin/env node
/**
 * NON-PAYMENT GATE — production-deploy authorization (the primitive, no money)
 * ============================================================================
 * The same enforcement shape as hook/evaluate.mjs, in a domain that is obviously
 * not payments: an agent asks to ship a service to production; a DETERMINISTIC
 * kernel decides from AUTHORITATIVE facts (CI, change calendar, approvals, deploy
 * plan); the decision is sealed into a portable, re-executable @ramp/provenance
 * bundle. Reads a request on stdin, writes a verdict on stdout.
 *
 * FAIL-CLOSED, exactly like the payment hook: ANY problem denies (exit 2). A
 * deny exits 2; an allow or an escalate ("a human must confirm") exits 0 — never
 * turn "ask a human" into "blocked". Strip ledger/attestation/quarantine: none of
 * them are needed to prove the primitive generalizes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deployKernel,
  translateDeploy,
  deployProvenance,
} from "./deploy/policy.mjs";

// The org's deploy dials — the equivalent of policy_limits. Fixed here so the
// demo is self-contained (no DB); a real adapter reads these from policy config.
const DEPLOY_POLICY = {
  requiredApprovals: 2,
  maxBlastRadius: 50,
  escalationBlastRadius: 20,
};

function denyAndExit(reason, firedRules = []) {
  emit({ decision: "deny", permissionDecision: "deny", reason, firedRules });
  process.exit(2);
}

function emit(out) {
  try {
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch {
    /* the exit code still carries the verdict */
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function errMsg(err) {
  return err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    denyAndExit("malformed request: stdin was not valid JSON");
    return;
  }

  const req = payload && typeof payload === "object" ? payload.tool_input ?? payload : undefined;
  if (!req || typeof req !== "object" || typeof req.requestingAgent !== "string" || typeof req.service !== "string") {
    denyAndExit("rejected: not a well-formed deploy request");
    return;
  }

  // Load the proof engine. Failure to load = fail closed (like the hook).
  let provenanceLib;
  try {
    provenanceLib = await import("@ramp/provenance");
  } catch (err) {
    denyAndExit("gate misconfigured: could not load @ramp/provenance (" + errMsg(err) + ")");
    return;
  }

  try {
    // AUTHORITATIVE facts. In a real adapter these are reads from CI / the change
    // calendar / the approvals system / the deploy plan. Here the request carries
    // a `context` block standing in for those systems — the point is the KERNEL is
    // deterministic and the PROOF is re-executable, not where the facts are read.
    const ctx = req.context ?? {};
    const authoritative = {
      changeWindowOpen: ctx.changeWindowOpen === true,
      ciGreen: ctx.ciGreen === true,
      approvalsCount: ctx.approvalsCount,
      blastRadius: ctx.blastRadius,
    };

    const facts = translateDeploy(req, authoritative, DEPLOY_POLICY);
    const decision = deployKernel.evaluate(facts);
    if (!decision || typeof decision !== "object") throw new Error("kernel returned no decision");

    // Seal a REAL, re-executable @ramp/provenance bundle — the same engine that
    // seals payment decisions, over deploy facts. Signed so a fabricated bundle is
    // caught (re-derivation catches an edited one; the signature catches a new one).
    const sealed = provenanceLib.buildBundle({
      requestId: facts.request_id,
      facts,
      provenance: deployProvenance(facts),
      decision,
      kernel: { kind: deployKernel.kind },
      evaluatedAt: new Date().toISOString(),
    });
    const bundle = {
      ...sealed,
      gateSignature: provenanceLib.signBundleDigest(
        sealed.bundleDigest,
        provenanceLib.demoGatePrivateKey(),
        provenanceLib.DEMO_GATE_KEY_ID,
      ),
    };

    // Persist (best-effort — a write failure must not move the decision).
    let bundlePath = null;
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      const dir = process.env.RAMP_DEPLOY_BUNDLE_DIR ?? join(here, "..", ".ramp", "deploy-bundles");
      mkdirSync(dir, { recursive: true });
      bundlePath = join(dir, `${bundle.bundleDigest.slice(0, 16)}.json`);
      writeFileSync(bundlePath, JSON.stringify(bundle, null, 2) + "\n", "utf8");
    } catch {
      bundlePath = null;
    }

    const firedRules = decision.firedRules ?? [];
    const reason = (decision.reasons ?? []).join("; ");
    const suffix = bundlePath ? ` | bundle ${bundle.bundleDigest.slice(0, 12)}…` : "";

    if (decision.decision === "allow") {
      emit({ decision: "allow", permissionDecision: "allow", reason: reason + suffix, firedRules, bundleDigest: bundle.bundleDigest });
      process.exit(0);
      return;
    }
    if (decision.decision === "escalate") {
      // exit 0, like the payment hook's "ask": HELD for a human, not blocked.
      emit({ decision: "escalate", permissionDecision: "ask", reason: "HELD for human approval: " + reason + suffix, firedRules, bundleDigest: bundle.bundleDigest });
      process.exit(0);
      return;
    }
    // deny (or any unrecognized outcome) fails closed. Emit directly (not via
    // denyAndExit) so the sealed bundle's digest rides along — a policy deny is a
    // recorded, re-verifiable decision, unlike an early precondition error.
    emit({
      decision: "deny",
      permissionDecision: "deny",
      reason: (reason || "denied by policy") + suffix,
      firedRules,
      bundleDigest: bundle.bundleDigest,
    });
    process.exit(2);
    return;
  } catch (err) {
    denyAndExit("denied (fail-closed): " + errMsg(err));
  }
}

main().catch((err) => denyAndExit("denied (fail-closed): unhandled error (" + errMsg(err) + ")"));
