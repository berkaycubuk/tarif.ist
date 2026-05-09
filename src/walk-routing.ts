// Pedestrian routing for the walk legs of a transit itinerary.
// Uses OpenStreetMap's public OSRM foot profile, which has CORS enabled.
// Usage policy: don't bulk-query — we cache aggressively and skip routing
// for very short distances.

import { haversineMeters } from "./geo";

export interface FootRoute {
  /** Walking polyline as [lng, lat] pairs (OSRM/GeoJSON convention). */
  coords: Array<[number, number]>;
  distM: number;
  durationSec: number;
}

const ENDPOINT = "https://routing.openstreetmap.de/routed-foot/route/v1/foot";
const MIN_ROUTE_M = 25; // below this, just use a straight line
const cache = new Map<string, FootRoute | null>();

interface Point {
  lat: number;
  lng: number;
}

function cacheKey(a: Point, b: Point): string {
  return `${a.lat.toFixed(5)},${a.lng.toFixed(5)}>${b.lat.toFixed(5)},${b.lng.toFixed(5)}`;
}

export async function getFootRoute(
  start: Point,
  end: Point,
  signal?: AbortSignal
): Promise<FootRoute | null> {
  const straight = haversineMeters(start.lat, start.lng, end.lat, end.lng);
  if (straight < MIN_ROUTE_M) return null;

  const key = cacheKey(start, end);
  if (cache.has(key)) return cache.get(key) ?? null;

  const url =
    `${ENDPOINT}/${start.lng},${start.lat};${end.lng},${end.lat}` +
    `?overview=full&geometries=geojson&steps=false&alternatives=false`;

  try {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`OSRM ${res.status}`);
    const data = (await res.json()) as {
      code: string;
      routes?: Array<{
        geometry: { coordinates: Array<[number, number]> };
        distance: number;
        duration: number;
      }>;
    };
    const route = data.routes?.[0];
    if (!route || data.code !== "Ok") {
      cache.set(key, null);
      return null;
    }
    const result: FootRoute = {
      coords: route.geometry.coordinates,
      distM: route.distance,
      durationSec: route.duration,
    };
    cache.set(key, result);
    return result;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    console.warn("foot routing failed, falling back to straight line", err);
    cache.set(key, null);
    return null;
  }
}
