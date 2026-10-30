/** Browser-independent preference rules; never part of a workflow document. */
export type ThemePreference = "light" | "dark" | "system";
export type Theme = Exclude<ThemePreference, "system">;
export const THEME_KEY = "workflow-canvas.theme";

export function parseTheme(value: unknown): ThemePreference {
  return value === "dark" || value === "system" ? value : "light";
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}
