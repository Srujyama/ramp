/**
 * @ramp/ledger — scripts/init-db.ts
 *
 * Local-dev DB bootstrapper, wired to `pnpm --filter @ramp/ledger db:reset`
 * (and `db:init`). Creates a fresh `./ramp.db` provisioned from
 * `sql/schema.sql` + `sql/seed.sql`.
 *
 * IDEMPOTENT by RESET: if the target file already exists it is deleted first, so
 * re-running always yields the same clean, seeded scenario (the seed INSERTs are
 * not themselves idempotent, so we start from a blank file every time).
 *
 * Usage:
 *   node dist/scripts/init-db.js            # -> ./ramp.db
 *   node dist/scripts/init-db.js my.db      # -> ./my.db
 */
import { rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  openLedger,
  closeLedger,
  DEFAULT_DB_PATH,
  isProvisioned,
} from "../src/db.js";

function main(): void {
  const target = resolve(process.argv[2] ?? DEFAULT_DB_PATH);

  if (existsSync(target)) {
    rmSync(target, { force: true });
    // Best-effort cleanup of SQLite sidecar files from prior WAL runs.
    rmSync(`${target}-wal`, { force: true });
    rmSync(`${target}-shm`, { force: true });
  }

  const db = openLedger(target, { provisionIfEmpty: true, seed: true });
  const ok = isProvisioned(db);
  closeLedger(db);

  if (!ok) {
    console.error(`@ramp/ledger: FAILED to provision ${target}`);
    process.exit(1);
  }
  console.log(`@ramp/ledger: initialized seeded DB at ${target}`);
}

main();
