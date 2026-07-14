import type { Facts } from "./facts.js";
import type { Decision } from "./decision.js";

/**
 * @ramp/shared — PolicyKernel
 *
 * The single seam between "facts" and "allow/deny". BOTH the TS reference kernel
 * (the golden oracle, always available) and the WASM-backed kernel (compiled from
 * `policy.dl`) implement this exact interface. Callers depend only on this type,
 * never on which implementation is behind it.
 *
 * Contract:
 *   - `evaluate` is SYNCHRONOUS and PURE: no I/O, no clock, no randomness.
 *   - It is DETERMINISTIC: identical `Facts` -> identical `Decision`, every time.
 *   - `deny` dominates: any deny rule makes the decision `"deny"`.
 */
export interface PolicyKernel {
  evaluate(facts: Facts): Decision;
}

/** The kind of kernel implementation, for diagnostics/telemetry. */
export type KernelKind = "ts-reference" | "wasm-souffle";

/** A kernel plus metadata about which implementation is behind the interface. */
export interface DescribedKernel {
  readonly kind: KernelKind;
  readonly kernel: PolicyKernel;
}
