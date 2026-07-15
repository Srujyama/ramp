//! @ramp/gate — wasm shell (OPTIONAL)
//!
//! `#[wasm_bindgen] evaluate(facts_json) -> decision_json` is the single entry
//! point the TS `WasmKernel` calls across the WASM boundary (structured data is
//! passed as JSON strings so the boundary stays simple and stable).
//!
//! The allow/deny logic here mirrors `datalog/policy.dl` EXACTLY — deny dominates,
//! and the deny-evaluation order is fixed (vendor, per_txn_cap, category, agent,
//! daily) so `reasons`/`fired_rules` are byte-stable and pass the parity test
//! against the TS reference oracle. In a full build, `scripts/build-wasm.sh` runs
//! `souffle -g` to generate the C++ engine; this shell can either link that engine
//! or, as documented below, evaluate the rules directly in Rust with identical
//! semantics. Both produce the same `Decision` — that is what parity enforces.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// Mirror of the frozen `Facts` contract in `@ramp/shared` (snake_case matches).
#[derive(Deserialize)]
struct Facts {
    request_id: String,
    requesting_agent: String,
    amount: i64,
    vendor: String,
    category: String,
    vendor_verified: bool,
    daily_total_so_far: i64,
    per_txn_cap: i64,
    daily_limit: i64,
    approved_categories: Vec<String>,
    agent_cleared_categories: Vec<String>,
    #[serde(default)]
    attestation_present: bool,
}

/// Mirror of the frozen `Decision` contract in `@ramp/shared`.
#[derive(Serialize)]
struct Decision {
    decision: String,
    reasons: Vec<String>,
    #[serde(rename = "firedRules")]
    fired_rules: Vec<String>,
}

fn evaluate_facts(f: &Facts) -> Decision {
    let mut reasons: Vec<String> = Vec::new();
    let mut fired: Vec<String> = Vec::new();

    // D0: malformed facts — mirrors the TS kernel's `deny/malformed_facts`.
    //
    // Rust is already safe from the NaN fail-open that bit the TS kernel: these
    // fields are `i64`, so serde REFUSES to deserialize NaN/Infinity/a float and
    // `evaluate` returns an error before we get here (an error the hook turns
    // into a deny). Negative amounts, however, do parse — an i64 is signed —
    // so this rule is not redundant, and it keeps the two kernels answering the
    // same question rather than relying on a type-system accident for parity.
    let bad: Vec<&str> = [
        ("amount", f.amount),
        ("daily_total_so_far", f.daily_total_so_far),
        ("per_txn_cap", f.per_txn_cap),
        ("daily_limit", f.daily_limit),
    ]
    .iter()
    .filter(|(_, v)| *v < 0)
    .map(|(k, _)| *k)
    .collect();

    if !bad.is_empty() {
        return Decision {
            decision: "deny".to_string(),
            reasons: vec![format!(
                "malformed_facts: {} must be finite, non-negative integers (money is whole units); refusing to evaluate",
                bad.join(", ")
            )],
            fired_rules: vec!["deny/malformed_facts".to_string()],
        };
    }

    let category_approved = f.approved_categories.iter().any(|c| c == &f.category);
    let agent_cleared = f.agent_cleared_categories.iter().any(|c| c == &f.category);

    // D1: vendor not verified.
    if !f.vendor_verified {
        fired.push("deny/vendor_not_verified".to_string());
        reasons.push(format!(
            "vendor_not_verified: vendor \"{}\" is not verified in the registry",
            f.vendor
        ));
    }
    // D2: over per-transaction cap.
    if f.amount > f.per_txn_cap {
        fired.push("deny/over_per_txn_cap".to_string());
        reasons.push(format!(
            "over_per_txn_cap: amount {} > per_txn_cap {}",
            f.amount, f.per_txn_cap
        ));
    }
    // D4: category not approved.
    if !category_approved {
        fired.push("deny/category_not_approved".to_string());
        reasons.push(format!(
            "category_not_approved: category \"{}\" is not on the org's approved list",
            f.category
        ));
    }
    // D3: agent uncleared for category.
    if !agent_cleared {
        fired.push("deny/agent_uncleared_for_category".to_string());
        reasons.push(format!(
            "agent_uncleared_for_category: agent \"{}\" is not cleared for category \"{}\"",
            f.requesting_agent, f.category
        ));
    }
    // D5: daily limit exceeded.
    if f.daily_total_so_far + f.amount > f.daily_limit {
        fired.push("deny/daily_limit_exceeded".to_string());
        reasons.push(format!(
            "daily_limit_exceeded: {} + {} > daily_limit {}",
            f.daily_total_so_far, f.amount, f.daily_limit
        ));
    }
    // D6: no verified attestation (pillar 4). Appended last to keep the
    // pre-existing reason ordering byte-stable; order never affects allow/deny.
    if !f.attestation_present {
        fired.push("deny/attestation_invalid".to_string());
        reasons.push(format!(
            "attestation_invalid: no verified attestation binds this invoice to vendor \"{}\" — refusing to pay on an unattested document",
            f.vendor
        ));
    }

    if !fired.is_empty() {
        return Decision {
            decision: "deny".to_string(),
            reasons,
            fired_rules: fired,
        };
    }

    Decision {
        decision: "allow".to_string(),
        reasons: vec![format!(
            "all_conditions_met: amount {} within cap {}, category \"{}\" approved and agent \"{}\" cleared, vendor \"{}\" verified, daily {} + {} <= {}",
            f.amount, f.per_txn_cap, f.category, f.requesting_agent, f.vendor,
            f.daily_total_so_far, f.amount, f.daily_limit
        )],
        fired_rules: vec!["allow/all_conditions_met".to_string()],
    }
}

/// The single boundary entry point: `facts_json` -> `decision_json`.
#[wasm_bindgen]
pub fn evaluate(facts_json: &str) -> Result<String, JsValue> {
    let facts: Facts = serde_json::from_str(facts_json)
        .map_err(|e| JsValue::from_str(&format!("invalid facts json: {e}")))?;
    let decision = evaluate_facts(&facts);
    serde_json::to_string(&decision)
        .map_err(|e| JsValue::from_str(&format!("failed to serialize decision: {e}")))
}
