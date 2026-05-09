// Geocoding via OpenStreetMap Nominatim, bounded to Istanbul.
// Usage policy: https://operations.osmfoundation.org/policies/nominatim/
// — limit to ~1 req/sec (we debounce in autocomplete.ts), cache results,
// don't hammer with bulk requests.

import { haversineMeters } from "./geo";

export interface Place {
  id: string;
  name: string;
  fullName: string;
  lat: number;
  lng: number;
  type?: string;
}

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";

// viewbox order is: left,top,right,bottom (lng_min, lat_max, lng_max, lat_min)
const ISTANBUL_VIEWBOX = "28.45,41.32,29.62,40.78";

const cache = new Map<string, Place[]>();
const reverseCache = new Map<string, Place | null>();

export async function searchPlaces(
  query: string,
  signal?: AbortSignal
): Promise<Place[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const cached = cache.get(q);
  if (cached) return cached;

  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", q);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "8");
  url.searchParams.set("viewbox", ISTANBUL_VIEWBOX);
  url.searchParams.set("bounded", "1");
  url.searchParams.set("countrycodes", "tr");
  url.searchParams.set("addressdetails", "0");

  const res = await fetch(url.toString(), {
    signal,
    headers: { "Accept-Language": "tr,en;q=0.8" },
  });
  if (!res.ok) {
    throw new Error(`geocode HTTP ${res.status}`);
  }
  const data = (await res.json()) as Array<{
    place_id: number;
    display_name: string;
    lat: string;
    lon: string;
    type?: string;
  }>;

  const places: Place[] = data.map((d) => ({
    id: String(d.place_id),
    name: shortenName(d.display_name),
    fullName: d.display_name,
    lat: Number.parseFloat(d.lat),
    lng: Number.parseFloat(d.lon),
    type: d.type,
  }));

  cache.set(q, places);
  return places;
}

export async function reverseGeocode(
  lat: number,
  lng: number,
  signal?: AbortSignal
): Promise<Place | null> {
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (reverseCache.has(key)) return reverseCache.get(key) ?? null;

  const url = new URL(NOMINATIM_REVERSE_URL);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("format", "json");
  url.searchParams.set("zoom", "18");
  url.searchParams.set("addressdetails", "0");

  try {
    const res = await fetch(url.toString(), {
      signal,
      headers: { "Accept-Language": "tr,en;q=0.8" },
    });
    if (!res.ok) {
      reverseCache.set(key, null);
      return null;
    }
    const data = (await res.json()) as {
      place_id?: number;
      display_name?: string;
      lat?: string;
      lon?: string;
      error?: string;
    };
    if (!data || data.error || !data.display_name) {
      reverseCache.set(key, null);
      return null;
    }
    const place: Place = {
      id: data.place_id ? String(data.place_id) : `rev-${key}`,
      name: shortenName(data.display_name),
      fullName: data.display_name,
      lat: data.lat ? Number.parseFloat(data.lat) : lat,
      lng: data.lon ? Number.parseFloat(data.lon) : lng,
    };
    reverseCache.set(key, place);
    return place;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    console.warn("reverse geocode failed", err);
    reverseCache.set(key, null);
    return null;
  }
}

function shortenName(displayName: string): string {
  const parts = displayName.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 2) return parts.join(", ");
  return parts.slice(0, 2).join(", ");
}

/** Convenience: great-circle distance in km between two lat/lng points. */
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  return haversineMeters(a.lat, a.lng, b.lat, b.lng) / 1000;
}
