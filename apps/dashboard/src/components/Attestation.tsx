import type { JSX } from "react";
import { ShieldCheck, ShieldQuestion, ShieldX, ShieldOff, Users } from "lucide-react";
import type { DecisionView, AttestationStatus } from "../lib/types.js";
import { vendorLabel, vendorDomain } from "../lib/identity.js";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card.js";
import { Badge } from "./ui/badge.js";

const META: Record<AttestationStatus, { label: string; tone: "accent" | "warn" | "deny" | "neutral"; icon: JSX.Element; blurb: string }> = {
  verified: {
    label: "Verified",
    tone: "accent",
    icon: <ShieldCheck className="size-5" />,
    blurb: "A notary's Ed25519 signature was checked AND the signed statement binds to this exact vendor, amount, and invoice.",
  },
  present_unverified: {
    label: "Present · unverified",
    tone: "warn",
    icon: <ShieldQuestion className="size-5" />,
    blurb: "An attestation accompanied the request but was not verified — a signature that isn't checked proves nothing.",
  },
  verification_failed: {
    label: "Verification failed",
    tone: "deny",
    icon: <ShieldX className="size-5" />,
    blurb: "An attestation was present but failed verification — a forged signature, or a real signature that binds to a different statement (the spoof).",
  },
  absent: {
    label: "Absent",
    tone: "neutral",
    icon: <ShieldOff className="size-5" />,
    blurb: "No attestation accompanied this request. Nothing cryptographic ties the invoice to the vendor's registered domain.",
  },
};

/**
 * Pillar 4 on the decision page: the notary attestation, and why the gate trusts
 * or refuses it. The point is BINDING, not just a signature — a perfect signature
 * over a lookalike domain still fails, because the statement must bind to the
 * vendor's own registered domain. Data comes straight off the recorded proof.
 */
export function Attestation({ v }: { v: DecisionView }): JSX.Element {
  const status: AttestationStatus =
    v.proof?.attestationStatus ?? (v.attestationPresent ? "present_unverified" : "absent");
  const m = META[status];
  const provider = v.proof?.attestationProvider;
  const domain = vendorDomain(v.vendorId);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Attestation</CardTitle>
          <CardDescription>The cryptographic root of trust — a signed statement bound to the vendor.</CardDescription>
        </div>
        <span className={"text-" + (m.tone === "accent" ? "lime" : m.tone === "warn" ? "amber" : m.tone === "deny" ? "flag" : "ink-faint")}>
          {m.icon}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3.5 pt-4">
        <div className="flex items-center gap-2.5">
          <Badge tone={m.tone}>{m.label}</Badge>
          {provider ? (
            <span className="text-[12.5px] text-ink-muted">
              via <span className="font-mono text-[12px] text-ink">{provider}</span>
            </span>
          ) : null}
        </div>

        <p className="text-[13px] leading-relaxed text-ink-muted">{m.blurb}</p>

        <div className="flex flex-col gap-1.5 border-t border-line pt-3 text-[12.5px]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-ink-faint">Must bind to</span>
            <span className="text-right text-ink">
              {vendorLabel(v.vendorId)}
              {domain ? <span className="ml-1.5 font-mono text-[11.5px] text-ink-muted">{domain}</span> : null}
            </span>
          </div>
          <p className="text-[12px] text-ink-faint">
            A real signature over a <span className="font-medium text-ink-muted">lookalike</span> domain fails here — the
            binding is checked, not just the signature.
          </p>
        </div>

        <div className="flex items-start gap-2 rounded-[10px] bg-surface-sunken px-3 py-2.5 text-[12px] text-ink-muted">
          <Users className="mt-0.5 size-4 shrink-0 text-ink-faint" />
          <span>
            High-value payments can require a <span className="font-medium text-ink">K-of-N notary quorum</span> — at least
            K of N independently trusted notaries signing the same statement, so no single compromised notary can wave a
            payment through.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export default Attestation;
