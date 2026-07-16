/**
 * @ramp/dashboard — theme control
 *
 * Light is the unconditional default — it does NOT follow OS preference, so a
 * dark-OS visitor still sees light on first load. Dark is opt-in only, via the
 * explicit toggle, and persists once chosen. ALWAYS writes an explicit
 * `data-theme` so the two states can never be ambiguous. The returned `dark`
 * boolean is the single source of truth for label + aria-pressed, so they can
 * never contradict the rendered theme.
 */
import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "ramp-theme";

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* localStorage may be unavailable; fall through to the default */
  }
  return "light";
}

export function useTheme(): { theme: Theme; dark: boolean; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* ignore persistence failures */
    }
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return { theme, dark: theme === "dark", toggle };
}
