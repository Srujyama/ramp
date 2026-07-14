/**
 * @ramp/gate — public entry point
 *
 * Exposes ONE `PolicyKernel` over two implementations:
 *   - `ReferenceKernel` (golden oracle, pure TS, always available), and
 *   - `WasmKernel` (Souffle `datalog/policy.dl` compiled to WASM; optional).
 *
 * Every caller (the .claude hook, the dashboard, tests) depends only on the
 * `PolicyKernel` interface and calls `getKernel()` — it is implementation-agnostic.
 *
 * Selection policy (`getKernel`):
 *   returns the wasm-backed kernel IFF `process.env.RAMP_KERNEL === "wasm"`
 *   AND the built artifact (`wasm/pkg`) is resolvable; otherwise returns the
 *   ts-reference kernel. This keeps `pnpm -r build/test/typecheck` green with
 *   NO souffle/wasm-pack present (the reference kernel covers everything).
 */
import type { Facts, Decision, DescribedKernel, PolicyKernel } from "@ramp/shared";
import { ReferenceKernel, referenceKernel } from "./reference-kernel.js";
import { WasmKernel, isWasmKernelAvailable } from "./wasm-kernel.js";

export { ReferenceKernel, referenceKernel } from "./reference-kernel.js";
export { WasmKernel, isWasmKernelAvailable } from "./wasm-kernel.js";

/** A `DescribedKernel` wrapping the always-available reference implementation. */
const REFERENCE_DESCRIBED: DescribedKernel = {
  kind: "ts-reference",
  kernel: referenceKernel,
};

/**
 * Returns the active kernel plus metadata about which implementation is behind it.
 *
 * The wasm kernel is chosen only when explicitly opted into (`RAMP_KERNEL=wasm`)
 * AND its compiled artifact is present. If opted in but not built, we FAIL SAFE to
 * the reference oracle rather than throwing — the reference kernel is byte-for-byte
 * equivalent (the parity test enforces this), so the gate never goes dark.
 */
export function getKernel(): DescribedKernel {
  const wantWasm = process.env.RAMP_KERNEL === "wasm";
  if (wantWasm && isWasmKernelAvailable()) {
    return { kind: "wasm-souffle", kernel: new WasmKernel() };
  }
  return REFERENCE_DESCRIBED;
}

/**
 * Convenience helper: evaluate a single `Facts` object with the currently active
 * kernel. Equivalent to `getKernel().kernel.evaluate(facts)`.
 */
export function evaluateFacts(facts: Facts): Decision {
  return getKernel().kernel.evaluate(facts);
}

/** Re-export the interface type for downstream typing convenience. */
export type { PolicyKernel };
