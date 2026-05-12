// Thin wrapper around the Umami `track()` global so call sites stay typed,
// concise, and safe when the analytics script hasn't loaded (ad-blocker,
// offline, local dev). All events live in `EventProps` — adding one here is
// the only place to touch when introducing a new analytics signal.

declare global {
  interface Window {
    umami?: {
      track: (event: string, data?: Record<string, unknown>) => void;
    };
  }
}

type EventProps = {
  /** User submitted the plan form with both endpoints set. */
  plan_requested: {
    from_kind: string;
    to_kind: string;
  };
  /** Router returned at least one itinerary and it rendered on the map. */
  plan_succeeded: {
    /** End-to-end wall-clock from submit to render, including foot routing. */
    duration_ms: number;
    /** Number of legs in the chosen itinerary. */
    legs: number;
    /** Sorted+dedup'd leg kinds, e.g. "bus+rail+walk" — facet-friendly. */
    modes: string;
    /** Router's total journey duration in seconds. */
    total_sec: number;
  };
  /** Router returned no route, or threw. */
  plan_failed: {
    reason: "no_path" | "error";
    duration_ms: number;
  };
};

export function track<K extends keyof EventProps>(
  name: K,
  props: EventProps[K]
): void {
  const umami = window.umami;
  if (!umami) return;
  try {
    umami.track(name, props as Record<string, unknown>);
  } catch {
    // Analytics must never break the app.
  }
}

/** Coarse bucket for a geocoded Place so endpoint kinds stay facet-friendly. */
export function placeKind(type: string | undefined): string {
  if (!type) return "unknown";
  const t = type.toLowerCase();
  if (
    t.includes("station") ||
    t.includes("halt") ||
    t.includes("stop") ||
    t === "platform"
  ) {
    return "station";
  }
  if (t === "house" || t === "address" || t === "building") return "address";
  return t;
}
