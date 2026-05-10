// Geocoding: Photon (komoot) is preferred for fuzzy/prefix autocomplete,
// with OpenStreetMap Nominatim as fallback when Photon errors out.
// Nominatim usage policy: https://operations.osmfoundation.org/policies/nominatim/
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

const PHOTON_URL = "https://photon.komoot.io/api/";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";

// viewbox order (Nominatim): left,top,right,bottom (lng_min, lat_max, lng_max, lat_min)
const ISTANBUL_VIEWBOX = "28.45,41.32,29.62,40.78";
// bbox order (Photon): minLon,minLat,maxLon,maxLat
const ISTANBUL_BBOX = "28.45,40.78,29.62,41.32";
// Rough Istanbul centroid for Photon proximity bias.
const ISTANBUL_CENTER_LAT = 41.05;
const ISTANBUL_CENTER_LNG = 28.95;

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

  try {
    const results = await searchPlacesPhoton(q, signal);
    cache.set(q, results);
    return results;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    console.warn("photon search failed, falling back to nominatim", err);
  }

  const results = await searchPlacesNominatim(q, signal);
  cache.set(q, results);
  return results;
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    osm_id?: number;
    osm_type?: string;
    osm_key?: string;
    osm_value?: string;
    name?: string;
    street?: string;
    housenumber?: string;
    district?: string;
    city?: string;
    county?: string;
    state?: string;
    country?: string;
    postcode?: string;
    type?: string;
  };
}

async function searchPlacesPhoton(
  q: string,
  signal?: AbortSignal
): Promise<Place[]> {
  const url = new URL(PHOTON_URL);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "8");
  // `default` keeps results in their original language (Turkish for IST);
  // Photon doesn't support `tr` as a translation target.
  url.searchParams.set("lang", "default");
  url.searchParams.set("lat", String(ISTANBUL_CENTER_LAT));
  url.searchParams.set("lon", String(ISTANBUL_CENTER_LNG));
  url.searchParams.set("bbox", ISTANBUL_BBOX);

  const res = await fetch(url.toString(), { signal });
  if (!res.ok) throw new Error(`photon HTTP ${res.status}`);
  const data = (await res.json()) as { features?: PhotonFeature[] };

  const features = data.features ?? [];
  return features
    .map((f): Place | null => {
      const coords = f.geometry?.coordinates;
      if (!coords || coords.length < 2) return null;
      const [lng, lat] = coords;
      const p = f.properties ?? {};
      const streetLine = [p.street, p.housenumber].filter(Boolean).join(" ");
      const name = p.name || streetLine || p.city || "";
      if (!name) return null;
      const fullName = [
        p.name,
        [p.street, p.housenumber].filter(Boolean).join(" ") || null,
        p.district,
        p.city ?? p.county,
        p.state,
        p.country,
      ]
        .filter((s): s is string => Boolean(s))
        .join(", ");
      const id = p.osm_type && p.osm_id ? `photon-${p.osm_type}${p.osm_id}` : `photon-${lat},${lng}`;
      return {
        id,
        name,
        fullName: fullName || name,
        lat,
        lng,
        type: p.osm_value ?? p.type,
      };
    })
    .filter((p): p is Place => p !== null);
}

async function searchPlacesNominatim(
  q: string,
  signal?: AbortSignal
): Promise<Place[]> {
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

  return data.map((d) => ({
    id: String(d.place_id),
    name: shortenName(d.display_name),
    fullName: d.display_name,
    lat: Number.parseFloat(d.lat),
    lng: Number.parseFloat(d.lon),
    type: d.type,
  }));
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
