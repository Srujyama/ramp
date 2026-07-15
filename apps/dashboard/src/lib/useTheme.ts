/**
 * @ramp/dashboard — theme control
 *
 * Fixes the Phase-0 toggle: initializes from a saved choice OR the OS
 * preference, ALWAYS writes an explicit `data-theme` (so it can force light on a
 * dark-OS machine and vice-versa), and persists the choice. The returned `dark`
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
    /* localStorage may be unavailable; fall through to OS preference */
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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
