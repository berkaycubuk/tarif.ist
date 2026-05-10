// Three-state theme: "system" tracks prefers-color-scheme; "light" / "dark"
// pin the user's choice. Stored in localStorage and applied as a class on
// <html> so Tailwind's `dark:` variant (configured in style.css) flips
// surfaces in one shot. Subscribers get notified whenever the *resolved*
// theme changes (selection or OS-level switch when in system mode).

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "tarif-ist:theme";

function readPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "system" || v === "light" || v === "dark") return v;
  } catch {
    // ignore
  }
  return "system";
}

const mq = window.matchMedia("(prefers-color-scheme: dark)");
let preference: ThemePreference = readPreference();
const subscribers = new Set<(t: ResolvedTheme) => void>();

function resolve(): ResolvedTheme {
  if (preference === "system") return mq.matches ? "dark" : "light";
  return preference;
}

function apply(): void {
  const root = document.documentElement;
  const t = resolve();
  if (t === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
  for (const fn of subscribers) fn(t);
}

mq.addEventListener("change", () => {
  if (preference === "system") apply();
});

export function getThemePreference(): ThemePreference {
  return preference;
}

export function getResolvedTheme(): ResolvedTheme {
  return resolve();
}

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // ignore
  }
  apply();
}

export function subscribeTheme(fn: (t: ResolvedTheme) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// Apply once at import time so the page never flashes the wrong theme.
apply();
