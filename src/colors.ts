// Line colours, shared by the map layers and the prerendered pages.
// Kept free of Leaflet imports so Node-side scripts (scripts/prerender.ts) can
// use the same palette instead of forking a second copy that drifts.

const LINE_COLORS: Record<string, string> = {
  M1A: "#dc2626",
  M1B: "#dc2626",
  M2: "#16a34a",
  M3: "#0ea5e9",
  M4: "#ec4899",
  M5: "#7c3aed",
  M6: "#a16207",
  M7: "#db2777",
  M8: "#0d9488",
  M9: "#eab308",
  M11: "#3730a3",
  T1: "#1d4ed8",
  T2: "#b91c1c",
  T3: "#6d28d9",
  T4: "#7c3aed",
  T5: "#06b6d4",
  F1: "#78716c",
  F2: "#78716c",
  F4: "#059669",
  MARMARAY: "#0f766e",
};

const FALLBACK_COLOR = "#64748b";

export function colorForLine(code: string | null | undefined): string {
  if (!code) return FALLBACK_COLOR;
  return LINE_COLORS[code.toUpperCase()] ?? FALLBACK_COLOR;
}
