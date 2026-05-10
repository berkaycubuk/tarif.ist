// Lazy-loaded IETT bus line rendering. The bus dataset is too large to keep
// resident in the map, so a) we ship a small JSON index for search and
// b) per-route GeoJSON files are fetched on demand the first time the user
// picks that route.

import L from "leaflet";
import type { FeatureCollection, Geometry } from "geojson";

export interface BusIndexEntry {
  code: string;
  longName: string;
  file: string;
}

interface BusFeatureProps {
  kind: "shape" | "stop";
  direction: string;
  name?: string;
  stopId?: string;
}

type BusRouteFC = FeatureCollection<Geometry, BusFeatureProps>;

export interface BusController {
  /** Searchable index — empty until `loadIndex` resolves. */
  getIndex(): BusIndexEntry[];
  /** Render the given bus route on the map (replaces any prior render). */
  show(entry: BusIndexEntry): Promise<void>;
  /** Remove any rendered bus route. */
  clear(): void;
}

const BUS_COLOR = "#ea580c"; // IETT-ish orange
const BUS_STOP_FILL = "#fb923c";

export async function setupBus(map: L.Map): Promise<BusController> {
  let index: BusIndexEntry[] = [];
  try {
    const res = await fetch("/data/bus/index.json");
    if (res.ok) index = (await res.json()) as BusIndexEntry[];
    else console.warn(`bus index not available (HTTP ${res.status})`);
  } catch (err) {
    console.warn("failed to load bus index", err);
  }

  let active: L.LayerGroup | null = null;
  const cache = new Map<string, BusRouteFC>();

  async function fetchRoute(file: string): Promise<BusRouteFC | null> {
    const cached = cache.get(file);
    if (cached) return cached;
    const res = await fetch(`/data/bus/routes/${encodeURIComponent(file)}`);
    if (!res.ok) {
      console.warn(`bus route fetch failed (${res.status}): ${file}`);
      return null;
    }
    const data = (await res.json()) as BusRouteFC;
    cache.set(file, data);
    return data;
  }

  function clear(): void {
    if (active) {
      map.removeLayer(active);
      active = null;
    }
  }

  async function show(entry: BusIndexEntry): Promise<void> {
    const data = await fetchRoute(entry.file);
    clear();
    if (!data) return;

    const group = L.layerGroup();
    const bounds = L.latLngBounds([]);
    // A stop can appear in both directions of a route — render only once,
    // matching the metro layer where each station is a single marker.
    const renderedStops = new Set<string>();

    for (const f of data.features) {
      const geom = f.geometry;
      const props = f.properties;
      if (!geom) continue;

      if (geom.type === "LineString" && props.kind === "shape") {
        const latlngs = geom.coordinates.map(
          ([lon, lat]) => [lat, lon] as [number, number]
        );
        const line = L.polyline(latlngs, {
          color: BUS_COLOR,
          weight: 5,
          opacity: 0.9,
          lineCap: "round",
          lineJoin: "round",
        });
        line.bindTooltip(
          `<strong>${escapeHtml(entry.code)}</strong> · ${escapeHtml(entry.longName)}`,
          { sticky: true, direction: "top", opacity: 0.95 }
        );
        line.addTo(group);
        latlngs.forEach((p) => bounds.extend(p));
      } else if (geom.type === "Point" && props.kind === "stop") {
        const dedupeKey =
          props.stopId ??
          `${(geom.coordinates as [number, number])[0]},${(geom.coordinates as [number, number])[1]}`;
        if (renderedStops.has(dedupeKey)) continue;
        renderedStops.add(dedupeKey);

        const [lon, lat] = geom.coordinates as [number, number];
        const marker = L.circleMarker([lat, lon], {
          radius: 5,
          color: "#ffffff",
          weight: 2,
          fillColor: BUS_STOP_FILL,
          fillOpacity: 1,
        });
        const stopName = (props.name ?? "").trim();
        if (stopName) {
          marker.bindTooltip(stopName, {
            permanent: true,
            direction: "right",
            offset: [8, 0],
            className: "station-label",
            opacity: 1,
          });
        }
        marker.addTo(group);
        bounds.extend([lat, lon]);
      }
    }

    group.addTo(map);
    active = group;

    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    }
  }

  return {
    getIndex: () => index,
    show,
    clear,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
