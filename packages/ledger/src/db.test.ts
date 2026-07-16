/**
 * @ramp/ledger — db.test.ts
 *
 * REGRESSION TESTS FOR A FAIL-OPEN BUG. Read this before touching db.ts.
 *
 * The gate once ALLOWED a $400 spend that had to be denied, reporting
 * "daily 0 + 400 <= 1500" when the agent had in fact already spent 1140 today.
 * Nothing in the kernel was wrong. Two properties of the fact store combined:
 *
 *   1. `DEFAULT_DB_PATH` was the relative string "ramp.db", so it named a
 *      different file per process cwd. `pnpm db:reset` (cwd packages/ledger)
 *      seeded one file; the hook (cwd = repo root) opened another.
 *   2. `openLedger` auto-provisions an empty DB, so opening the WRONG path did
 *      not error — it manufactured a pristine ledger showing zero spend today.
 *
 * Zero spend today means the full daily budget is available. So a
 * misconfiguration didn't deny; it granted. These tests exist so that specific
 * failure can never return silently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import {
  openLedger,
  openLedgerStrict,
  closeLedger,
  resolveDbPath,
  isProvisioned,
  LedgerNotProvisionedError,
  DEFAULT_DB_PATH,
  IN_MEMORY_PATH,
} from "./db.js";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ramp-ledger-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("DEFAULT_DB_PATH is absolute — it cannot drift with process.cwd()", () => {
  assert.ok(
    isAbsolute(DEFAULT_DB_PATH),
    `DEFAULT_DB_PATH must be absolute, got "${DEFAULT_DB_PATH}". A relative path ` +
      `resolves per-caller and is how the hook and the seed came to read different files.`,
  );
  assert.ok(DEFAULT_DB_PATH.endsWith("ramp.db"));
});

test("the default path is identical no matter which directory we run from", () => {
  // THE ORIGINAL BUG, expressed directly: the same call from two different cwds
  // must name the same file. Under the old relative default this test fails.
  const original = process.cwd();
  try {
    const fromRepoRoot = resolveDbPath();
    process.chdir(tmpdir());
    const fromElsewhere = resolveDbPath();
    assert.equal(
      fromRepoRoot,
      fromElsewhere,
      "resolveDbPath() must be cwd-independent — the hook and `pnpm db:reset` " +
        "run from different directories and must agree on the ledger file.",
    );
  } finally {
    process.chdir(original);
  }
});

test("resolveDbPath precedence: explicit arg > $RAMP_DB_PATH > default", () => {
  const prior = process.env.RAMP_DB_PATH;
  try {
    delete process.env.RAMP_DB_PATH;
    assert.equal(resolveDbPath(), DEFAULT_DB_PATH);

    process.env.RAMP_DB_PATH = "/tmp/from-env.db";
    assert.equal(resolveDbPath(), "/tmp/from-env.db");
    assert.equal(resolveDbPath("/tmp/explicit.db"), "/tmp/explicit.db");

    // Relative inputs are resolved to absolute exactly once, here.
    assert.ok(isAbsolute(resolveDbPath("some/relative.db")));
    // The in-memory sentinel is passed through, never filesystem-resolved.
    assert.equal(resolveDbPath(IN_MEMORY_PATH), IN_MEMORY_PATH);
  } finally {
    if (prior === undefined) delete process.env.RAMP_DB_PATH;
    else process.env.RAMP_DB_PATH = prior;
  }
});

test("resolveDbPath treats an empty-string $RAMP_DB_PATH the same as unset", () => {
  // `RAMP_DB_PATH=$RAMP_DB_PATH some-command` sets the env var to "" (not
  // unset) whenever the variable was never exported in that shell — a common
  // shape in practice, and the exact failure a user hit: it silently resolved
  // to process.cwd() instead of falling back to DEFAULT_DB_PATH.
  const prior = process.env.RAMP_DB_PATH;
  try {
    process.env.RAMP_DB_PATH = "";
    assert.equal(resolveDbPath(), DEFAULT_DB_PATH);
    // An empty explicit argument must fall through to the (real) env value...
    process.env.RAMP_DB_PATH = "/tmp/from-env.db";
    assert.equal(resolveDbPath(""), "/tmp/from-env.db");
    // ...and to DEFAULT_DB_PATH when the env value is also empty/unset.
    process.env.RAMP_DB_PATH = "";
    assert.equal(resolveDbPath(""), DEFAULT_DB_PATH);
  } finally {
    if (prior === undefined) delete process.env.RAMP_DB_PATH;
    else process.env.RAMP_DB_PATH = prior;
  }
});

test("openLedgerStrict REFUSES a nonexistent ledger instead of conjuring one", () => {
  withTempDir((dir) => {
    const missing = join(dir, "does-not-exist.db");
    assert.throws(
      () => openLedgerStrict(missing),
      LedgerNotProvisionedError,
      "A missing fact store must deny, not self-seed. Auto-provisioning here is " +
        "what turned a wrong path into a fresh, permissive, zero-spend ledger.",
    );
  });
});

test("openLedgerStrict REFUSES an empty (schema-less) ledger file", () => {
  withTempDir((dir) => {
    const empty = join(dir, "empty.db");
    // Create a real but unprovisioned DB file, as a botched deploy might leave.
    const db = openLedger(empty, { provisionIfEmpty: false });
    closeLedger(db);
    assert.ok(existsSync(empty), "the file should exist but hold no facts");
    assert.throws(() => openLedgerStrict(empty), LedgerNotProvisionedError);
  });
});

test("openLedgerStrict opens a genuinely provisioned ledger", () => {
  withTempDir((dir) => {
    const path = join(dir, "seeded.db");
    closeLedger(openLedger(path, { provisionIfEmpty: true, seed: true }));

    const db = openLedgerStrict(path);
    try {
      assert.ok(isProvisioned(db));
    } finally {
      closeLedger(db);
    }
  });
});

test("the permissive default still auto-provisions for local dev convenience", () => {
  withTempDir((dir) => {
    // openLedger (non-strict) keeps its developer-friendly behaviour; only the
    // ENFORCEMENT path is strict. This documents that the split is deliberate.
    const db = openLedger(join(dir, "fresh.db"));
    try {
      assert.ok(isProvisioned(db));
    } finally {
      closeLedger(db);
    }
  });
});
