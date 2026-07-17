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

/**
 * Candidate paths of the wasm-pack output package, tried in order. The wasm pkg
 * lives at `packages/gate/wasm/pkg/`, but this module compiles to two different
 * depths depending on the tsconfig: `dist/wasm-kernel.js` (one level down → the
 * first candidate) and `dist-test/src/wasm-kernel.js` (two levels → the second).
 * Trying both is what makes the parity test actually RUN against the built wasm
 * instead of silently skipping — the bug that let the wasm kernel rot uncompiled.
 */
const WASM_PKG_SPECIFIERS = [
  "../wasm/pkg/ramp_gate_wasm.js", // dist/wasm-kernel.js
  "../../wasm/pkg/ramp_gate_wasm.js", // dist-test/src/wasm-kernel.js
] as const;

/** First candidate specifier that resolves from `require`, or null if none do. */
function resolveWasmPkg(require: NodeJS.Require): string | null {
  for (const spec of WASM_PKG_SPECIFIERS) {
    try {
      require.resolve(spec);
      return spec;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const NOT_BUILT_MESSAGE =
  'wasm kernel not built — run `pnpm --filter @ramp/gate build:wasm` ' +
  "(requires wasm-pack + cargo). The TS reference kernel is the always-available default.";

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
    const spec = resolveWasmPkg(require);
    if (spec === null) {
      throw new Error(NOT_BUILT_MESSAGE);
    }
    let mod: unknown;
    try {
      mod = require(spec);
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
    return resolveWasmPkg(require) !== null;
  } catch {
    return false;
  }
}
