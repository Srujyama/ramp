/**
 * @ramp/provenance — rendering the graph
 *
 * "This is what you show an auditor." (PITCH.md, demo beat 5.)
 *
 * A bundle is a proof, but a proof nobody can read does not persuade anyone.
 * This turns one into a decision -> facts -> sources tree, where each leaf names
 * the specific place the value came from: the table and column and key, the
 * notary and statement, the declassifier and its codomain.
 *
 * Everything here is content-free with respect to untrusted input: a derivation
 * records WHERE a value came from and, for quarantined content, only its digest
 * and codomain — never the bytes. An audit view that renders attacker-authored
 * text to a human reviewer would reintroduce the injection at the last step,
 * after all the work upstream to keep it contained.
 */
import type { Facts } from "@ramp/shared";
import type {
  DecisionBundle,
  Derivation,
  FactProvenance,
  BundleVerification,
} from "./bundle.js";

/** Render one derivation as a single, specific, checkable line. */
export function describeDerivation(d: Derivation): string {
  switch (d.kind) {
    case "structured_arg":
      return `structured tool arg  tool_input.${d.field}`;
    case "sql":
      return `ledger query         ${d.table} :: ${d.query.replace(/\s+/g, " ").trim()} [${d.params.join(", ")}]`;
    case "attestation":
      return `notary attestation   key=${d.notaryKeyId} statement=${d.statementDigest.slice(0, 12)}… verified=${d.verified}`;
    case "declassified":
      return `declassified         ${d.declassifier} -> {${d.codomain}} content=${d.contentId} admitted=${d.admitted}`;
    case "constant":
      return `policy constant      ${d.note}`;
  }
}

/**
 * Format a fact's value compactly for the tree.
 *
 * RENDERING LIVES HERE, and only here. The provenance record itself stores fact
 * values verbatim — a prettified value in the record is provenance that disagrees
 * with the fact it explains, which the honesty check (correctly) rejects. So the
 * friendly string is made at display time, from evidence, rather than stored
 * instead of it.
 */
function formatValue(value: FactProvenance["value"]): string {
  if (Array.isArray(value)) {
    return `[${value
      .map((v) =>
        v !== null && typeof v === "object" && "scope" in v
          ? `${(v as { scope: string }).scope}:${(v as { key: string }).key} ` +
            `${(v as { spent: number }).spent}/${(v as { limit: number }).limit}`
          : String(v),
      )
      .join(", ")}]`;
  }
  return String(value);
}

/**
 * Render the full provenance tree for a bundle.
 *
 * Facts are grouped by whether they GATED the decision, because that is the
 * question an auditor is actually asking. "Where did all twelve facts come
 * from?" is the compliance question; "which facts made this a deny, and were
 * THOSE trustworthy?" is the one someone asks when money went missing.
 */
export function renderBundle(bundle: DecisionBundle, verification?: BundleVerification): string {
  const lines: string[] = [];
  const d = bundle.decision;
  const verdict = d.decision.toUpperCase();

  lines.push(`DECISION  ${verdict}  —  request ${bundle.requestId}`);
  lines.push(`  evaluated ${bundle.evaluatedAt} by the ${bundle.kernel.kind} kernel`);
  for (const rule of d.firedRules) lines.push(`  rule fired: ${rule}`);
  for (const reason of d.reasons) lines.push(`  reason: ${reason}`);
  lines.push("");

  lines.push(`FACTS  (digest ${bundle.factsDigest.slice(0, 16)}…)`);
  const byFact = new Map(bundle.provenance.map((p) => [p.fact, p]));
  const order = Object.keys(bundle.facts) as ReadonlyArray<keyof Facts>;

  for (const key of order) {
    const p = byFact.get(key);
    const value = p ? formatValue(p.value) : String(bundle.facts[key]);
    lines.push(`  ${String(key).padEnd(26)} = ${value}`);
    if (p) {
      lines.push(`  ${" ".repeat(26)}   └─ ${describeDerivation(p.derivation)}`);
    } else {
      // Loud, because an unexplained fact is the shape of an injected one.
      lines.push(`  ${" ".repeat(26)}   └─ !! NO PROVENANCE — origin unaccounted for`);
    }
  }

  lines.push("");
  lines.push(`BUNDLE  ${bundle.bundleDigest.slice(0, 16)}…`);

  if (verification) {
    if (verification.valid) {
      lines.push(
        `  VERIFIED — the facts are unaltered, and re-running the kernel on them`,
      );
      lines.push(
        `  independently reproduces ${verdict}. You did not have to trust the gate.`,
      );
    } else {
      lines.push(`  FAILED VERIFICATION — ${verification.defects.length} defect(s):`);
      for (const defect of verification.defects) {
        lines.push(`    [${defect.code}] ${defect.detail}`);
      }
    }
  }

  return lines.join("\n");
}

/** One-line summary, for logs and list views. */
export function summarizeBundle(bundle: DecisionBundle): string {
  const rules = bundle.decision.firedRules.join(",") || "none";
  return (
    `${bundle.requestId} ${bundle.decision.decision.toUpperCase()} ` +
    `rules=[${rules}] facts=${bundle.factsDigest.slice(0, 12)}… ` +
    `bundle=${bundle.bundleDigest.slice(0, 12)}…`
  );
}
