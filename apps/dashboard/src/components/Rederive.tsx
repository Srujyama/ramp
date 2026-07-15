import type { JSX } from "react";
import { useMemo } from "react";
import type { Facts, Decision, RuleId } from "@ramp/shared";
import { referenceKernel } from "@ramp/gate/reference";
import { ruleTitle } from "../lib/format.js";

/**
 * "Re-derived in your browser" — the strongest claim in the console.
 *
 * ============================================================================
 * WHY THIS IS DIFFERENT FROM THE PROOF SECTION ABOVE IT
 * ============================================================================
 * The Proof section answers INTEGRITY: *"has this record been altered since it
 * was written?"* It recomputes the proof id from the proof's own bytes. That is
 * a real and useful guarantee, and it is not the one people assume it is.
 *
 * A perfectly intact record of a WRONG decision passes an integrity check. If
 * the gate had a bug — or was compromised — and wrote "allow" for facts that
 * plainly deny, the proof would still verify, because the bytes were never
 * touched afterwards. Integrity says nobody edited the answer; it says nothing
 * about whether the answer was right.
 *
 * This section answers SOUNDNESS: *"does this decision actually follow from
 * these facts?"* It takes the recorded facts, runs the REAL policy kernel on
 * them right here in the page, and compares the result to what was recorded.
 *
 * Three properties make that worth something:
 *
 *   1. It is the REAL kernel. `referenceKernel` from @ramp/gate is the same
 *      golden oracle the gate itself evaluates with — not a JS approximation of
 *      the rules written for the UI. A second implementation could disagree with
 *      the first, and then the disagreement is the bug.
 *   2. It runs in YOUR browser. Nothing here asks the server whether the
 *      decision was valid. The verdict below is computed on your machine from
 *      the record alone. That is the difference between being told and checking.
 *   3. It is only possible because the kernel is PURE and DETERMINISTIC — no
 *      clock, no I/O, no randomness. Determinism is what makes a decision
 *      reproducible, and reproducibility is what makes it provable. This
 *      component is that design decision, cashed out visibly.
 *
 * If this ever shows MISMATCH, do not trust the recorded decision — trust this.
 */

type Verdict =
  | { kind: "match"; rederived: Decision }
  | { kind: "mismatch"; rederived: Decision; recorded: Decision }
  | { kind: "unavailable"; why: string };

/** Compare two decisions on the parts that matter: outcome + fired rules. */
function compare(recorded: Decision, rederived: Decision): boolean {
  if (recorded.decision !== rederived.decision) return false;
  const a = [...recorded.firedRules].sort();
  const b = [...rederived.firedRules].sort();
  return a.length === b.length && a.every((r, i) => r === b[i]);
}

function rederive(facts: Facts | null, recorded: Decision | null): Verdict {
  if (!facts) {
    return {
      kind: "unavailable",
      why: "This record has no stored facts, so there is nothing to re-derive from.",
    };
  }
  if (!recorded) {
    return {
      kind: "unavailable",
      why: "This record has no stored decision — an infrastructure error row, not a policy outcome.",
    };
  }
  try {
    const rederived = referenceKernel.evaluate(facts);
    return compare(recorded, rederived)
      ? { kind: "match", rederived }
      : { kind: "mismatch", rederived, recorded };
  } catch (err) {
    return {
      kind: "unavailable",
      why: `The policy engine could not evaluate these facts: ${(err as Error).message}`,
    };
  }
}

function RuleList({ rules }: { rules: readonly RuleId[] }): JSX.Element {
  if (rules.length === 0) return <span className="dim">none</span>;
  return (
    <span className="rule-inline">
      {rules.map((r) => (
        <span key={r} className="rule-tag sm" title={r}>
          {ruleTitle(r)}
        </span>
      ))}
    </span>
  );
}

export function Rederive({
  facts,
  decision,
}: {
  facts: Facts | null;
  decision: Decision | null;
}): JSX.Element {
  // Memoised on the record: evaluation is pure, so the same input can only ever
  // give the same answer — recomputing on every render would be pure waste.
  const verdict = useMemo(() => rederive(facts, decision), [facts, decision]);

  if (verdict.kind === "unavailable") {
    return (
      <div className="rederive unavailable">
        <div className="rd-head">
          <span className="badge warn">Cannot re-derive</span>
        </div>
        <p className="rd-note">{verdict.why}</p>
      </div>
    );
  }

  if (verdict.kind === "mismatch") {
    return (
      <div className="rederive mismatch">
        <div className="rd-head">
          <span className="badge deny">✗ DOES NOT FOLLOW</span>
        </div>
        <p className="rd-note">
          <strong>Do not trust the recorded decision.</strong> Running the real
          policy engine on the facts stored in this record does not reproduce
          what was recorded. The record may be intact and still be wrong —
          integrity is not soundness.
        </p>
        <dl className="kv">
          <div className="kv-row">
            <dt>Recorded</dt>
            <dd>
              <span className="badge deny">{verdict.recorded.decision}</span>{" "}
              <RuleList rules={verdict.recorded.firedRules} />
            </dd>
          </div>
          <div className="kv-row">
            <dt>Re-derived here</dt>
            <dd>
              <span className="badge allow">{verdict.rederived.decision}</span>{" "}
              <RuleList rules={verdict.rederived.firedRules} />
            </dd>
          </div>
        </dl>
      </div>
    );
  }

  const outcome = verdict.rederived.decision;
  return (
    <div className="rederive match">
      <div className="rd-head">
        <span className="badge allow">✓ Re-derived in your browser</span>
        <span className="dim rd-kernel">real policy engine · ran on your machine</span>
      </div>
      <p className="rd-note">
        We took the facts stored in this record, ran the{" "}
        <strong>real policy engine</strong> on them in this page, and
        independently got <strong>{outcome}</strong> — the same outcome that was
        recorded, from the same rules. Nothing here asked the server whether the
        decision was valid.
      </p>
      <dl className="kv">
        <div className="kv-row">
          <dt>Outcome</dt>
          <dd>
            <span className={`badge ${outcome === "allow" ? "allow" : "deny"}`}>
              {outcome}
            </span>
          </dd>
        </div>
        <div className="kv-row">
          <dt>Rules reproduced</dt>
          <dd>
            <RuleList rules={verdict.rederived.firedRules} />
          </dd>
        </div>
      </dl>
      <p className="rd-foot dim">
        The <em>Proof</em> section above checks that this record wasn&apos;t{" "}
        <em>altered</em>. This checks that its decision is <em>correct</em>. A
        perfectly intact record of a wrong decision passes the first and fails
        this one.
      </p>
    </div>
  );
}

export default Rederive;
