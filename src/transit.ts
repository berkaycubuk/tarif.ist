import L from "leaflet";
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiLineString,
  Point,
} from "geojson";
import trainIconUrl from "./assets/train.svg";
import tramIconUrl from "./assets/tram.svg";
import { LIVE_TRAINS_URL } from "./flags";
import type { TransitGraph } from "./graph";

export interface StationProps {
  name: string;
  lineName: string;
  lineCode: string | null;
  kind: string | null;
}

export interface LineProps {
  name: string;
  shortName: string;
  lineCode: string | null;
  kind: string | null;
  lengthKm: number | null;
  stationCount: number | null;
}

export type StationFeature = Feature<Point, StationProps>;
export type LineFeature = Feature<LineString | MultiLineString, LineProps>;

export interface TransitData {
  stations: FeatureCollection<Point, StationProps>;
  lines: FeatureCollection<LineString | MultiLineString, LineProps>;
}

export async function loadTransitData(): Promise<TransitData> {
  const [linesData, stationsData] = await Promise.all([
    fetch("/data/lines.geojson").then((r) => r.json()),
    fetch("/data/stations.geojson").then((r) => r.json()),
  ]);
  return {
    lines: linesData as TransitData["lines"],
    stations: stationsData as TransitData["stations"],
  };
}

const LINE_COLORS: Record<string, string> = {
  M1A: "#dc2626",
  M1B: "#dc2626",
  M2: "#16a34a",
  M3: "#0ea5e9",
  M4: "#ec4899",
  M5: "#7c3aed",
  M6: "#a16207",
  M7: "#db2777",
  M8: "#0d9488",
  M9: "#eab308",
  M11: "#3730a3",
  T1: "#1d4ed8",
  T2: "#b91c1c",
  T3: "#6d28d9",
  T4: "#7c3aed",
  T5: "#06b6d4",
  F1: "#78716c",
  F2: "#78716c",
  F4: "#059669",
  MARMARAY: "#0f766e",
};

const FALLBACK_COLOR = "#64748b";

export function colorForLine(code: string | null | undefined): string {
  if (!code) return FALLBACK_COLOR;
  return LINE_COLORS[code.toUpperCase()] ?? FALLBACK_COLOR;
}

export interface RailStationsLayer {
  /** Show only stations on this line code; pass null to show every station. */
  setLineFilter(code: string | null): void;
  /**
   * Show only stations whose `${lineCode}|${name}` key is in this set. Takes
   * precedence over the line filter — used when an itinerary leg wants to
   * highlight just the stations it actually visits.
   */
  setStationKeyFilter(keys: Set<string> | null): void;
  /** Hide the entire layer regardless of filter (used when a bus line is selected). */
  setHidden(hidden: boolean): void;
  destroy(): void;
}

function railStationKey(lineCode: string | null, name: string): string {
  return `${lineCode ?? ""}|${name}`;
}

export { railStationKey };

/**
 * Map of `lineCode` → ordered `[lng, lat]` polyline. Built from the backend's
 * /v1/lines/geometry response when available; otherwise constructed locally as
 * straight segments between ordered stations.
 */
export type LineGeometryByCode = Map<string, Array<[number, number]>>;

/**
 * Fetch the precomputed per-line polylines from the livepos backend. Returns
 * null if the backend is unreachable or the response is malformed — callers
 * should treat that as "fall back to local geometry" instead of failing.
 */
