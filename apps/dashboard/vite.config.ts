import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Base "./" so the built shell can be served from any sub-path (demo hosting).
export default defineConfig({
  base: "./",
  plugins: [react()],
});
