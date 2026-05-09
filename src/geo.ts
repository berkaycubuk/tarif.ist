// Geometry primitives shared by graph construction, routing, and rendering.
// Single source of truth for haversine, polyline projection, and slicing.
// Every other module imports distance/projection from here — never duplicates.

import type { LineString, MultiLineString } from "geojson";

const EARTH_R = 6371000;

export function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in meters. */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

// --- Polyline geometry ------------------------------------------------------

export interface LineGeometry {
  /** Flattened path as [lng, lat] pairs. */
  path: Array<[number, number]>;
  /** Cumulative distance (meters) at each path index. Length = path.length. */
  cum: Float64Array;
  totalLengthM: number;
}

/**
 * Flatten a LineString or MultiLineString into a single ordered [lng, lat][]
 * path. MultiLineString parts are chained greedily by endpoint proximity so
 * projections behave even when the source has arbitrarily-ordered parts.
 */
export function flattenLine(
  geom: LineString | MultiLineString
): Array<[number, number]> {
  if (geom.type === "LineString") {
    return geom.coordinates.map(
      (c) => [c[0], c[1]] as [number, number]
    );
  }
  const parts = geom.coordinates;
  if (!parts.length) return [];
  if (parts.length === 1) {
    return parts[0].map((c) => [c[0], c[1]] as [number, number]);
  }
  const used = new Set<number>([0]);
  const chain: Array<[number, number]> = parts[0].map(
    (c) => [c[0], c[1]] as [number, number]
  );
  while (used.size < parts.length) {
    const tail = chain[chain.length - 1];
    let bestIdx = -1;
    let bestDist = Infinity;
    let reverse = false;
    for (let i = 0; i < parts.length; i++) {
      if (used.has(i)) continue;
      const p = parts[i];
      const head = p[0];
      const last = p[p.length - 1];
      const dStart = haversineMeters(tail[1], tail[0], head[1], head[0]);
      const dEnd = haversineMeters(tail[1], tail[0], last[1], last[0]);
      if (dStart < bestDist) {
        bestDist = dStart;
        bestIdx = i;
        reverse = false;
      }
      if (dEnd < bestDist) {
        bestDist = dEnd;
        bestIdx = i;
        reverse = true;
      }
    }
    if (bestIdx < 0) break;
    used.add(bestIdx);
    const seq = parts[bestIdx];
    const ordered = reverse ? [...seq].reverse() : seq;
    const startIdx = bestDist < 1 ? 1 : 0; // skip duplicate join point
    for (let k = startIdx; k < ordered.length; k++) {
      const c = ordered[k];
      chain.push([c[0], c[1]]);
    }
  }
  return chain;
}

/** Build cumulative-distance metadata for a polyline. */
export function buildLineGeometry(
  geom: LineString | MultiLineString
): LineGeometry {
  const path = flattenLine(geom);
  const cum = new Float64Array(path.length);
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1];
    const [bx, by] = path[i];
    total += haversineMeters(ay, ax, by, bx);
    cum[i] = total;
  }
  return { path, cum, totalLengthM: total };
}

/**
 * Project a (lng,lat) point onto a polyline. Returns the cumulative distance
 * from the polyline's start to the closest point, plus the perpendicular
 * distance from the input point to the polyline.
 */
export function projectPointOntoLine(
  lng: number,
  lat: number,
  geom: LineGeometry
): { cumDist: number; minDist: number } {
  const { path, cum } = geom;
  let bestCum = 0;
  let bestDist = Infinity;

  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1];
    const [bx, by] = path[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = 0;
    if (len2 > 1e-18) {
      t = ((lng - ax) * dx + (lat - ay) * dy) / len2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const dist = haversineMeters(lat, lng, cy, cx);
    if (dist < bestDist) {
      bestDist = dist;
      const segLen = cum[i] - cum[i - 1];
      bestCum = cum[i - 1] + t * segLen;
    }
  }
  return { cumDist: bestCum, minDist: bestDist };
}

/**
 * Slice a polyline between two cumulative-distance positions (in meters).
 * Returns the inclusive sub-path as [lng, lat] pairs.
 */
export function sliceLine(
  geom: LineGeometry,
  startCum: number,
  endCum: number
): Array<[number, number]> {
  if (startCum > endCum) {
    return sliceLine(geom, endCum, startCum).reverse();
  }
  const { path, cum } = geom;
  const out: Array<[number, number]> = [];
  let started = false;
  for (let i = 1; i < path.length; i++) {
    const segStart = cum[i - 1];
    const segEnd = cum[i];
    const segLen = segEnd - segStart || 1e-9;
    if (segEnd < startCum) continue;

    if (!started) {
      const t = Math.max(0, (startCum - segStart) / segLen);
      const [ax, ay] = path[i - 1];
      const [bx, by] = path[i];
      out.push([ax + t * (bx - ax), ay + t * (by - ay)]);
      started = true;
    }

    if (segEnd >= endCum) {
      const t = Math.max(0, Math.min(1, (endCum - segStart) / segLen));
      const [ax, ay] = path[i - 1];
      const [bx, by] = path[i];
      out.push([ax + t * (bx - ax), ay + t * (by - ay)]);
      return out;
    }

    out.push(path[i]);
  }
  return out;
}
