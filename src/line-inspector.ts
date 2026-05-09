// Line inspector: legend, line selection/filtering, and animated train markers.
// Owns the legend DOM subtree and responds to user line selection.

import L from "leaflet";
import { colorForLine } from "./transit";
import { getLineStations, haversineMeters, type TransitGraph } from "./graph";
import type { DisruptionSeverity } from "./disruptions";

export interface LineInspectorOptions {
  container: HTMLElement;
  map: L.Map;
  getLinesLayer: () => L.GeoJSON | null;
  getStationsLayer: () => L.GeoJSON | null;
  getGraph: () => TransitGraph | null;
  /** Fires whenever the selected line changes (including null = "All Lines"). */
  onLineChange?: (code: string | null) => void;
}

export interface DisruptionBadgeInfo {
  count: number;
  severity: DisruptionSeverity;
}

export interface LineInspector {
  /** Populate the legend with available line codes. */
  setLines(codes: string[]): void;
  /** Programmatically select (or deselect) a line. */
  selectLine(code: string | null): void;
  /** Annotate legend buttons with disruption badges. */
  setDisruptionBadges(badges: Map<string, DisruptionBadgeInfo>): void;
  destroy(): void;
}

export function setupLineInspector({
  container,
  map,
  getLinesLayer,
  getStationsLayer,
  getGraph,
  onLineChange,
}: LineInspectorOptions): LineInspector {
  // --- DOM setup ---

  container.innerHTML = `
    <div class="mb-1.5 flex items-center justify-between">
      <span class="font-semibold tracking-tight text-slate-800">Lines</span>
      <button id="legend-toggle" type="button" class="text-[11px] text-slate-500 hover:text-slate-700">Hide</button>
    </div>
    <div id="legend-body" class="flex flex-col gap-0.5 max-h-[360px] overflow-y-auto"></div>
  `;

  const body = container.querySelector<HTMLDivElement>("#legend-body")!;
  const toggle = container.querySelector<HTMLButtonElement>("#legend-toggle")!;

  toggle.addEventListener("click", () => {
    const collapsed = body.classList.toggle("hidden");
    toggle.textContent = collapsed ? "Show" : "Hide";
  });

  let selectedLineCode: string | null = null;
  let trainGroup: L.LayerGroup | null = null;
  let disruptionBadges: Map<string, DisruptionBadgeInfo> = new Map();

  const SEVERITY_COLOR: Record<DisruptionSeverity, string> = {
    info: "#0284c7",
    warning: "#d97706",
    critical: "#dc2626",
  };

  // --- Headway data ---------------------------------------------------------

  let headwayData: Record<
    string,
    { headwaySec: number; tripDurationSec: number; trainCount: number }
  > | null = null;

  fetch("/data/headways.json")
    .then((r) => r.json())
    .then((d) => {
      headwayData = d;
      console.info(`headways loaded for ${Object.keys(d).length} lines`);
    })
    .catch(() => {
      console.warn("headways.json not available — using default train counts");
    });

  // --- Legend rendering ------------------------------------------------------

  function renderLegend(codes: string[]): void {
    if (!codes.length) return;

    body.innerHTML = "";

    // "All Lines" button
    const allBtn = document.createElement("button");
    allBtn.id = "legend-all";
    allBtn.type = "button";
    allBtn.className =
      "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] font-medium transition hover:bg-slate-100 bg-slate-200 ring-1 ring-slate-300";
    allBtn.innerHTML = `
      <span class="inline-block h-3 w-3 shrink-0 rounded-full bg-slate-500"></span>
      All Lines
    `;
    allBtn.addEventListener("click", () => selectLine(null));
    body.appendChild(allBtn);

    for (const code of codes) {
      const color = colorForLine(code);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.line = code;
      btn.className =
        "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] font-medium transition hover:bg-slate-100";
      btn.innerHTML = `
        <span class="inline-block h-3 w-3 shrink-0 rounded-full" style="background:${color}"></span>
        <span>${code}</span>
        <span data-disruption-badge class="ml-auto"></span>
      `;
      btn.addEventListener("click", () => selectLine(code));
      body.appendChild(btn);
    }
    renderDisruptionBadges();
  }

  function renderDisruptionBadges(): void {
    body.querySelectorAll<HTMLButtonElement>("button[data-line]").forEach(
      (btn) => {
        const code = btn.dataset.line!;
        const slot = btn.querySelector<HTMLElement>(
          "[data-disruption-badge]"
        );
        if (!slot) return;
        const info = disruptionBadges.get(code);
        if (!info) {
          slot.innerHTML = "";
          slot.removeAttribute("title");
          return;
        }
        const bg = SEVERITY_COLOR[info.severity];
        slot.setAttribute(
          "title",
          `${info.count} active ${info.count === 1 ? "alert" : "alerts"} (${info.severity})`
        );
        slot.innerHTML = `
          <span style="
            display:inline-flex;align-items:center;gap:3px;
            background:${bg};color:#fff;
            font-size:9px;font-weight:700;line-height:1;
            padding:2px 5px;border-radius:999px;letter-spacing:0.04em;
          ">
            <span style="font-size:10px;line-height:1">!</span>${info.count}
          </span>
        `;
      }
    );
  }

  function updateLegendHighlight(): void {
    body.querySelectorAll("button[data-line], #legend-all").forEach((el) => {
      const btn = el as HTMLButtonElement;
      const isActive =
        selectedLineCode === null
          ? btn.id === "legend-all"
          : btn.dataset.line === selectedLineCode;
      if (isActive) {
        btn.classList.add("bg-slate-200", "ring-1", "ring-slate-300");
      } else {
        btn.classList.remove("bg-slate-200", "ring-1", "ring-slate-300");
      }
    });
  }

  // --- Line filtering -------------------------------------------------------

  function applyLineFilter(code: string | null): void {
    const linesLayer = getLinesLayer();
    const stationsLayer = getStationsLayer();
    if (!linesLayer || !stationsLayer) return;

    // Always tear down labels first so a line→line switch is clean.
    hideStationLabels();

    if (!code) {
      resetAllLayers();
      stopTrainSimulation();
      return;
    }

    // Dim other lines, highlight selected
    linesLayer.eachLayer((layer) => {
      const feature = (layer as any).feature;
      const lineCode = feature?.properties?.lineCode as string | undefined;
      if (lineCode === code) {
        (layer as L.Path).setStyle({ opacity: 0.95, weight: 6 });
      } else {
        (layer as L.Path).setStyle({ opacity: 0.08, weight: 2 });
      }
    });

    stationsLayer.eachLayer((layer) => {
      const feature = (layer as any).feature;
      const lineCode = feature?.properties?.lineCode as string | undefined;
      if (lineCode === code) {
        (layer as L.CircleMarker).setStyle({ opacity: 1, fillOpacity: 1 });
      } else {
        (layer as L.CircleMarker).setStyle({ opacity: 0, fillOpacity: 0 });
      }
    });

    showStationLabels(code);
    startTrainSimulation(code);
  }

  function showStationLabels(code: string): void {
    const stationsLayer = getStationsLayer();
    if (!stationsLayer) return;
    stationsLayer.eachLayer((layer) => {
      const cm = layer as L.CircleMarker & { feature?: any };
      const props = cm.feature?.properties;
      if (props?.lineCode !== code) return;
      const name = (props.name ?? "").toString();
      if (!name) return;
      cm.bindTooltip(name, {
        permanent: true,
        direction: "right",
        offset: [8, 0],
        className: "station-label",
        opacity: 1,
      });
    });
  }

  function hideStationLabels(): void {
    const stationsLayer = getStationsLayer();
    if (!stationsLayer) return;
    stationsLayer.eachLayer((layer) => {
      const cm = layer as L.CircleMarker;
      if (cm.getTooltip?.()) cm.unbindTooltip();
    });
  }

  function resetAllLayers(): void {
    const linesLayer = getLinesLayer();
    const stationsLayer = getStationsLayer();
    linesLayer?.eachLayer((layer) => {
      const feature = (layer as any).feature;
      const lineCode = feature?.properties?.lineCode as string | undefined;
      const color = colorForLine(lineCode);
      (layer as L.Path).setStyle({ color, opacity: 0.85, weight: 4 });
    });
    stationsLayer?.eachLayer((layer) => {
      (layer as L.CircleMarker).setStyle({ opacity: 1, fillOpacity: 1 });
    });
  }

  // --- Train simulation -----------------------------------------------------

  function createTrainIcon(color: string, dir: 1 | -1): L.DivIcon {
    const dotSide = dir === 1 ? "right: 2px;" : "left: 2px;";
    return L.divIcon({
      className: "train-marker",
      html: `<div style="
        width: 24px; height: 13px;
        background: ${color};
        border: 2px solid #fff;
        border-radius: 7px;
        box-shadow: 0 2px 6px rgba(0,0,0,0.35);
        position: relative;
      ">
        <div style="
          position: absolute; top: 50%;
          transform: translateY(-50%);
          width: 5px; height: 5px;
          background: #fff;
          border-radius: 50%;
          ${dotSide}
        "></div>
      </div>`,
      iconSize: [24, 13],
      iconAnchor: [12, 6],
    });
  }

  function getRenderedPath(
    lineCode: string
  ): Array<[number, number]> | null {
    const linesLayer = getLinesLayer();
    if (!linesLayer) return null;
    const result: Array<[number, number]> = [];
    linesLayer.eachLayer((layer) => {
      const feature = (layer as any).feature;
      if (feature?.properties?.lineCode !== lineCode) return;
      const geom = feature.geometry;
      if (!geom) return;
      if (geom.type === "LineString") {
        for (const c of geom.coordinates) {
          result.push([c[0], c[1]] as [number, number]);
        }
      } else if (geom.type === "MultiLineString") {
        for (const part of geom.coordinates) {
          for (const c of part) {
            result.push([c[0], c[1]] as [number, number]);
          }
        }
      }
    });
    return result.length >= 2 ? result : null;
  }

  function placeTrainMarkers(lineCode: string): void {
    const graph = getGraph();
    if (!graph) return;

    const stations = getLineStations(graph, lineCode);
    if (!stations || stations.length < 2) return;

    const path = getRenderedPath(lineCode);
    if (!path || path.length < 2) return;

    let count = 3;
    if (headwayData?.[lineCode]) {
      count = headwayData[lineCode].trainCount;
    } else {
      count = Math.max(2, Math.round(stations.length / 2));
    }

    const color = colorForLine(lineCode);

    const cum = new Float64Array(path.length);
    let total = 0;
    for (let i = 1; i < path.length; i++) {
      total += haversineMeters(
        path[i - 1][1],
        path[i - 1][0],
        path[i][1],
        path[i][0]
      );
      cum[i] = total;
    }
    if (total <= 0) return;

    const destForward = stations[stations.length - 1].stationName;
    const destBackward = stations[0].stationName;

    trainGroup = L.layerGroup().addTo(map);

    for (let i = 0; i < count; i++) {
      const targetDist = (total / count) * (i + 0.5);
      const dir: 1 | -1 = i % 2 === 0 ? 1 : -1;
      const destination = dir === 1 ? destForward : destBackward;

      let lo = 1,
        hi = path.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (cum[mid] < targetDist) lo = mid + 1;
        else hi = mid;
      }

      const segLen = cum[lo] - cum[lo - 1];
      const t =
        segLen > 1e-9 ? (targetDist - cum[lo - 1]) / segLen : 0.5;
      const tc = Math.max(0, Math.min(1, t));
      const lng = path[lo - 1][0] + tc * (path[lo][0] - path[lo - 1][0]);
      const lat = path[lo - 1][1] + tc * (path[lo][1] - path[lo - 1][1]);

      const marker = L.marker([lat, lng], {
        icon: createTrainIcon(color, dir),
        interactive: true,
        keyboard: false,
        zIndexOffset: 1000,
      });

      marker.bindPopup(
        `
        <div style="min-width:140px;font-size:12px">
          <div style="font-weight:600;color:#0f172a;margin-bottom:2px">${escape(lineCode)} train</div>
          <div style="color:#64748b;font-size:11px">
            <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${color};margin-right:4px"></span>
            Heading to <strong style="color:#0f172a">${escape(destination)}</strong>
          </div>
        </div>
      `,
        { closeButton: false, className: "train-popup" }
      );

      marker.addTo(trainGroup!);
    }
  }

  function startTrainSimulation(_lineCode: string): void {
    // Train rendering is temporarily disabled — re-enable by calling
    // placeTrainMarkers(_lineCode) once the WIP train work resumes.
    void placeTrainMarkers;
    stopTrainSimulation();
  }

  function stopTrainSimulation(): void {
    if (trainGroup) {
      map.removeLayer(trainGroup);
      trainGroup = null;
    }
  }

  // --- Public API -----------------------------------------------------------

  function selectLine(code: string | null): void {
    if (code === selectedLineCode) {
      // Notify anyway so subscribers can re-sync state.
      onLineChange?.(code);
      return;
    }
    selectedLineCode = code;
    updateLegendHighlight();
    applyLineFilter(code);
    onLineChange?.(code);
  }

  return {
    setLines(codes: string[]) {
      renderLegend(codes);
      container.classList.remove("hidden");
    },
    selectLine,
    setDisruptionBadges(badges: Map<string, DisruptionBadgeInfo>) {
      disruptionBadges = badges;
      renderDisruptionBadges();
    },
    destroy() {
      stopTrainSimulation();
      container.innerHTML = "";
      container.classList.add("hidden");
    },
  };
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
