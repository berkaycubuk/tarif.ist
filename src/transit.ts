import L from "leaflet";
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiLineString,
  Point,
} from "geojson";
import trainIconUrl from "./assets/train.svg";

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

export function addTransitLayers(
  map: L.Map,
  data: TransitData
): { lines: L.GeoJSON; stations: L.GeoJSON } {
  const lines = L.geoJSON(data.lines, {
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

  const stations = L.geoJSON(data.stations, {
    pointToLayer: (_feature, latlng) =>
      L.marker(latlng, {
        icon: trainStationIcon(),
        keyboard: false,
      }),
    onEachFeature: (feature, layer) => {
      const p = feature.properties as StationProps;
      const code = p.lineCode ?? "—";
      const color = colorForLine(p.lineCode);
      layer.bindPopup(`
        <div style="min-width:160px">
          <div style="font-weight:600;font-size:13px;color:#0f172a;margin-bottom:4px">${escapeHtml(p.name)}</div>
          <div style="display:inline-flex;align-items:center;gap:6px;font-size:11px">
            <span style="display:inline-block;width:8px;height:8px;border-radius:999px;background:${color}"></span>
            <span style="font-weight:600;color:${color}">${escapeHtml(code)}</span>
            <span style="color:#64748b">${escapeHtml(p.kind ?? "")}</span>
          </div>
          <div style="font-size:11px;color:#64748b;margin-top:4px">${escapeHtml(p.lineName)}</div>
        </div>
      `);
    },
  });

  lines.addTo(map);

  // Stations only render at street-level zoom — at city overview the colored
  // pips cluster into noise.
  const MIN_STATION_ZOOM = 12;
  function syncStationVisibility(): void {
    if (map.getZoom() >= MIN_STATION_ZOOM) {
      if (!map.hasLayer(stations)) stations.addTo(map);
    } else if (map.hasLayer(stations)) {
      map.removeLayer(stations);
    }
  }
  syncStationVisibility();
  map.on("zoomend", syncStationVisibility);

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

function trainStationIcon(): L.DivIcon {
  // Tailwind preflight applies `img { max-width: 100%; height: auto }`, which
  // beats <img>'s width/height attributes (the source SVG is 800×800). The
  // `!important` on the inline style locks the size we actually want.
  const html = `<span style="
    display:flex;align-items:center;justify-content:center;
    width:18px;height:18px;border-radius:50%;
    background:#fff;
    box-shadow:0 1px 2px rgba(15,23,42,0.35);
  "><img src="${trainIconUrl}" alt="" style="width:14px !important;height:14px !important;display:block;max-width:none;"/></span>`;
  return L.divIcon({
    className: "rail-station-icon",
    html,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
