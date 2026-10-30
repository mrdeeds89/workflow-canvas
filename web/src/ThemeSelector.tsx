import { useLayoutEffect, useState } from "react";
import { parseTheme, resolveTheme, THEME_KEY } from "./theme.ts";

// Read before React's first render, so the first rendered UI has the right theme.
// Storage can be blocked (privacy settings/sandbox); preference remains usable in memory.
function readPreference() {
  try { return parseTheme(localStorage.getItem(THEME_KEY)); } catch { return "light" as const; }
}
const initialPreference = readPreference();
const media = window.matchMedia("(prefers-color-scheme: dark)");
document.documentElement.dataset.theme = resolveTheme(initialPreference, media.matches);

export function ThemeSelector() {
  const [preference, setPreference] = useState(initialPreference);
  useLayoutEffect(() => {
    const apply = () => { document.documentElement.dataset.theme = resolveTheme(preference, media.matches); };
    apply();
    if (preference !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preference]);
  return (
    <div className="appearance-bar">
      <label className="theme-selector">Theme
        <select value={preference} onChange={event => {
          const next = parseTheme(event.target.value);
          setPreference(next);
          try { localStorage.setItem(THEME_KEY, next); } catch { /* In-memory choice still works. */ }
        }}>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="system">Follow system</option>
        </select>
      </label>
    </div>
  );
}
