#!/usr/bin/env bash
# ============================================================================
# @ramp/gate — OPTIONAL wasm kernel build
# ============================================================================
# Compiles the Rust policy kernel (wasm/src/lib.rs) to WebAssembly via wasm-pack,
# emitting a Node-loadable package to wasm/pkg.
#
# WHAT THE RUST KERNEL IS (stated plainly, because provability doesn't get to
# hand-wave): it is a HAND-WRITTEN mirror of datalog/policy.dl — the same rules,
# the same fixed evaluation order, the same byte-stable reason strings — exactly
# like the TS reference kernel is. It is NOT the Souffle program compiled to C++;
# `policy.dl` is the executable SPEC that all mirrors are checked against. Their
# equivalence is not asserted, it is TESTED: `test/parity.test.ts` cross-checks
# this WASM kernel against the reference kernel on the golden cases AND 4000
# randomized fact sets, and CI fails if they diverge by so much as a reason typo.
# (That test caught three real drifts the first time it actually ran.)
#
# This build is OPTIONAL. The TS reference kernel is always present and is the
# default, so `pnpm -r build/test/typecheck` stays green WITHOUT wasm-pack. If the
# toolchain is missing we print install hints and exit 0 (a no-op) so `pnpm -r`
# never breaks. We only exit non-zero on a genuine build failure once wasm-pack
# and cargo ARE present.
# ----------------------------------------------------------------------------
set -euo pipefail

# Resolve paths relative to THIS script so it works from any cwd (no hardcoding).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WASM_CRATE_DIR="${GATE_DIR}/wasm"
PKG_DIR="${WASM_CRATE_DIR}/pkg"

have() { command -v "$1" >/dev/null 2>&1; }

# The Rust kernel is standalone (only wasm-bindgen + serde) — no Souffle, no C++
# toolchain, no build.rs. It needs cargo + wasm-pack + the wasm32 target.
missing=()
have wasm-pack || missing+=("wasm-pack")
have cargo     || missing+=("cargo")

if [ "${#missing[@]}" -ne 0 ]; then
  echo "[build-wasm] optional toolchain missing: ${missing[*]}"
  echo "[build-wasm] the TS reference kernel is the default; skipping wasm build (no-op)."
  echo ""
  echo "  To build the wasm kernel, install the missing tools:"
  echo "    - rust/cargo:  https://rustup.rs        (curl https://sh.rustup.rs -sSf | sh)"
  echo "    - wasm target: rustup target add wasm32-unknown-unknown"
  echo "    - wasm-pack:   https://rustwasm.github.io/wasm-pack/installer/  (or 'cargo install wasm-pack')"
  echo ""
  echo "  Then re-run: pnpm --filter @ramp/gate build:wasm"
  exit 0
fi

if [ ! -f "${WASM_CRATE_DIR}/src/lib.rs" ]; then
  echo "[build-wasm] ERROR: Rust kernel not found at ${WASM_CRATE_DIR}/src/lib.rs" >&2
  exit 1
fi

echo "[build-wasm] compiling the Rust policy kernel -> wasm via wasm-pack ..."
(
  cd "${WASM_CRATE_DIR}"
  wasm-pack build --target nodejs --out-dir "${PKG_DIR}" --out-name ramp_gate_wasm
)

echo "[build-wasm] done. Artifact at ${PKG_DIR}"
echo "[build-wasm] verify parity with: pnpm --filter @ramp/gate test:parity"
