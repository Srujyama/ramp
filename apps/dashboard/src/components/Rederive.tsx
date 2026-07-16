import type { JSX } from "react";
import { useMemo } from "react";
import { ShieldCheck, ShieldX, ShieldQuestion } from "lucide-react";
import type { Facts, Decision, RuleId } from "@ramp/shared";
import { referenceKernel } from "@ramp/gate/reference";
import { ruleTitle } from "../lib/format.js";
import { cn } from "../lib/utils.js";

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
      why: "This record has no stored decision: an infrastructure error row, not a policy outcome.",
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

function outcomeBadgeClass(outcome: Decision["decision"]): string {
  if (outcome === "allow") return "border-lime/40 bg-lime-soft text-lime-ink";
  if (outcome === "escalate") return "border-amber/40 bg-amber-soft text-amber-ink";
  return "border-flag/40 bg-flag-soft text-flag-ink";
}

function RuleList({ rules }: { rules: readonly RuleId[] }): JSX.Element {
  if (rules.length === 0) return <span className="text-ink-faint">none</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {rules.map((r) => (
        <span key={r} title={r} className="rounded bg-surface-sunken px-1.5 py-0.5 text-[11px] text-ink-muted">
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
      <div className="rounded-lg border border-dashed border-line-strong bg-surface-sunken/50 p-4">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber/40 bg-amber-soft px-2.5 py-1 text-[12px] font-medium text-amber-ink">
          <ShieldQuestion className="size-3.5" /> Cannot re-derive
        </span>
        <p className="mt-2 text-[13px] text-ink-muted">{verdict.why}</p>
      </div>
    );
  }

  if (verdict.kind === "mismatch") {
    return (
      <div className="rounded-lg border border-flag/30 bg-flag-soft/30 p-4">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-flag/40 bg-flag-soft px-2.5 py-1 text-[12px] font-semibold text-flag-ink">
          <ShieldX className="size-3.5" /> Does not follow
        </span>
        <p className="mt-2.5 text-[13px] text-ink-muted">
          <strong className="text-ink">Do not trust the recorded decision.</strong> Running the real policy
          engine on the facts stored in this record does not reproduce what was recorded. The record may be
          intact and still be wrong: integrity is not soundness.
        </p>
        <dl className="mt-3 flex flex-col gap-2 text-[13px]">
          <div className="flex flex-wrap items-center gap-2">
            <dt className="w-28 shrink-0 text-ink-faint">Recorded</dt>
            <dd className="flex flex-wrap items-center gap-1.5">
              <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", outcomeBadgeClass(verdict.recorded.decision))}>
                {verdict.recorded.decision}
              </span>
              <RuleList rules={verdict.recorded.firedRules} />
            </dd>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <dt className="w-28 shrink-0 text-ink-faint">Re-derived here</dt>
            <dd className="flex flex-wrap items-center gap-1.5">
              <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", outcomeBadgeClass(verdict.rederived.decision))}>
                {verdict.rederived.decision}
              </span>
              <RuleList rules={verdict.rederived.firedRules} />
            </dd>
          </div>
        </dl>
      </div>
    );
  }

  const outcome = verdict.rederived.decision;
  return (
    <div className="rounded-lg border border-lime/25 bg-lime-soft/30 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-lime/40 bg-lime-soft px-2.5 py-1 text-[12px] font-semibold text-lime-ink">
          <ShieldCheck className="size-3.5" /> Re-derived in your browser
        </span>
        <span className="text-[11.5px] text-ink-faint">real policy engine · ran on your machine</span>
      </div>
      <p className="mt-2.5 text-[13px] text-ink-muted">
        We took the facts stored in this record, ran the <strong className="text-ink">real policy engine</strong>{" "}
        on them in this page, and independently got <strong className="text-ink">{outcome}</strong>, the same
        outcome that was recorded, from the same rules. Nothing here asked the server whether the decision was
        valid.
      </p>
      <dl className="mt-3 flex flex-col gap-2 text-[13px]">
        <div className="flex flex-wrap items-center gap-2">
          <dt className="w-32 shrink-0 text-ink-faint">Outcome</dt>
          <dd>
            <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", outcomeBadgeClass(outcome))}>{outcome}</span>
          </dd>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <dt className="w-32 shrink-0 text-ink-faint">Rules reproduced</dt>
          <dd>
            <RuleList rules={verdict.rederived.firedRules} />
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-[12px] text-ink-faint">
        The <em>Proof</em> section above checks that this record wasn&apos;t <em>altered</em>. This checks that
        its decision is <em>correct</em>. A perfectly intact record of a wrong decision passes the first and
        fails this one.
      </p>
    </div>
  );
}

export default Rederive;
