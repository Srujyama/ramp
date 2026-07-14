/**
 * @ramp/shared — barrel
 *
 * The single import surface every other workspace (`@ramp/gate`, `@ramp/ledger`,
 * `@ramp/payments-mcp`, `@ramp/dashboard`, and the `.claude` hook) depends on.
 * This package has ZERO runtime dependencies; it is pure contract + a couple of
 * pure functions/guards.
 */

// Facts — the closed, authoritative fact set (maps 1:1 to policy.dl relations).
export type { Facts, FactSource } from "./facts.js";
export { FACT_SOURCES } from "./facts.js";

// Decision — the kernel's output shape + rule identifiers + narrow helpers.
export type { Decision, DecisionOutcome, RuleId } from "./decision.js";
export { isAllowed, isDenied } from "./decision.js";

// PolicyKernel — the single seam between facts and allow/deny.
export type { PolicyKernel, KernelKind, DescribedKernel } from "./kernel.js";

// SpendRequest — the untrusted tool_input transport + its runtime guard.
export type { SpendRequest } from "./spend-request.js";
export { isSpendRequest } from "./spend-request.js";

// Fact translation — the anti-injection seam (untrusted keys + authoritative DB facts).
export type {
  AuthoritativeFacts,
  AuthoritativeContext,
  AuthoritativeFactSource,
  TranslateOptions,
} from "./translate.js";
export { translateToFacts, factsFromContext } from "./translate.js";
