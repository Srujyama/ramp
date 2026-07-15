/**
 * @ramp/quarantine — the Quarantined wrapper (PILLAR 3)
 *
 * ============================================================================
 * THE IDEA (CaMeL: "Defeating Prompt Injections by Design", Debenedetti et al.)
 * ============================================================================
 * Prompt injection is not a string-matching problem. You cannot win by getting
 * better at spotting "IGNORE ALL PREVIOUS INSTRUCTIONS", because the attacker
 * writes the next sentence and you are always one phrasing behind. CaMeL's move
 * is to stop trying: treat untrusted content as DATA THAT CANNOT ACT, enforced
 * structurally, and stop caring what it says.
 *
 * Two rules, both enforced by construction here rather than by vigilance:
 *
 *   1. CONTROL FLOW NEVER DEPENDS ON UNTRUSTED CONTENT. What an invoice says can
 *      never decide which tool runs or whether a payment is authorised. In this
 *      codebase that is already structural: the kernel reads `Facts`, and every
 *      gating fact is a ledger read (see @ramp/shared's translate.ts). Nothing
 *      an invoice says reaches it.
 *
 *   2. UNTRUSTED DATA CANNOT SILENTLY BECOME TRUSTED DATA. This file enforces
 *      that one. A `Quarantined<T>` refuses to become a string. Not "is escaped
 *      when it becomes a string" — REFUSES. Every implicit path a value takes to
 *      turn itself into text (`${x}`, `x + ""`, `String(x)`, `JSON.stringify(x)`,
 *      `x.toString()`) throws {@link QuarantineViolationError}.
 *
 * Why so blunt? Because the dangerous failure is the QUIET one. An invoice line
 * concatenated into a log, a prompt, a SQL string, or a dashboard cell is how
 * attacker text reaches something that reads it as instructions. Escaping is a
 * thing you must remember; a throw is a thing you cannot forget. The wrapper
 * turns "someone will eventually interpolate this" from a latent vulnerability
 * into a loud, immediate, test-visible crash.
 *
 * The ONLY way out is {@link declassify} with a total declassifier whose codomain
 * is small and enumerated (see declassify.ts). That bounds what an attacker can
 * achieve to the codomain itself — not to our skill at recognising bad strings.
 */
import { createHash } from "node:crypto";
import { stableEncode } from "./encode.js";

/**
 * Where a piece of untrusted content came from. Recorded for provenance, and to
 * make it legible in an audit trail WHICH untrusted channel a value entered by.
 * None of these are trusted; the label just says which door it walked through.
 */
export type QuarantineOrigin =
  /** Free text on an invoice (line items, memo, reference fields). */
  | "invoice_text"
  /** Body/subject of an email the agent read. */
  | "email_body"
  /** Content fetched from a web page or third-party API. */
  | "web_content"
  /** The model's own narration — untrusted precisely because it may be injected. */
  | "model_narration"
  /** A raw field off an inbound tool call, before validation. */
  | "tool_input_field";

/**
 * Thrown whenever quarantined content is coerced toward a primitive, or
 * declassified without an explicit declassifier.
 *
 * Reaching this error is not a bug in the quarantine layer — it is the layer
 * doing its job. It means some code path tried to turn attacker-controlled bytes
 * into a plain string where they could be read as instructions. Fix the call
 * site (declassify explicitly, or keep it opaque); do not soften this error.
 */
export class QuarantineViolationError extends Error {
  /** The origin of the content that was misused. Never the content itself. */
  readonly origin: QuarantineOrigin;
  /** Content-addressed id of the value, safe to log (a digest, not the bytes). */
  readonly contentId: string;

  constructor(message: string, origin: QuarantineOrigin, contentId: string) {
    super(
      `${message} [origin=${origin} contentId=${contentId}] — ` +
        `quarantined content cannot be coerced to a primitive. Use declassify() ` +
        `with a total declassifier, or keep the value opaque.`,
    );
    this.name = "QuarantineViolationError";
    this.origin = origin;
    this.contentId = contentId;
  }
}

