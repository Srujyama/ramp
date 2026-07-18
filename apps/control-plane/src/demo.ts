/**
 * @ramp/control-plane — the "Enable Dummy Data" toggle
 *
 * ============================================================================
 * DEMO-ONLY, LIKE EVERYTHING ELSE IN THIS PACKAGE. NEVER A FACT, NEVER A GATE.
 * ============================================================================
 * The dashboard opens empty until a real payment happens. This toggle exists so
 * a first look at the console shows a populated week of activity, not a wall of
 * "no decisions yet" empty states. It is fully reversible from the UI:
 *
 *   enabled=true  -> `seedDemoHistory` (packages/ledger/src/demo-data.ts): ~90 days
 *                    of synthetic REQUESTS, each still judged by the REAL kernel,
 *                    proof-sealed, and hash-chained. Not a fabricated verdict.
 *   enabled=false -> `clearDemoHistory`: wipes the decision log + its projected
 *                    spend and restores the base seed's calibrated ledger_entries —
 *                    a clean chain restart, because the hash chain cannot tolerate
 *                    a surgical delete from its middle. See demo-data.ts for why
 *                    that is safe here and would not be on a real ledger.
 *
 * Both directions can take a little while (seeding writes ~900 real, proof-sealed
 * decisions); the handler runs them synchronously and reports what happened.
 */
import { seedDemoHistory, clearDemoHistory, type LedgerDb } from "@ramp/ledger";

export interface SetDemoDataInput {
  readonly enabled: boolean;
}

export interface SetDemoDataResult {
  readonly enabled: boolean;
  readonly written?: number;
  readonly days?: number;
  readonly problems?: readonly string[];
}

/** Parse an untrusted `{ enabled }` body. Shape only. */
export function parseSetDemoData(body: unknown): SetDemoDataInput | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (typeof b.enabled !== "boolean") return { error: "enabled must be a boolean" };
  return { enabled: b.enabled };
}

/** Drive the toggle. Errors from the generator (should not happen; see problems[] for soft failures). */
export function runSetDemoData(db: LedgerDb, body: unknown): SetDemoDataResult | { error: string } {
  const parsed = parseSetDemoData(body);
  if ("error" in parsed) return parsed;
  try {
    if (!parsed.enabled) {
      clearDemoHistory(db);
      return { enabled: false };
    }
    const result = seedDemoHistory(db);
    return { enabled: true, written: result.written, days: result.days, problems: result.problems };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
