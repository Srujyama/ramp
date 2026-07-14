import type { JSX } from "react";
import { NavLink } from "react-router-dom";

/**
 * @ramp/dashboard — Sidebar
 *
 * App navigation. Pure presentation + routing; no data. The four sections
 * mirror the demo story: Overview → Cards & Limits → Decisions (provenance)
 * → Audit ("prove this to an auditor").
 */
interface NavItem {
  to: string;
  label: string;
  icon: string;
}

const NAV: readonly NavItem[] = [
  { to: "/", label: "Overview", icon: "◎" },
  { to: "/cards", label: "Cards & Limits", icon: "▤" },
  { to: "/decisions", label: "Decisions", icon: "⚖" },
  { to: "/audit", label: "Audit", icon: "❖" },
];

export function Sidebar(): JSX.Element {
  return (
    <nav className="sidebar" aria-label="Primary">
      <div className="brand">
        <div className="mark">R</div>
        <div>
          <div className="name">Provable Spend</div>
          <div className="sub">deterministic policy gate</div>
        </div>
      </div>

      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === "/"}
          className={({ isActive }) =>
            isActive ? "nav-link active" : "nav-link"
          }
        >
          <span className="ico" aria-hidden="true">
            {item.icon}
          </span>
          {item.label}
        </NavLink>
      ))}

      <div className="foot">
        Phase 0 shell · enforcement lives in the PreToolUse hook, not this UI.
      </div>
    </nav>
  );
}

export default Sidebar;
