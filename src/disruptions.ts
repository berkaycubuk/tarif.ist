// Renders service disruptions on the map: dashed segments along affected
// stretches of a line, plus warning markers at affected stations. Station
// names are auto-detected from the Turkish description text by matching
// against the known stations of the affected line.
//
// The disruption feed itself comes from the livepos backend at
// `${LIVE_TRAINS_URL}/v1/disruptions`. The backend polls the IBB Metro
// Istanbul service-status API in the background and caches the adapted
// (line-code normalized, type/severity inferred, title formatted) payload —
// the slow upstream call no longer happens per-client.

import L from "leaflet";
import { sliceLine } from "./geo";
import { LIVE_TRAINS_URL } from "./flags";
import type { TransitGraph, StationNode } from "./graph";

export type DisruptionSeverity = "info" | "warning" | "critical";
export type DisruptionType =
  | "incident"
  | "delay"
  | "closure"
  | "maintenance"
  | "repair";

export interface Disruption {
  id: string;
  lineCode: string;
  severity: DisruptionSeverity;
  type: DisruptionType;
  title: string;
  description: string;
  stations?: string[];
  startTime?: string | null;
  endTime?: string | null;
}

const SEVERITY_COLOR: Record<DisruptionSeverity, string> = {
  info: "#0284c7",
  warning: "#d97706",
  critical: "#dc2626",
};

const TYPE_LABEL: Record<DisruptionType, string> = {
  incident: "Incident",
  delay: "Delay",
  closure: "Closure",
  maintenance: "Maintenance",
  repair: "Repair",
};

export interface DisruptionLayer {
  /** All disruptions that were resolved against the graph. */
  disruptions: Disruption[];
  /** Disruption count per affected line code. */
  countsByLine: Map<string, number>;
  /** Worst severity per affected line code (for badge color). */
  severityByLine: Map<string, DisruptionSeverity>;
  /**
   * Show only the disruption overlays for the given line code. Pass `null`
   * to hide all (e.g. when "All Lines" is selected).
   */
  setVisibleLine(code: string | null): void;
  destroy(): void;
}

// --- Backend feed -----------------------------------------------------------

interface BackendDisruptionItem {
  id: string;
  lineCode: string;
  severity: DisruptionSeverity;
  type: DisruptionType;
  title: string;
  description: string;
  startTime?: string | null;
  endTime?: string | null;
}

interface BackendDisruptionsResponse {
  fetchedAt: number;
  items?: BackendDisruptionItem[];
}

/**
 * Fetch the cached disruption snapshot from the livepos backend.
 *
 * The backend polls the IBB Metro Istanbul API in the background and does all
 * the line-code normalization and Turkish-keyword classification server-side,
 * so this is a fast read of a small JSON document. Returns an empty list on
 * any error so the rest of the app keeps working — disruptions are a non-
 * critical overlay.
 */
export async function loadDisruptions(): Promise<Disruption[]> {
  try {
    const res = await fetch(`${LIVE_TRAINS_URL}/v1/disruptions`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn(`disruptions backend returned HTTP ${res.status}`);
      return [];
    }
    const body = (await res.json()) as BackendDisruptionsResponse;
    const items = Array.isArray(body?.items) ? body.items : [];
    const out: Disruption[] = items.map((item) => ({
      id: item.id,
      lineCode: item.lineCode,
      severity: item.severity,
      type: item.type,
      title: item.title,
      description: item.description,
      // Stations are auto-detected later from the description text.
      stations: undefined,
      startTime: item.startTime ?? null,
      endTime: item.endTime ?? null,
    }));
    if (out.length) {
      console.info(
        `disruptions loaded: ${out.length} active · lines: ${[...new Set(out.map((d) => d.lineCode))].join(", ")}`
      );
    }
    return out;
  } catch (err) {
    console.warn("disruptions: backend fetch failed", err);
    return [];
  }
}

/**
 * Render disruptions into per-line layer groups. Groups are NOT added to the
 * map by default — call `setVisibleLine(code)` to reveal a line's overlays.
 * This keeps the map uncluttered until the user focuses on a specific line.
 */
