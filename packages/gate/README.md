# `@ramp/gate` — the policy kernel

The hero of Provable Agent Spend: a **deterministic** allow/deny kernel for a
single spend request. Given a `Facts` object (from `@ramp/shared`, sourced only
from authoritative stores — never model narration), it returns a `Decision`
(`allow` / `deny` + reasons + fired rule ids).

> **Same facts in → same answer out, every time.** No I/O, no clock, no
> randomness. That is the whole security argument.

## One interface, two implementations

Every caller depends only on the `PolicyKernel` interface and gets it via
`getKernel()`:

| Implementation    | `kind`         | When used                                            | Availability |
| ----------------- | -------------- | ---------------------------------------------------- | ------------ |
| `ReferenceKernel` | `ts-reference` | default; the golden oracle                            | always (0 deps) |
| `WasmKernel`      | `wasm-souffle` | `RAMP_KERNEL=wasm` **and** `wasm/pkg` is built        | optional     |

The reference kernel is a **line-for-line mirror** of `datalog/policy.dl` and is
always present, so `pnpm -r build/test/typecheck` is green with no souffle /
wasm-pack. If `RAMP_KERNEL=wasm` is set but the artifact is not built,
`getKernel()` fails safe to the reference kernel (the two are proven equivalent
by the parity test), so the gate never goes dark.

## Usage

```ts
import { getKernel, evaluateFacts } from "@ramp/gate";
import type { Facts } from "@ramp/shared";

const facts: Facts = /* from the ledger fact source, via @ramp/shared translate */;

// Either drive the described kernel...
const { kind, kernel } = getKernel();
const decision = kernel.evaluate(facts);

// ...or the convenience helper:
const same = evaluateFacts(facts);

if (decision.decision === "deny") {
  console.error("blocked:", decision.reasons, decision.firedRules);
}
```

## The rules (mirror of `datalog/policy.dl`)

Evaluated in this **fixed order** (order affects only the reason list — deny
dominates regardless of order):

1. `deny/vendor_not_verified` — vendor absent/unverified in the registry.
2. `deny/over_per_txn_cap` — `amount > per_txn_cap`.
3. `deny/category_not_approved` — category not on the org's approved list.
4. `deny/agent_uncleared_for_category` — agent not cleared for the category.
5. `deny/daily_limit_exceeded` — `daily_total_so_far + amount > daily_limit`.

`allow/all_conditions_met` fires iff no deny fires (i.e. `amount <= cap`, category
approved, agent cleared, vendor verified, and `daily_total + amount <= limit`).

All money is **integer whole currency units** so the arithmetic is exact.

## Determinism & deny-dominates

- `evaluate` is synchronous and pure — identical `Facts` yield a deep-equal
  `Decision`, verified by the golden tests.
- Any deny trigger makes the decision `"deny"`; multiple triggers all appear in
  `reasons`/`firedRules`, in the fixed order above.

## Scripts

```
pnpm --filter @ramp/gate build       # tsc -> dist
pnpm --filter @ramp/gate test        # node:test golden cases (reference kernel)
pnpm --filter @ramp/gate typecheck   # tsc --noEmit
pnpm --filter @ramp/gate build:wasm  # OPTIONAL: compile policy.dl -> wasm (no-op if toolchain absent)
pnpm --filter @ramp/gate test:parity # OPTIONAL: cross-check wasm vs reference (skips if wasm/pkg absent)
```

## Layout

```
datalog/policy.dl        the REAL Souffle program (source of truth)
src/reference-kernel.ts  ReferenceKernel — golden oracle, always available
src/wasm-kernel.ts       WasmKernel — loads wasm/pkg; honest error if not built
src/index.ts             getKernel(), evaluateFacts(), re-exports
scripts/build-wasm.sh    optional wasm build (guarded; no-op without toolchain)
wasm/                    Rust->WASM crate scaffold (compiles the kernel)
```

The wasm path is **optional**; the reference kernel is the default and the oracle.
