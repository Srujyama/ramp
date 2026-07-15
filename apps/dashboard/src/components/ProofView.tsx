import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Facts } from "@ramp/shared";
import type {
  BundleVerification,
  DecisionBundle,
  Derivation,
  FactProvenance,
} from "@ramp/provenance/core";
import { fetchBundles, verifyInBrowser } from "../verify.js";

/**
 * The Proof view — PITCH.md demo beat 5: "This is what you show an auditor."
 *
 * Renders decision -> facts -> each fact's authoritative source, and re-derives
 * every verdict in the browser (see ../verify.ts). The green "VERIFIED" badge is
 * not something the server told us; it is the result of re-running the real
 * policy kernel on the recorded facts, right here.
 */

/** One derivation, rendered as the specific place a value came from. */
function DerivationLine({ d }: { d: Derivation }): JSX.Element {
  switch (d.kind) {
    case "structured_arg":
      return (
        <span className="prov">
          <span className="badge info">tool arg</span>{" "}
          <code>tool_input.{d.field}</code>
        </span>
      );
    case "sql":
      return (
        <span className="prov">
          <span className="badge info">ledger</span> <code>{d.table}</code>
          <div className="prov-sql">
            <code>{d.query}</code>
            {d.params.length > 0 && (
              <span className="prov-params"> ← [{d.params.join(", ")}]</span>
            )}
          </div>
        </span>
      );
    case "attestation":
      return (
        <span className="prov">
          <span className={`badge ${d.verified ? "allow" : "deny"}`}>
            attestation {d.verified ? "verified" : "invalid"}
          </span>{" "}
          <code>key={d.notaryKeyId}</code>{" "}
          <code className="dim">stmt={d.statementDigest.slice(0, 12)}…</code>
        </span>
      );
    case "declassified":
      return (
        <span className="prov">
          <span className={`badge ${d.admitted ? "allow" : "warn"}`}>
            declassified
          </span>{" "}
          <code>{d.declassifier}</code>
          <div className="prov-sql">
            <span className="prov-params">
              codomain: {d.codomain} · content {d.contentId} ·{" "}
              {d.admitted ? "admitted" : "REFUSED (stayed quarantined)"}
            </span>
          </div>
        </span>
      );
    case "constant":
      return (
        <span className="prov">
          <span className="badge info">constant</span> {d.note}
        </span>
      );
  }
}

function formatValue(v: FactProvenance["value"]): string {
  return Array.isArray(v) ? `[${v.join(", ")}]` : String(v);
}

function BundleCard({ bundle }: { bundle: DecisionBundle }): JSX.Element {
  const [v, setV] = useState<BundleVerification | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void verifyInBrowser(bundle).then((result) => {
      if (alive) setV(result);
    });
    return () => {
      alive = false;
    };
  }, [bundle]);

  const denied = bundle.decision.decision === "deny";
  const byFact = new Map(bundle.provenance.map((p) => [p.fact, p]));
  const factKeys = Object.keys(bundle.facts) as (keyof Facts)[];

  return (
    <div className="card proof-card">
      <div className="proof-head" onClick={() => setOpen((o) => !o)} role="button" tabIndex={0}
           onKeyDown={(e) => e.key === "Enter" && setOpen((o) => !o)}>
        <div>
          <span className={`badge ${denied ? "deny" : "allow"}`}>
            {bundle.decision.decision.toUpperCase()}
          </span>{" "}
          <code>{bundle.requestId}</code>
        </div>
        <div className="proof-head-right">
          {v === null ? (
            <span className="badge info">verifying…</span>
          ) : v.valid ? (
            <span className="badge allow" title="Re-derived in this browser">
              ✓ VERIFIED IN BROWSER
            </span>
          ) : (
            <span className="badge deny">✗ {v.defects.length} DEFECT(S)</span>
          )}
          <span className="dim"> {open ? "▾" : "▸"}</span>
        </div>
      </div>

      <div className="proof-rules">
        {bundle.decision.firedRules.map((r) => (
          <span key={r} className={`badge ${r.startsWith("allow/") ? "allow" : "deny"}`}>
            {r}
          </span>
        ))}
      </div>

      {v && !v.valid && (
        <ul className="defects">
          {v.defects.map((d, i) => (
            <li key={i}>
              <code>{d.code}</code> {d.detail}
            </li>
          ))}
        </ul>
      )}

      {v?.valid && (
        <p className="card-sub verified-note">
          Your browser re-ran the policy kernel on the recorded facts and
          independently reproduced <strong>{bundle.decision.decision}</strong>.
          Nothing was altered after sealing, and every fact names an
          authoritative source. You did not have to trust the gate.
        </p>
      )}

      {open && (
        <table className="facts-table">
          <thead>
            <tr>
              <th>Fact</th>
              <th>Value</th>
              <th>Where it came from</th>
            </tr>
          </thead>
          <tbody>
            {factKeys.map((key) => {
              const p = byFact.get(key);
              return (
                <tr key={String(key)}>
                  <td>
                    <code>{String(key)}</code>
                  </td>
                  <td className="val">
                    {p ? formatValue(p.value) : String(bundle.facts[key])}
                  </td>
                  <td>
                    {p ? (
                      <DerivationLine d={p.derivation} />
                    ) : (
                      <span className="badge deny">
                        NO PROVENANCE — origin unaccounted for
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="proof-foot dim">
        facts <code>{bundle.factsDigest.slice(0, 16)}…</code> · bundle{" "}
        <code>{bundle.bundleDigest.slice(0, 16)}…</code> · {bundle.kernel.kind} kernel ·{" "}
        {bundle.evaluatedAt}
      </div>
    </div>
  );
}

export function ProofView(): JSX.Element {
  const [bundles, setBundles] = useState<DecisionBundle[] | null>(null);
  const [dir, setDir] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchBundles()
      .then((r) => {
        setBundles(r.bundles);
        setDir(r.bundleDir);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="card">
        <div className="empty">
          <div className="em-icon" aria-hidden="true">
            ⚠
          </div>
          <h4>Could not load bundles</h4>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (bundles === null) {
    return (
      <div className="card">
        <div className="empty">
          <h4>Loading…</h4>
        </div>
      </div>
    );
  }

  if (bundles.length === 0) {
    return (
      <div className="card">
        <div className="empty">
          <div className="em-icon" aria-hidden="true">
            ❖
          </div>
          <h4>No decisions sealed yet</h4>
          <p>
            The gate seals a provenance bundle every time it decides. Run{" "}
            <code>pnpm demo</code> to drive the pitch&apos;s beats through the
            real hook, then reload. Bundles are read from <code>{dir}</code>.
          </p>
        </div>
      </div>
    );
  }

  const verifiedCount = bundles.length;
  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h3>How to read this</h3>
        <p className="card-sub">
          Each card below is a <strong>decision bundle</strong> the gate sealed at
          enforce time. Your browser re-derives every verdict from the recorded
          facts using the real policy kernel, and recomputes the digests with
          WebCrypto — nothing here is a claim the server made. Expand a card to
          trace each fact back to the exact query, notary, or declassifier it came
          from.
        </p>
        <div className="pill-row">
          <span className="badge info">{verifiedCount} bundle(s)</span>
          <span className="badge info">re-derived client-side</span>
          <span className="badge info">{dir}</span>
        </div>
      </div>
      {bundles.map((b) => (
        <BundleCard key={b.bundleDigest} bundle={b} />
      ))}
    </>
  );
}

export default ProofView;
