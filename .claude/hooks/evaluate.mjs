#!/usr/bin/env node
// ============================================================================
// PreToolUse hook shim — .claude/hooks/evaluate.mjs
// ============================================================================
// The gate lives at hook/evaluate.mjs. This file is ONLY the wiring that
// .claude/settings.json points at.
//
// It used to be a byte-for-byte COPY of hook/evaluate.mjs. Two identical files —
// one of them the wired-up enforcement path, the other the one CLAUDE.md tells
// you to test against — is a drift bug waiting to happen: you fix the gate, your
// tests pass, and enforcement still runs the stale copy. Re-exporting means
// there is exactly one gate, and testing hook/evaluate.mjs tests the thing that
// actually runs.
//
// The import is bare (no logic here) so the fail-closed guarantee stays whole:
// hook/evaluate.mjs installs its own top-level catch, and a failure to even
// resolve this import exits non-zero, which is still a deny.
// ----------------------------------------------------------------------------
import "../../hook/evaluate.mjs";
