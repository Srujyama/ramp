/**
 * @ramp/gate — WasmKernel
 *
 * The WASM-backed policy kernel: same `PolicyKernel` interface as the reference
 * kernel, but its allow/deny logic is the Souffle program in `datalog/policy.dl`
 * compiled to native C++ and then to WebAssembly (see `scripts/build-wasm.sh`
 * and `wasm/`). Callers never depend on which implementation is behind the
 * interface — `getKernel()` in `index.ts` selects it.
 *
 * Phase 0 (this repo, no souffle/wasm-pack on the machine): the compiled artifact
 * at `../wasm/pkg` does not exist. This class is an HONEST STUB — it NEVER fakes a
 * result and NEVER silently degrades. If the artifact is missing it throws a clear,
 * actionable error telling you to run the optional build. `getKernel()` only
 * constructs this when the artifact is actually present, so in practice the throw
 * is a guardrail for direct/mistaken use.
 */
import { createRequire } from "node:module";
import type { Facts, Decision, PolicyKernel, RuleId } from "@ramp/shared";

/** Path (relative to the built dist/) of the wasm-pack output package. */
const WASM_PKG_SPECIFIER = "../wasm/pkg/ramp_gate_wasm.js";

const NOT_BUILT_MESSAGE =
  'wasm kernel not built — run `pnpm --filter @ramp/gate build:wasm` ' +
  "(requires souffle + wasm-pack). The TS reference kernel is the always-available default.";

/**
 * The FFI shape the wasm-pack module is expected to expose: a single
 * `evaluate(facts_json: string) -> decision_json: string` entry point
 * (see `wasm/src/lib.rs`), keeping structured data across the WASM boundary
 * as JSON strings.
 */
interface RampGateWasmModule {
  evaluate(factsJson: string): string;
}

/** Narrow the JSON that came back across the WASM boundary into a `Decision`. */
function parseDecision(json: string): Decision {
  const raw: unknown = JSON.parse(json);
  if (typeof raw !== "object" || raw === null) {
    throw new Error("wasm kernel returned a non-object decision");
  }
  const r = raw as Record<string, unknown>;
  // The lattice is three-valued: deny > escalate > allow. `escalate` is a real
  // outcome the Rust kernel returns (wasm/src/lib.rs) — omitting it here made the
  // WASM kernel THROW on every held payment. Kept in sync with DecisionOutcome.
  if (r.decision !== "allow" && r.decision !== "deny" && r.decision !== "escalate") {
    throw new Error(`wasm kernel returned an invalid decision outcome: ${String(r.decision)}`);
  }
  if (!Array.isArray(r.reasons) || !r.reasons.every((x) => typeof x === "string")) {
    throw new Error("wasm kernel returned a malformed `reasons` array");
  }
  if (!Array.isArray(r.firedRules) || !r.firedRules.every((x) => typeof x === "string")) {
    throw new Error("wasm kernel returned a malformed `firedRules` array");
  }
  return {
    decision: r.decision,
    reasons: r.reasons as readonly string[],
    firedRules: r.firedRules as readonly RuleId[],
  };
}

/**
 * Loads and drives the compiled Souffle-in-WASM kernel.
 *
 * The module is loaded lazily on construction. If the compiled package is
 * absent the constructor throws `NOT_BUILT_MESSAGE` — honest, never a stub result.
 */
export class WasmKernel implements PolicyKernel {
  readonly #module: RampGateWasmModule;

  constructor() {
    const require = createRequire(import.meta.url);
    let mod: unknown;
    try {
      mod = require(WASM_PKG_SPECIFIER);
    } catch (cause) {
      throw new Error(NOT_BUILT_MESSAGE, { cause });
    }
    if (
      typeof mod !== "object" ||
      mod === null ||
      typeof (mod as Record<string, unknown>).evaluate !== "function"
    ) {
      throw new Error(
        "wasm kernel artifact found but does not export an `evaluate` function — rebuild with build:wasm",
      );
    }
    this.#module = mod as RampGateWasmModule;
  }

  evaluate(facts: Facts): Decision {
    const json = this.#module.evaluate(JSON.stringify(facts));
    return parseDecision(json);
  }
}

/**
 * Returns true iff the compiled wasm artifact is resolvable from here. Used by
 * `getKernel()` to decide whether the wasm impl can be selected. Never throws.
 */
export function isWasmKernelAvailable(): boolean {
  try {
    const require = createRequire(import.meta.url);
    require.resolve(WASM_PKG_SPECIFIER);
    return true;
  } catch {
    return false;
  }
}
