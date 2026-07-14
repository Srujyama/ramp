import type { JSX } from "react";
import { NavLink } from "react-router-dom";

/**
 * @ramp/dashboard — Sidebar
 *
 * App navigation. Pure presentation + routing; no data. Three sections mirror
 * the demo story: Overview (what the product does) → Decisions (the live audit
 * trail, drill into any row for its proof + provenance + payment) → Policy (the
 * caps + clearances the kernel enforces). The old standalone "Audit" route is
 * folded into the decision detail — the same trace, one place.
 */
interface NavItem {
  to: string;
  label: string;
  icon: string;
}

const NAV: readonly NavItem[] = [
  { to: "/", label: "Overview", icon: "◎" },
  { to: "/decisions", label: "Decisions", icon: "⚖" },
  { to: "/policy", label: "Policy", icon: "▤" },
];

export function Sidebar(): JSX.Element {
  return (
    <nav className="sidebar" aria-label="Primary">
      <div className="brand">
        <div className="mark">R</div>
        <div>
          <div className="name">Provable Spend</div>
          <div className="sub">agent payment trust layer</div>
        </div>
      </div>

      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === "/"}
          className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
        >
          <span className="ico" aria-hidden="true">
            {item.icon}
          </span>
          {item.label}
        </NavLink>
      ))}

      <div className="foot">
        Read-only audit console. Enforcement lives in the policy gate + PreToolUse
        hook, not this UI.
      </div>
    </nav>
  );
}

export default Sidebar;
