// Feature flags. Flip a value here to enable/disable a feature site-wide.

export const FEATURES = {
  /** Route planning panel + shared-route viewer. */
  routePlanning: false,
  /** Live train markers on the currently-selected rail line, polled from the
   *  livepos backend. The backend URL comes from VITE_LIVE_TRAINS_URL. */
  liveTrainPositions: true,
} as const;

/** Base URL of the livepos backend service. Override at build/dev time via
 *  the VITE_LIVE_TRAINS_URL env var (e.g. in .env.local). */
export const LIVE_TRAINS_URL =
  (import.meta.env.VITE_LIVE_TRAINS_URL as string | undefined) ??
  "http://localhost:8080";
