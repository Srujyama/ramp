/**
 * @ramp/dashboard — identity labels
 *
 * Agent/vendor DISPLAY NAMES are not on the bridge wire (`DecisionView` carries
 * only `agentId`/`vendorId`). Everything security-relevant (vendor_verified,
 * vendor_risk_tier, clearances, caps) stays sourced from `Facts` on real
 * decisions — see lib/agents.ts / lib/rollups.ts. This module is presentation
 * ONLY: a label lookup mirroring the demo seed (packages/ledger/sql/seed.sql),
 * with a humanized fallback so an id this map has never seen still reads as a
 * name instead of a raw slug.
 */

const AGENT_LABELS: Readonly<Record<string, string>> = {
  agent_47: "Procurement Agent 47",
  agent_12: "Ops Agent 12",
  agent_23: "Travel Agent 23",
  agent_08: "Eng Tools Agent 08",
};

const VENDOR_LABELS: Readonly<Record<string, string>> = {
  acme_corp: "Acme Corp",
  newco_ltd: "NewCo Ltd",
  sketchy_llc: "Sketchy LLC",
  unknown_labs: "Unknown Labs",
  globex_inc: "Globex Inc",
  initech: "Initech",
};

const VENDOR_DOMAINS: Readonly<Record<string, string>> = {
  acme_corp: "acme.example.com",
  newco_ltd: "newco.example.com",
  globex_inc: "globex.example.com",
  initech: "initech.example.com",
};

/** "agent_47" -> "Agent 47"; "sketchy_llc" -> "Sketchy Llc". A last resort. */
export function humanizeId(id: string): string {
  const words = id.split(/[_-]+/).filter(Boolean);
  if (words.length === 0) return id;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export function agentLabel(agentId: string): string {
  return AGENT_LABELS[agentId] ?? humanizeId(agentId);
}

export function vendorLabel(vendorId: string): string {
  return VENDOR_LABELS[vendorId] ?? humanizeId(vendorId);
}

/** The vendor's registered domain, when known. Never fabricated for an unknown vendor. */
export function vendorDomain(vendorId: string): string | null {
  return VENDOR_DOMAINS[vendorId] ?? null;
}

/**
 * A stylized "card number" tail for the Agent Card — purely decorative
 * (there is no real card number in this system), derived deterministically
 * from the agent id so the same agent always shows the same tail.
 */
export function maskedCardNumber(agentId: string): string {
  const digits = agentId.match(/\d+/g)?.join("") ?? "";
  const tail = (digits.length > 0 ? digits : agentId.replace(/[^a-zA-Z0-9]/g, "")).slice(-4);
  return `•••• •••• •••• ${tail.toUpperCase()}`;
}
