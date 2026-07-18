/**
 * NON-PAYMENT ADAPTER — production-deploy authorization (proves the primitive)
 * ============================================================================
 * The whole pitch is that the gate is not a spend feature — it is a general
 * "authorization primitive": trusted facts -> deterministic policy -> fail-closed
 * gate -> portable, re-executable proof. This file is the smallest REAL proof of
 * that claim: a different domain (shipping code to production, no money, no
 * vendor) governed by the SAME shape the payment kernel uses.
 *
 * It deliberately does NOT touch @ramp/gate's payment `Facts`/`policy.dl`/4-way
 * parity set (those are frozen and map 1:1). Instead it mirrors the reference
 * kernel's DISCIPLINE with a parallel fact type + tiny kernel:
 *   1. malformed-numeric guard FIRST and ALONE (the "NaN was payable" lesson —
 *      NaN > max is false, so a non-integer blast_radius must be caught up front);
 *   2. denies collected in a FIXED order (byte-stable reasons/firedRules);
 *   3. escalations collected; lattice is deny > escalate > allow.
 *
 * The decision is sealed by @ramp/provenance's REAL buildBundle and re-derived by
 * re-running THIS kernel on the recorded facts — the same reproducibility the
 * payment path gives, in a domain that is obviously not payments.
 */

/**
 * Where each deploy fact comes from. The mirror of @ramp/shared's FACT_SOURCES:
 * the AUTHORITATIVE facts come from CI / the change calendar / the approvals
 * system / the deploy plan — never from the agent's narration. Only the identity
 * + intent KEYS come from the (untrusted) request.
 */
export const DEPLOY_FACT_SOURCES = {
  request_id: "tool_args",
  requesting_agent: "tool_args",
  service: "tool_args",
  environment: "tool_args",
  change_window_open: "change_calendar",
  ci_green: "ci_system",
  approvals_count: "approvals_db",
  required_approvals: "policy_config",
  blast_radius: "deploy_plan",
  max_blast_radius: "policy_config",
  escalation_blast_radius: "policy_config",
};

const NUMERIC_FACTS = [
  "approvals_count",
  "required_approvals",
  "blast_radius",
  "max_blast_radius",
  "escalation_blast_radius",
];

/** A non-negative integer? (mirrors the payment kernel's malformed-facts guard.) */
function badInteger(n) {
  return typeof n !== "number" || !Number.isInteger(n) || n < 0;
}

/**
 * The deploy kernel. Pure, synchronous, deterministic, no clock, no I/O — the
 * same PolicyKernel contract the payment kernel honors, so the decision is
 * re-executable by anyone with these facts. deny > escalate > allow.
 */
export const deployKernel = {
  kind: "deploy-reference",
  evaluate(facts) {
    // 1. malformed facts FIRST and ALONE — a non-integer/negative numeric fact
    //    is unrepresentable in a sound policy, so refuse before any comparison.
    const malformed = NUMERIC_FACTS.filter((k) => badInteger(facts[k]));
    if (malformed.length > 0) {
      return {
        decision: "deny",
        reasons: [`malformed_facts: non-integer/negative ${malformed.join(", ")}`],
        firedRules: ["malformed_facts"],
      };
    }

    // 2. denies in FIXED order (byte-stable output).
    const denies = [];
    if (facts.change_window_open !== true) {
      denies.push(["outside_change_window", "deploy requested outside an open change window"]);
    }
    if (facts.ci_green !== true) {
      denies.push(["ci_not_green", "CI is not green for this revision"]);
    }
    if (facts.approvals_count < facts.required_approvals) {
      denies.push([
        "insufficient_approvals",
        `only ${facts.approvals_count} of ${facts.required_approvals} required approvals`,
      ]);
    }
    if (facts.blast_radius > facts.max_blast_radius) {
      denies.push([
        "blast_radius_too_large",
        `blast radius ${facts.blast_radius} exceeds cap ${facts.max_blast_radius}`,
      ]);
    }
    if (denies.length > 0) {
      return {
        decision: "deny",
        reasons: denies.map(([, r]) => r),
        firedRules: denies.map(([id]) => id),
      };
    }

    // 3. escalations (a human must approve). deny already dominated above.
    if (facts.blast_radius > facts.escalation_blast_radius) {
      return {
        decision: "escalate",
        reasons: [
          `blast radius ${facts.blast_radius} over the unattended threshold ${facts.escalation_blast_radius} — a human must confirm`,
        ],
        firedRules: ["high_blast_radius"],
      };
    }

    // 4. allow.
    return {
      decision: "allow",
      reasons: [
        `in-window, CI green, ${facts.approvals_count}/${facts.required_approvals} approvals, blast radius ${facts.blast_radius} <= ${facts.max_blast_radius}`,
      ],
      firedRules: ["all_conditions_met"],
    };
  },
};

/**
 * Merge one UNTRUSTED deploy request (identity + intent KEYS only) with the
 * AUTHORITATIVE deploy facts into the closed fact object the kernel evaluates.
 * Same trust boundary as the payment `translateToFacts`: the agent's request may
 * SAY what it wants to ship, but whether CI is green / the window is open / how
 * many approvals exist is read from authoritative systems, never from the agent.
 *
 * @param request  untrusted: { requestId, requestingAgent, service, environment }
 * @param authoritative  the real reads: { changeWindowOpen, ciGreen, approvalsCount, blastRadius }
 * @param policy   the org dials: { requiredApprovals, maxBlastRadius, escalationBlastRadius }
 */
export function translateDeploy(request, authoritative, policy) {
  return {
    // identity / intent KEYS (untrusted request)
    request_id: request.requestId ?? "",
    requesting_agent: request.requestingAgent,
    service: request.service,
    environment: request.environment,
    // AUTHORITATIVE facts (CI / calendar / approvals / deploy plan)
    change_window_open: authoritative.changeWindowOpen,
    ci_green: authoritative.ciGreen,
    approvals_count: authoritative.approvalsCount,
    blast_radius: authoritative.blastRadius,
    // org policy dials
    required_approvals: policy.requiredApprovals,
    max_blast_radius: policy.maxBlastRadius,
    escalation_blast_radius: policy.escalationBlastRadius,
  };
}

/** Per-fact provenance entries for the sealed bundle (source of every fact). */
export function deployProvenance(facts) {
  return Object.keys(DEPLOY_FACT_SOURCES).map((fact) => ({
    fact,
    value: facts[fact],
    source: DEPLOY_FACT_SOURCES[fact],
    derivation: { kind: "authoritative_read", source: DEPLOY_FACT_SOURCES[fact] },
  }));
}
