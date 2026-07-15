import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Serve the provenance bundles the gate sealed at enforce time.
 *
 * Read-only, dev/preview only, and it does nothing but hand over JSON files the
 * gate already wrote. It is deliberately NOT an evaluation endpoint: the gate is
 * the PreToolUse hook, and a dashboard that could decide anything would be a
 * second enforcement path — exactly the "advisory vs enforced" hole the pitch
 * argues against. The dashboard's whole job is to VERIFY, and verification needs
 * nothing but the bundle.
 *
 * The bundles carry no untrusted content by construction (quarantined values
 * appear as digests and codomains, never bytes), which is what makes it safe to
 * ship them to a browser at all.
 */
function bundlesApi(): Plugin {
  const bundleDir =
    process.env.RAMP_BUNDLE_DIR ?? resolve(__dirname, "..", "..", ".ramp", "bundles");

  const load = () => {
    if (!existsSync(bundleDir)) return [];
    return readdirSync(bundleDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(bundleDir, f), "utf8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  };

  return {
    name: "ramp-bundles-api",
    configureServer(server) {
      server.middlewares.use("/api/bundles", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ bundleDir, bundles: load() }));
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use("/api/bundles", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ bundleDir, bundles: load() }));
      });
    },
  };
}

// Base "./" so the built shell can be served from any sub-path (demo hosting).
export default defineConfig({
  base: "./",
  plugins: [react(), bundlesApi()],
});