/**
 * Stable, content-addressed id for a quarantined value.
 *
 * Uses `stableEncode` rather than JSON.stringify because this runs inside the
 * `Quarantined` constructor — i.e. at the trust boundary, on attacker-supplied
 * input. It must be total. See encode.ts for why that is load-bearing.
 */
function contentIdOf(value: unknown): string {
  return (
    "q_" +
    createHash("sha256").update(stableEncode(value), "utf8").digest("hex").slice(0, 16)
  );
}

/**
 * An opaque wrapper around untrusted content.
 *
 * A `Quarantined<T>` is deliberately hostile to use. It cannot be printed,
 * concatenated, serialised, compared, or interpolated. It has no `.value`
 * getter. The wrapped bytes leave only via {@link declassify}, which demands a
 * total function into a closed domain and produces an audit record.
 *
 * Everything below is a doorway a value normally uses to become a string, nailed
 * shut. The list is exhaustive on purpose: one open doorway is the whole hole.
 */
export class Quarantined<T> {
  /** The untrusted payload. Private (`#`) — unreachable from outside, even by cast. */
  readonly #value: T;

  /** Which untrusted channel this arrived on. */
  readonly origin: QuarantineOrigin;

  /** Content-addressed id. Safe to log/render: it is a digest, not the content. */
  readonly contentId: string;

  /** Brand, so structural typing can't mistake a plain object for a Quarantined. */
  readonly __quarantined = true as const;

  constructor(value: T, origin: QuarantineOrigin) {
    this.#value = value;
    this.origin = origin;
    this.contentId = contentIdOf(value);
    Object.freeze(this);
  }

  /**
   * Blocks `${q}`, `q + ""`, `+q`, `String(q)`, `q < other`, and every other
   * implicit coercion JS performs. This single method closes the most common
   * real-world injection path: attacker text sliding into a template literal.
   */
  [Symbol.toPrimitive](hint: string): never {
    throw new QuarantineViolationError(
      `refused to coerce quarantined content to a primitive (hint: ${hint})`,
      this.origin,
      this.contentId,
    );
  }

  /** Blocks `q.toString()` and implicit string conversion. */
  toString(): never {
    throw new QuarantineViolationError(
      "refused toString() on quarantined content",
      this.origin,
      this.contentId,
    );
  }

  /** Blocks `q.valueOf()` and numeric coercion. */
  valueOf(): never {
    throw new QuarantineViolationError(
      "refused valueOf() on quarantined content",
      this.origin,
      this.contentId,
    );
  }

  /**
   * Blocks `JSON.stringify(q)`. Critical: JSON.stringify is how a value most
   * often reaches a log line, an HTTP body, a prompt, or a dashboard payload.
   * Throwing here means quarantined content cannot be exfiltrated into any of
   * them by accident — a serialiser that meets one fails loudly.
   */
  toJSON(): never {
    throw new QuarantineViolationError(
      "refused JSON.stringify() of quarantined content",
      this.origin,
      this.contentId,
    );
  }

  /**
   * Renders as a redacted placeholder under `console.log` / `util.inspect`.
   *
   * Note this does NOT throw, unlike its siblings. Debugging and crash dumps
   * must stay usable, and inspection is not an injection sink — but it must
   * never print the bytes. You get the digest and the origin, never the content.
   */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `[Quarantined ${this.contentId} origin=${this.origin} — content withheld]`;
  }

  /**
   * The one sanctioned reader, and it is `#private`-adjacent by convention:
   * only declassify.ts calls it, via the module-internal accessor below.
   * There is intentionally no public getter.
   */
  static unwrapUnsafe<U>(q: Quarantined<U>): U {
    return q.#value;
  }
}

/**
 * Wrap untrusted content. Call this at the BOUNDARY — the moment bytes you did
 * not author enter the process (an invoice parsed, an email read, a web page
 * fetched) — not later. Anything between the boundary and the wrap is a window
 * where the raw string can leak into a sink.
 */
export function quarantine<T>(value: T, origin: QuarantineOrigin): Quarantined<T> {
  return new Quarantined(value, origin);
}

/** Type guard: is this value quarantined? */
export function isQuarantined(value: unknown): value is Quarantined<unknown> {
  return value instanceof Quarantined;
}
