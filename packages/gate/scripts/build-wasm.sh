#!/usr/bin/env bash
# ============================================================================
# @ramp/gate — OPTIONAL wasm kernel build
# ============================================================================
# Compiles the Souffle policy program (datalog/policy.dl) into a native C++
# evaluator, then wraps it in a Rust cdylib and compiles THAT to WebAssembly via
# wasm-pack, emitting the loadable package to `wasm/pkg`.
#
# This is OPTIONAL. The TS reference kernel is always present and is the default,
# so `pnpm -r build/test/typecheck` must stay green WITHOUT souffle or wasm-pack.
# Therefore: if either tool is missing, we print install instructions and exit 0
# (a no-op) so `pnpm -r` never breaks. We only exit non-zero on a genuine build
# failure once the toolchain IS present.
# ----------------------------------------------------------------------------
set -euo pipefail

# Resolve paths relative to THIS script so it works from any cwd (no hardcoding).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
POLICY_DL="${GATE_DIR}/datalog/policy.dl"
WASM_CRATE_DIR="${GATE_DIR}/wasm"
GEN_DIR="${WASM_CRATE_DIR}/generated"
PKG_DIR="${WASM_CRATE_DIR}/pkg"

have() { command -v "$1" >/dev/null 2>&1; }

missing=()
have souffle  || missing+=("souffle")
have wasm-pack || missing+=("wasm-pack")
have cargo     || missing+=("cargo")

if [ "${#missing[@]}" -ne 0 ]; then
  echo "[build-wasm] optional toolchain missing: ${missing[*]}"
  echo "[build-wasm] the TS reference kernel is the default; skipping wasm build (no-op)."
  echo ""
  echo "  To build the wasm kernel, install the missing tools:"
  echo "    - souffle:   https://souffle-lang.github.io/install   (e.g. 'brew install souffle')"
  echo "    - rust/cargo: https://rustup.rs                        (curl https://sh.rustup.rs -sSf | sh)"
  echo "    - wasm-pack: https://rustwasm.github.io/wasm-pack/installer/"
  echo "    - wasm target: 'rustup target add wasm32-unknown-unknown'"
  echo ""
  echo "  Then re-run: pnpm --filter @ramp/gate build:wasm"
  exit 0
fi

if [ ! -f "${POLICY_DL}" ]; then
  echo "[build-wasm] ERROR: policy program not found at ${POLICY_DL}" >&2
  exit 1
fi

echo "[build-wasm] toolchain present — compiling policy.dl -> C++ ..."
mkdir -p "${GEN_DIR}"

# 1) Souffle: emit a compilable C++ evaluator from the Datalog program.
#    -g writes a self-contained C++ file the Rust crate links against.
souffle -g "${GEN_DIR}/policy.cpp" "${POLICY_DL}"

echo "[build-wasm] compiling Rust cdylib -> wasm via wasm-pack ..."
# 2) wasm-pack builds the crate in wasm/ (which #[wasm_bindgen]-wraps the engine)
#    into wasm/pkg as an ES module consumable by wasm-kernel.ts.
(
  cd "${WASM_CRATE_DIR}"
  wasm-pack build --target nodejs --out-dir "${PKG_DIR}" --out-name ramp_gate_wasm
)

echo "[build-wasm] done. Artifact at ${PKG_DIR}"
echo "[build-wasm] verify parity with: pnpm --filter @ramp/gate test:parity"
