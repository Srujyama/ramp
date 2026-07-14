# `@ramp/gate` wasm crate (optional)

This crate compiles the Souffle policy program (`../datalog/policy.dl`) into a
WebAssembly module exposing a single boundary function:

```
evaluate(facts_json: string) -> decision_json: string
```

which the TypeScript `WasmKernel` (`../src/wasm-kernel.ts`) loads and calls. The
allow/deny logic mirrors `policy.dl` exactly (deny dominates; fixed deny order:
vendor, per_txn_cap, category, agent, daily), so it is byte-for-byte equivalent
to the TS reference oracle — the parity test (`pnpm --filter @ramp/gate test:parity`)
enforces this.

## This is optional

The **TS reference kernel is the default and is always available.** You do not
need to build this crate to use, test, or ship the gate. Building it is only
required if you want to run the actual Souffle/WASM implementation behind the
`PolicyKernel` interface (select it with `RAMP_KERNEL=wasm`).

## Build

From the repo root:

```
pnpm --filter @ramp/gate build:wasm
```

That runs `../scripts/build-wasm.sh`, which:

1. Checks for `souffle`, `wasm-pack`, and `cargo`. If any is missing it prints
   install instructions and exits 0 (no-op) so `pnpm -r` never breaks.
2. Runs `souffle -g` to generate a C++ evaluator from `policy.dl`.
3. Runs `wasm-pack build --target nodejs` to produce `pkg/` — the loadable ES
   module `WasmKernel` imports (`pkg/ramp_gate_wasm.js`).

### Prerequisites

- souffle: <https://souffle-lang.github.io/install> (e.g. `brew install souffle`)
- rust/cargo: <https://rustup.rs>
- wasm-pack: <https://rustwasm.github.io/wasm-pack/installer/>
- wasm target: `rustup target add wasm32-unknown-unknown`

## Output

`pkg/` (gitignored — see root `.gitignore` `packages/gate/wasm/pkg`). Absent it,
`getKernel()` falls back to the reference kernel automatically.
