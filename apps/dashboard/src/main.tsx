import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App from "./App.js";
import "./theme.css";

/**
 * @ramp/dashboard — entrypoint.
 *
 * Mounts the React shell inside a data router. The dashboard is a SHELL in
 * Phase 0: real routing + design tokens, honest "no data yet" panels. No
 * security-critical logic lives here — enforcement is the policy gate, not the UI.
 */
const router = createBrowserRouter([{ path: "/*", element: <App /> }]);

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("#root element missing from index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