export async function fetchLineGeometry(
  signal?: AbortSignal
): Promise<LineGeometryByCode | null> {
  try {
    const res = await fetch(`${LIVE_TRAINS_URL}/v1/lines/geometry`, { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as Array<{
      code: string;
      coordinates: Array<[number, number]>;
    }>;
    const out: LineGeometryByCode = new Map();
    for (const entry of body) {
      if (!entry?.code || !Array.isArray(entry.coordinates)) continue;
      if (entry.coordinates.length < 2) continue;
      out.set(entry.code, entry.coordinates);
    }
    return out.size > 0 ? out : null;
  } catch {
    return null;
  }
}

export function addTransitLayers(
  map: L.Map,
  data: TransitData,
  graph: TransitGraph,
  /** Backend-rendered polylines per line code. When null, we fall back to
   *  straight segments between ordered stations. */
  lineGeometry: LineGeometryByCode | null
): { lines: L.GeoJSON; stations: RailStationsLayer } {
  // lines.geojson stores both physical tracks (and detours into spurs/depots)
  // for many routes, so rendering it raw produces noisy parallel polylines and
  // criss-crossing artefacts (the Seyrantepe spur on M2, the M8 twin track,
  // etc.). The backend pre-collapses each line into one clean polyline; if
  // that fetch failed we fall back to straight hops between ordered stations.
  const collapsedLines = collapseLinesForRender(data, graph, lineGeometry);
  const lines = L.geoJSON(collapsedLines, {
    style: (feature) => {
      const props = feature?.properties as LineProps | undefined;
      const color = colorForLine(props?.lineCode);
      return {
        color,
        weight: 4,
        opacity: 0.85,
        lineCap: "round",
        lineJoin: "round",
      };
    },
    onEachFeature: (feature, layer) => {
      const p = feature.properties as LineProps;
      const code = p.lineCode ?? "—";
      layer.bindTooltip(`<strong>${escapeHtml(code)}</strong> · ${escapeHtml(p.shortName || p.name)}`, {
        sticky: true,
        direction: "top",
        opacity: 0.95,
      });
    },
  });
  lines.addTo(map);

  // Build station markers manually so we can add/remove them by line code
  // when the user selects a specific line.
  const trainIcon = trainStationIcon(trainIconUrl);
  const tramIcon = trainStationIcon(tramIconUrl);
  const records: Array<{ marker: L.Marker; props: StationProps }> = [];
  for (const f of data.stations.features) {
    if (f.geometry?.type !== "Point") continue;
    const [lng, lat] = f.geometry.coordinates as [number, number];
    const props = f.properties;
    const code = props.lineCode ?? "—";
    const color = colorForLine(props.lineCode);
    const icon = isTramCode(props.lineCode) ? tramIcon : trainIcon;
    const marker = L.marker([lat, lng], { icon, keyboard: false });
    bindStationLabel(marker, props.name, false);
    marker.bindPopup(`
      <div style="min-width:160px">
        <div style="font-weight:600;font-size:13px;color:#0f172a;margin-bottom:4px">${escapeHtml(props.name)}</div>
        <div style="display:inline-flex;align-items:center;gap:6px;font-size:11px">
          <span style="display:inline-block;width:8px;height:8px;border-radius:999px;background:${color}"></span>
          <span style="font-weight:600;color:${color}">${escapeHtml(code)}</span>
          <span style="color:#64748b">${escapeHtml(props.kind ?? "")}</span>
        </div>
        <div style="font-size:11px;color:#64748b;margin-top:4px">${escapeHtml(props.lineName)}</div>
      </div>
    `);
    records.push({ marker, props });
  }

  const group = L.layerGroup();
  // Stations only render at street-level zoom — at city overview the dots
  // cluster into noise.
  const MIN_STATION_ZOOM = 12;
  let lineFilter: string | null = null;
  let stationKeyFilter: Set<string> | null = null;
  let hidden = false;
  // When a single rail line is the focus, every visible station shows its
  // name as an always-on label. Off in every other state (no selection,
  // route-leg highlight, hidden).
  let labelsOn = false;

  function recomputeLabels(): void {
    const next = lineFilter !== null;
    if (next === labelsOn) return;
    labelsOn = next;
    for (const { marker, props } of records) {
      bindStationLabel(marker, props.name, labelsOn);
    }
  }

  function wantsMarker(props: StationProps): boolean {
    if (stationKeyFilter)
      return stationKeyFilter.has(railStationKey(props.lineCode, props.name));
    return lineFilter === null || props.lineCode === lineFilter;
  }

  function sync(): void {
    // Per-leg highlights bypass the zoom gate: when the user picks a leg from
    // the itinerary we want every involved station on screen regardless of
    // zoom.
    const ignoreZoomGate = stationKeyFilter !== null;
    const wantGroup =
      !hidden && (ignoreZoomGate || map.getZoom() >= MIN_STATION_ZOOM);
    if (!wantGroup) {
      if (map.hasLayer(group)) map.removeLayer(group);
      return;
    }
    if (!map.hasLayer(group)) group.addTo(map);
    for (const { marker, props } of records) {
      const want = wantsMarker(props);
      if (want && !group.hasLayer(marker)) group.addLayer(marker);
      else if (!want && group.hasLayer(marker)) group.removeLayer(marker);
    }
  }
  sync();
  map.on("zoomend", sync);

  const stations: RailStationsLayer = {
    setLineFilter(code) {
      lineFilter = code;
      recomputeLabels();
      sync();
    },
    setStationKeyFilter(keys) {
      stationKeyFilter = keys;
      sync();
    },
    setHidden(h) {
      hidden = h;
      sync();
    },
    destroy() {
      map.off("zoomend", sync);
      group.clearLayers();
      if (map.hasLayer(group)) map.removeLayer(group);
    },
  };

  return { lines, stations };
}

export function uniqueLineCodes(linesLayer: L.GeoJSON): string[] {
  const codes = new Set<string>();
  linesLayer.eachLayer((layer) => {
    const f = (layer as unknown as { feature?: { properties?: LineProps } })
      .feature;
    const code = f?.properties?.lineCode;
    if (code) codes.add(code);
  });
  return [...codes].sort((a, b) => {
    const order = ["M", "T", "F", "B", "MARMARAY"];
    const ia = order.findIndex((p) => a.toUpperCase().startsWith(p));
    const ib = order.findIndex((p) => b.toUpperCase().startsWith(p));
    if (ia !== ib) return ia - ib;
    return a.localeCompare(b, "tr", { numeric: true });
  });
}

function trainStationIcon(iconUrl: string): L.DivIcon {
  // Tailwind preflight applies `img { max-width: 100%; height: auto }`, which
  // beats <img>'s width/height attributes (the source SVGs are 800×800). The
  // `!important` on the inline style locks the size we actually want.
  const html = `<span style="
    display:flex;align-items:center;justify-content:center;
    width:18px;height:18px;border-radius:50%;
    background:#fff;
    box-shadow:0 1px 2px rgba(15,23,42,0.35);
  "><img src="${iconUrl}" alt="" style="width:14px !important;height:14px !important;display:block;max-width:none;"/></span>`;
  return L.divIcon({
    className: "rail-station-icon",
    html,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

/**
 * Toggle an always-on station name label. Permanent tooltips have to be
 * re-bound to switch their `permanent` flag — Leaflet doesn't react to
 * mutating the option in place — so we unbind and rebind every time.
 */
function bindStationLabel(
  marker: L.Marker,
  name: string,
  permanent: boolean
): void {
  marker.unbindTooltip();
  marker.bindTooltip(name, {
    permanent,
    direction: "top",
    offset: [0, -10],
    className: "station-label",
    opacity: 1,
  });
}

/**
 * Build one LineString feature per rail line. Prefers the backend's precomputed
 * polyline (which routes through a per-line vertex graph with Dijkstra, so it
 * avoids depot spurs and parallel-track zigzag); falls back to a straight hop
 * between ordered stations when the backend geometry is unavailable for that
 * line. The straight-line fallback is purely a degradation path — under normal
 * operation every rail line ships its full backend geometry.
 */
function collapseLinesForRender(
  data: TransitData,
  graph: TransitGraph,
  lineGeometry: LineGeometryByCode | null
): FeatureCollection<LineString, LineProps> {
  const propsByCode = new Map<string, LineProps>();
  for (const f of data.lines.features) {
    const code = f.properties.lineCode;
    if (code) propsByCode.set(code, f.properties);
  }

  const features: Feature<LineString, LineProps>[] = [];
  for (const [code, stations] of graph.byLine) {
    if (stations.length < 2) continue;
    if (stations[0].mode !== "rail") continue;
    const props = propsByCode.get(code);
    if (!props) continue;

    const fromBackend = lineGeometry?.get(code);
    const coords =
      fromBackend && fromBackend.length >= 2
        ? fromBackend
        : stations.map((s) => [s.lng, s.lat] as [number, number]);
    if (coords.length < 2) continue;

    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: props,
    });
  }
  return { type: "FeatureCollection", features };
}

function isTramCode(code: string | null | undefined): boolean {
  // T1/T2/T3/T4/T5 are the IETT tram lines; "T" by itself is treated as
  // tram too. Marmaray and metro/funicular codes (M*, F*, MARMARAY) all use
  // the train icon.
  if (!code) return false;
  return /^T\d/i.test(code);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
