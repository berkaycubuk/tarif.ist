// Feature flags. Flip a value here to enable/disable a feature site-wide.

export const FEATURES = {
  /** Route planning panel + shared-route viewer. */
  routePlanning: false,
  /** Live train markers on the currently-selected rail line, polled from the
   *  livepos backend. The backend URL comes from VITE_LIVE_TRAINS_URL. */
  liveTrainPositions: true,
  /** Bus network: search-bar entries, bus stop markers, bus route shapes,
   *  and bus edges in the routing graph. Off by default while we sharpen the
   *  metro experience — flip this on to bring the bus layer back. */
  bus: false,
} as const;

/** Base URL of the livepos backend service. In production we default to the
 *  public deploy at backend.tarif.ist; in dev we point at the local Go server.
 *  Override either via the VITE_LIVE_TRAINS_URL env var (e.g. in .env.local
 *  or the Cloudflare Pages env). */
export const LIVE_TRAINS_URL =
  (import.meta.env.VITE_LIVE_TRAINS_URL as string | undefined) ??
  (import.meta.env.PROD ? "https://backend.tarif.ist" : "http://localhost:8080");
