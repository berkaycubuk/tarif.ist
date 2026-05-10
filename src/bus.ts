// Lazy-loaded IETT bus line rendering. The bus dataset is too large to keep
// resident in the map, so a) we ship a small JSON index for search and
// b) per-route GeoJSON files are fetched on demand the first time the user
// picks that route.

import L from "leaflet";
import type { FeatureCollection, Geometry } from "geojson";
import busIconUrl from "./assets/bus.svg";

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

export interface BusRouteHandle {
  /** Stop IDs served by the route, in the order they appear in the GeoJSON. */
  stopIds: Set<string>;
}

export interface BusController {
  /** Searchable index — empty until `loadIndex` resolves. */
  getIndex(): BusIndexEntry[];
  /**
   * Render the given bus route on the map (replaces any prior render).
   * Returns the route's stop IDs so callers can highlight them on the
   * global stops layer; resolves to null if the route file is missing.
   */
  show(entry: BusIndexEntry): Promise<BusRouteHandle | null>;
  /** Remove any rendered bus route. */
  clear(): void;
}

const BUS_COLOR = "#ea580c"; // IETT-ish orange

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

  async function show(entry: BusIndexEntry): Promise<BusRouteHandle | null> {
    const data = await fetchRoute(entry.file);
    clear();
    if (!data) return null;

    const group = L.layerGroup();
    const bounds = L.latLngBounds([]);
    const stopIds = new Set<string>();

    // The global bus stop layer renders the actual stop markers; this view
    // adds only the route shape and reports the route's stop set so the
    // caller can filter the global layer down to those stops.
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
      } else if (geom.type === "Point" && props.kind === "stop" && props.stopId) {
        stopIds.add(props.stopId);
        const [lon, lat] = geom.coordinates as [number, number];
        bounds.extend([lat, lon]);
      }
    }

    group.addTo(map);
    active = group;

    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    }

    return { stopIds };
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

// Always-visible layer of every IETT bus stop. There are ~13.5k stops, so we
// can't mount them all as DivIcons up front — that's 13k DOM nodes. Instead
// we keep the feature list in memory and only mount markers within the
// current map viewport, refreshing on pan/zoom. Below MIN_BUS_STOP_ZOOM the
// layer is empty.
const MIN_BUS_STOP_ZOOM = 14;

interface BusStopFeatureProps {
  stopId: string;
  name: string;
  lines: string[];
}

interface BusStopRecord {
  id: string;
  lat: number;
  lon: number;
  name: string;
  lines: string[];
}

export interface BusStopsLayer {
  /** Show only stops in this set; pass null to show every stop. */
  setStopFilter(stopIds: ReadonlySet<string> | null): void;
  /** Hide the entire layer regardless of filter (rail line selection). */
  setHidden(hidden: boolean): void;
  destroy(): void;
}

export async function setupBusStopsLayer(
  map: L.Map
): Promise<BusStopsLayer | null> {
  let data: FeatureCollection<Geometry, BusStopFeatureProps> | null = null;
  try {
    const res = await fetch("/data/bus/stops.geojson");
    if (!res.ok) {
      console.warn(`bus stops layer not available (HTTP ${res.status})`);
      return null;
    }
    data = (await res.json()) as FeatureCollection<
      Geometry,
      BusStopFeatureProps
    >;
  } catch (err) {
    console.warn("failed to load bus stops layer", err);
    return null;
  }

  const stops: BusStopRecord[] = [];
  for (const f of data.features) {
    if (f.geometry?.type !== "Point") continue;
    const [lon, lat] = f.geometry.coordinates as [number, number];
    stops.push({
      id: f.properties.stopId,
      lat,
      lon,
      name: f.properties.name ?? "",
      lines: f.properties.lines ?? [],
    });
  }

  const icon = busStopIcon();
  const group = L.layerGroup().addTo(map);
  const mounted = new Map<string, L.Marker>();
  let stopFilter: ReadonlySet<string> | null = null;
  let hidden = false;
  // When a route is selected we want every one of its stops on screen, even
  // far below MIN_BUS_STOP_ZOOM and outside the current viewport. Skipping
  // both gates lets selection trump the perf heuristics that exist for the
  // unfiltered case.
  function refresh(): void {
    if (hidden) {
      if (mounted.size) {
        group.clearLayers();
        mounted.clear();
      }
      return;
    }
    const filtered = stopFilter !== null;
    if (!filtered && map.getZoom() < MIN_BUS_STOP_ZOOM) {
      if (mounted.size) {
        group.clearLayers();
        mounted.clear();
      }
      return;
    }
    const bounds = filtered ? null : map.getBounds();
    const wanted = new Set<string>();
    for (const s of stops) {
      if (stopFilter && !stopFilter.has(s.id)) continue;
      if (bounds && !bounds.contains([s.lat, s.lon])) continue;
      wanted.add(s.id);
      if (mounted.has(s.id)) continue;
      const marker = L.marker([s.lat, s.lon], { icon, keyboard: false });
      if (s.name || s.lines.length) {
        marker.bindTooltip(
          `<strong>${escapeHtml(s.name)}</strong>${
            s.lines.length
              ? `<br><span style="color:#64748b">${escapeHtml(s.lines.join(" · "))}</span>`
              : ""
          }`,
          { direction: "top", offset: [0, -8], opacity: 0.95 }
        );
      }
      marker.addTo(group);
      mounted.set(s.id, marker);
    }
    for (const [id, marker] of mounted) {
      if (wanted.has(id)) continue;
      group.removeLayer(marker);
      mounted.delete(id);
    }
  }

  refresh();
  map.on("moveend", refresh);

  return {
    setStopFilter(set) {
      stopFilter = set;
      refresh();
    },
    setHidden(h) {
      hidden = h;
      refresh();
    },
    destroy() {
      map.off("moveend", refresh);
      group.clearLayers();
      mounted.clear();
      if (map.hasLayer(group)) map.removeLayer(group);
    },
  };
}

function busStopIcon(): L.DivIcon {
  // Tailwind preflight applies `img { max-width: 100%; height: auto }`, which
  // beats <img>'s width/height attributes (the source SVG is 800×800). The
  // `!important` on the inline style locks the size we actually want.
  const html = `<span style="
    display:flex;align-items:center;justify-content:center;
    width:18px;height:18px;border-radius:50%;
    background:#fff;
    box-shadow:0 1px 2px rgba(15,23,42,0.35);
  "><img src="${busIconUrl}" alt="" style="width:14px !important;height:14px !important;display:block;max-width:none;"/></span>`;
  return L.divIcon({
    className: "bus-stop-icon",
    html,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}
