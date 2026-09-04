// Node-side data loading for the prerenderer.
//
// `loadTransitData()` in src/transit.ts can't be reused here: it fetches over
// HTTP, and its module pulls in Leaflet and SVG asset imports that don't
// resolve outside a bundler. The graph layer itself is clean — src/graph.ts,
// src/router.ts and src/geo.ts import no Leaflet and take plain GeoJSON — so
// reading the same files off disk is all that's needed.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BusSegmentData } from "../../src/graph";
import type { TransitData } from "../../src/transit";

export const DATA_DIR = resolve(import.meta.dirname, "../../public/data");

async function readJSON<T>(relPath: string): Promise<T> {
  return JSON.parse(await readFile(resolve(DATA_DIR, relPath), "utf8")) as T;
}

/** Per-line service frequency, keyed by line code (public/data/headways.json). */
export interface Headway {
  headwaySec: number;
  tripDurationSec: number;
  trainCount: number;
}

export interface PrerenderData {
  transit: TransitData;
  /** segments.json is already in BusSegmentData shape — {stops, routes}. */
  bus: BusSegmentData | null;
  headways: Record<string, Headway>;
}

export async function loadPrerenderData(): Promise<PrerenderData> {
  const [lines, stations, headways] = await Promise.all([
    readJSON<TransitData["lines"]>("lines.geojson"),
    readJSON<TransitData["stations"]>("stations.geojson"),
    readJSON<Record<string, Headway>>("headways.json"),
  ]);

  // Bus data is degradable exactly as it is in the SPA: rail pages still
  // render fully without it, so a missing file warns rather than throws.
  let bus: BusSegmentData | null = null;
  try {
    bus = await readJSON<BusSegmentData>("bus/segments.json");
  } catch (err) {
    console.warn(`prerender: bus segments unavailable, rail only (${String(err)})`);
  }

  return { transit: { lines, stations }, bus, headways };
}

/** shortName/name for a line code, matching what the SPA's search bar shows. */
export function lineDisplayName(transit: TransitData, code: string): string {
  for (const f of transit.lines.features) {
    if (f.properties.lineCode === code) {
      return f.properties.shortName || f.properties.name || code;
    }
  }
  return code;
}

/** "Metro", "Tramvay", "Banliyö"… as tagged on the line's stations. */
export function lineKind(transit: TransitData, code: string): string | null {
  for (const f of transit.lines.features) {
    if (f.properties.lineCode === code) return f.properties.kind;
  }
  return null;
}

export function lineLengthKm(transit: TransitData, code: string): number | null {
  for (const f of transit.lines.features) {
    if (f.properties.lineCode === code) return f.properties.lengthKm;
  }
  return null;
}