export function renderDisruptions(
  map: L.Map,
  graph: TransitGraph | null,
  disruptions: Disruption[]
): DisruptionLayer {
  const groupsByLine = new Map<string, L.LayerGroup>();
  const countsByLine = new Map<string, number>();
  const severityByLine = new Map<string, DisruptionSeverity>();
  const resolved: Disruption[] = [];
  let visibleCode: string | null = null;

  const groupFor = (code: string): L.LayerGroup => {
    let g = groupsByLine.get(code);
    if (!g) {
      g = L.layerGroup();
      groupsByLine.set(code, g);
    }
    return g;
  };

  for (const d of disruptions) {
    countsByLine.set(d.lineCode, (countsByLine.get(d.lineCode) ?? 0) + 1);
    severityByLine.set(
      d.lineCode,
      worstSeverity(severityByLine.get(d.lineCode), d.severity)
    );
    resolved.push(d);

    if (!graph) continue;

    const stations = graph.byLine.get(d.lineCode);
    const lineGeom = graph.lineGeometry.get(d.lineCode);
    if (!stations || !lineGeom) continue;

    const group = groupFor(d.lineCode);

    // Match stations either from the disruption's explicit list (manual data)
    // or by scanning the description text against this line's station names.
    const matched =
      d.stations && d.stations.length
        ? matchStations(stations, d.stations)
        : detectStationsInText(stations, d.description);

    const color = SEVERITY_COLOR[d.severity];

    // Dashed overlay: between matched stations, or the whole line if none matched.
    let overlayCoords: Array<[number, number]> | null = null;
    if (matched.length >= 2) {
      const cums = matched.map((s) => s.cumDistOnLine);
      const lo = Math.min(...cums);
      const hi = Math.max(...cums);
      overlayCoords = sliceLine(lineGeom, lo, hi);
    } else if (matched.length === 0) {
      overlayCoords = lineGeom.path;
    }

    if (overlayCoords && overlayCoords.length >= 2) {
      const latlngs = overlayCoords.map(
        ([lng, lat]) => [lat, lng] as L.LatLngTuple
      );
      const overlay = L.polyline(latlngs, {
        color,
        weight: 6,
        opacity: 0.95,
        dashArray: "8 8",
        lineCap: "round",
        lineJoin: "round",
        interactive: true,
      });
      overlay.bindTooltip(disruptionTooltip(d), {
        sticky: true,
        direction: "top",
        opacity: 0.95,
        className: "disruption-tooltip",
      });
      overlay.bindPopup(disruptionPopup(d), { className: "pin-popup" });
      overlay.addTo(group);
    }

    // Warning markers at each affected station.
    for (const s of matched) {
      const marker = L.marker([s.lat, s.lng], {
        icon: warningIcon(d.severity),
        zIndexOffset: 2000,
        interactive: true,
        keyboard: false,
      });
      marker.bindPopup(disruptionPopup(d, s.stationName), {
        className: "pin-popup",
      });
      marker.bindTooltip(`${TYPE_LABEL[d.type]} · ${escapeHtml(s.stationName)}`, {
        direction: "top",
        opacity: 0.95,
        className: "disruption-tooltip",
      });
      marker.addTo(group);
    }

    // No specific stations? Drop a single warning pin at the line midpoint so
    // a clickable popup is always reachable even if the dashed overlay is dim.
    if (matched.length === 0 && stations.length > 0) {
      const mid = stations[Math.floor(stations.length / 2)];
      const marker = L.marker([mid.lat, mid.lng], {
        icon: warningIcon(d.severity),
        zIndexOffset: 2000,
      });
      marker.bindPopup(disruptionPopup(d), { className: "pin-popup" });
      marker.addTo(group);
    }
  }

  function setVisibleLine(code: string | null): void {
    if (code === visibleCode) return;
    if (visibleCode) {
      const g = groupsByLine.get(visibleCode);
      if (g && map.hasLayer(g)) map.removeLayer(g);
    }
    visibleCode = code;
    if (code) {
      const g = groupsByLine.get(code);
      if (g && !map.hasLayer(g)) g.addTo(map);
    }
  }

  return {
    disruptions: resolved,
    countsByLine,
    severityByLine,
    setVisibleLine,
    destroy() {
      for (const g of groupsByLine.values()) {
        if (map.hasLayer(g)) map.removeLayer(g);
      }
      groupsByLine.clear();
    },
  };
}

