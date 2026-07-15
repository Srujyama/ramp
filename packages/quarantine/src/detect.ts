/**
 * @ramp/quarantine — injection detection (TELEMETRY, NOT A CONTROL)
 *
 * ============================================================================
 * READ THIS BEFORE YOU RELY ON ANYTHING IN THIS FILE.
 * ============================================================================
 * These detectors are NOT a security boundary. They do not gate any decision,
 * they are not consulted by the kernel, and nothing here can allow or deny a
 * payment. If every function in this file returned `false` for a real attack,
 * the gate's guarantees would be COMPLETELY UNCHANGED — because the guarantees
 * come from structure (quarantine + authoritative facts + a deterministic
 * kernel), not from recognising bad strings.
 *
 * That is the whole point, and it is worth stating loudly in a file like this,
 * because a pattern list is exactly what a reader expects to be the defence. It
 * isn't. A blocklist is a bet that you can out-write an adversary who gets to
 * read your blocklist and rephrase forever. We do not take that bet; we make the
 * content structurally unable to act, and then we do not care what it says.
 *
 * So why does this exist? Two honest reasons:
 *
 *   1. DEMO LEGIBILITY. "We detected an injection AND it changed nothing" is a
 *      far stronger claim than silence. It shows the attack arrived, was seen,
 *      and was irrelevant. The detector is a narrator, not a guard.
 *   2. OPERATIONAL SIGNAL. A spike in injection markers from one vendor is worth
 *      an alert to a human — after the fact, out of band, with no authority.
 *
 * Every function takes QUARANTINED content and returns booleans/counts. Content
 * never leaves. You cannot use this module to read an invoice.
 */
import { Quarantined } from "./quarantine.js";

/** A named heuristic: a label plus the pattern that matched it. */
export interface InjectionMarker {
  /** Stable label, e.g. "instruction_override". */
  readonly marker: string;
  /** How many times this marker matched. Never the matched text. */
  readonly hits: number;
}

/**
 * The verdict on one quarantined value. Carries NO untrusted content — only
 * labels, counts, and the digest — so it is safe to log and render.
 */
export interface InjectionScan {
  /** Digest of the scanned content, for correlation. Not the content. */
  readonly contentId: string;
  /** True iff any marker matched. Advisory only — gates nothing. */
  readonly suspicious: boolean;
  /** Which markers matched, sorted by label for deterministic output. */
  readonly markers: readonly InjectionMarker[];
  /** Length of the content in characters (a shape signal, not content). */
  readonly length: number;
}

/**
 * The heuristics. Non-exhaustive BY CONSTRUCTION — an exhaustive list of ways to
 * phrase an instruction in a natural language does not exist. Anyone tempted to
 * "complete" this list should re-read the file header: completeness here is not
 * a goal, because coverage here is not what protects us.
 */
const HEURISTICS: ReadonlyArray<{ marker: string; pattern: RegExp }> = [
  {
    marker: "instruction_override",
    pattern: /\b(ignore|disregard|forget|override)\b[^.]{0,40}\b(previous|prior|above|all|any)\b[^.]{0,40}\b(instruction|rule|polic|constraint|direction)/gi,
  },
  {
    marker: "authorization_demand",
    pattern: /\b(approve|authorise|authorize|allow|release|pay)\b[^.]{0,30}\b(immediately|now|without|regardless|anyway|at once)\b/gi,
  },
  {
    marker: "role_reassignment",
    pattern: /\b(you are now|act as|pretend to be|from now on you|new instructions?:|system:)/gi,
  },
  {
    marker: "urgency_pressure",
    pattern: /\b(urgent|emergency|critical|immediately|asap|time.sensitive)\b/gi,
  },
  {
    marker: "policy_appeal",
    pattern: /\b(pre.?approved|already (approved|verified|cleared)|exempt|whitelisted|trusted vendor)\b/gi,
  },
  {
    marker: "delimiter_injection",
    pattern: /(```|<\/?(system|user|assistant|instructions?)>|\[\/?INST\]|<\|.*?\|>)/gi,
  },
];

/**
 * Scan quarantined content for injection markers WITHOUT declassifying it.
 *
 * Note what this does not do: it does not return the matched text, and it does
 * not let you read the content. You learn that a pattern fired and nothing more.
 * That constraint is deliberate — a "show me what matched" API would be a
 * declassifier with an unbounded codomain and no audit record.
 *
 * Non-string content is reported as unsuspicious rather than throwing: this is
 * telemetry, and telemetry must never be able to break the enforcement path.
 */
export function scanForInjection(q: Quarantined<unknown>): InjectionScan {
  const raw = Quarantined.unwrapUnsafe(q);
  if (typeof raw !== "string") {
    return { contentId: q.contentId, suspicious: false, markers: [], length: 0 };
  }

  const markers: InjectionMarker[] = [];
  for (const { marker, pattern } of HEURISTICS) {
    // Fresh regex per call: /g regexes carry lastIndex state across calls, and a
    // shared one would make results depend on call order. Determinism matters
    // even in telemetry — a flaky narrator undermines a demo about determinism.
    const re = new RegExp(pattern.source, pattern.flags);
    const hits = (raw.match(re) ?? []).length;
    if (hits > 0) markers.push({ marker, hits });
  }
  markers.sort((a, b) => a.marker.localeCompare(b.marker));

  return {
    contentId: q.contentId,
    suspicious: markers.length > 0,
    markers,
    length: raw.length,
  };
}

/**
 * One-line human summary of a scan, safe to print. Contains no content.
 * Used by the demo to narrate "we saw the attack; it did nothing."
 */
export function describeScan(scan: InjectionScan): string {
  if (!scan.suspicious) {
    return `${scan.contentId}: no injection markers (${scan.length} chars)`;
  }
  const labels = scan.markers.map((m) => `${m.marker}×${m.hits}`).join(", ");
  return (
    `${scan.contentId}: ${scan.markers.length} injection marker(s) [${labels}] ` +
    `— advisory only; the decision does not consult this`
  );
}
