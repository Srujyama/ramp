import type { JSX } from "react";
import { Route, Routes } from "react-router-dom";
import AppLayout from "./app/AppLayout.js";
import Dashboard from "./app/pages/Dashboard.js";
import AgentDetail from "./app/pages/AgentDetail.js";
import Activity from "./app/pages/Activity.js";
import Live from "./app/pages/Live.js";
import Approvals from "./app/pages/Approvals.js";
import DecisionDetail from "./app/pages/DecisionDetail.js";
import Vendors from "./app/pages/Vendors.js";
import Policy from "./app/pages/Policy.js";
import Security from "./app/pages/Security.js";
import Simulate from "./app/pages/Simulate.js";
import Admin from "./app/pages/Admin.js";
import Landing from "./marketing/Landing.js";

/**
 * @ramp/dashboard — App
 *
 * Two shells: `/` is the marketing landing page (the funnel), `/app/*` is the
 * product — a business-facing spend console reading the same read-only ledger
 * bridge the old audit console did. Enforcement lives in the policy gate, not
 * this UI; this dashboard only shows what was already decided and recorded.
 */
export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/app" element={<AppLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="agents/:agentId" element={<AgentDetail />} />
        <Route path="live" element={<Live />} />
        <Route path="approvals" element={<Approvals />} />
        <Route path="activity" element={<Activity />} />
        <Route path="activity/:id" element={<DecisionDetail />} />
        <Route path="vendors" element={<Vendors />} />
        <Route path="policy" element={<Policy />} />
        <Route path="security" element={<Security />} />
        <Route path="simulate" element={<Simulate />} />
        <Route path="admin" element={<Admin />} />
      </Route>
    </Routes>
  );
}

export default App;