// --- helpers ----------------------------------------------------------------

function worstSeverity(
  a: DisruptionSeverity | undefined,
  b: DisruptionSeverity
): DisruptionSeverity {
  const rank: Record<DisruptionSeverity, number> = {
    info: 0,
    warning: 1,
    critical: 2,
  };
  if (!a) return b;
  return rank[b] > rank[a] ? b : a;
}

function normalizeName(s: string): string {
  return s
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[ıİ]/g, "i")
    .replace(/[^a-z0-9]/g, "");
}

function matchStations(
  lineStations: StationNode[],
  names: string[]
): StationNode[] {
  if (!names.length) return [];
  const wanted = new Set(names.map(normalizeName));
  return lineStations.filter((s) => wanted.has(normalizeName(s.stationName)));
}

/**
 * Find which of the line's stations are referenced (by name) inside a free
 * Turkish description. Uses normalised substring matching and skips very
 * short station names to avoid spurious hits.
 */
function detectStationsInText(
  lineStations: StationNode[],
  text: string
): StationNode[] {
  if (!text) return [];
  const normText = normalizeName(text);
  const hits: StationNode[] = [];
  for (const s of lineStations) {
    const name = normalizeName(s.stationName);
    if (name.length < 4) continue;
    if (normText.includes(name)) hits.push(s);
  }
  return hits;
}

function warningIcon(severity: DisruptionSeverity): L.DivIcon {
  const color = SEVERITY_COLOR[severity];
  return L.divIcon({
    className: "disruption-marker",
    html: `<div style="
        width: 22px; height: 22px;
        background: ${color};
        border: 2px solid #fff;
        border-radius: 50%;
        box-shadow: 0 2px 6px rgba(0,0,0,0.4);
        display: flex; align-items: center; justify-content: center;
        font-weight: 700; color: #fff;
        font-size: 14px; line-height: 1;
        font-family: system-ui, -apple-system, sans-serif;
      ">!</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function severityChip(severity: DisruptionSeverity): string {
  const color = SEVERITY_COLOR[severity];
  const label = severity.toUpperCase();
  return `<span style="
      display:inline-block;
      padding:1px 6px;
      border-radius:999px;
      background:${color};
      color:#fff;
      font-size:10px;
      font-weight:700;
      letter-spacing:0.04em;
    ">${label}</span>`;
}

function formatTimeRange(d: Disruption): string {
  const fmt = (iso?: string | null) => {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString("tr-TR", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "short",
    });
  };
  const start = fmt(d.startTime);
  const end = fmt(d.endTime);
  if (start && end) return `${start} → ${end}`;
  if (start && !end) return `since ${start}`;
  if (!start && end) return `until ${end}`;
  return "";
}

function disruptionTooltip(d: Disruption): string {
  return `<strong>${escapeHtml(d.lineCode)}</strong> · ${escapeHtml(
    TYPE_LABEL[d.type]
  )} — ${escapeHtml(d.title)}`;
}

function disruptionPopup(d: Disruption, stationName?: string): string {
  const time = formatTimeRange(d);
  return `
    <div style="min-width:220px;max-width:280px;font-family:inherit">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        ${severityChip(d.severity)}
        <span style="font-size:11px;font-weight:600;color:#475569;text-transform:uppercase;letter-spacing:0.04em">
          ${escapeHtml(d.lineCode)} · ${escapeHtml(TYPE_LABEL[d.type])}
        </span>
      </div>
      <div style="font-weight:600;font-size:13px;color:#0f172a;margin-bottom:4px">
        ${escapeHtml(d.title)}
      </div>
      ${
        stationName
          ? `<div style="font-size:11px;color:#64748b;margin-bottom:4px">At ${escapeHtml(stationName)}</div>`
          : ""
      }
      <div style="font-size:12px;color:#334155;line-height:1.4">
        ${escapeHtml(d.description)}
      </div>
      ${
        time
          ? `<div style="margin-top:6px;font-size:11px;color:#64748b">${escapeHtml(time)}</div>`
          : ""
      }
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
