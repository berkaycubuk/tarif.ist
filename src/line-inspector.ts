// Map-only line filter. Highlights one rail line at a time, hiding the rest;
// passing `null` hides every rail line. Stations stay visible at all times —
// they're owned by the transit layer, not by this filter.

import L from "leaflet";
import { colorForLine } from "./transit";
import { getLineStations, haversineMeters, type TransitGraph } from "./graph";

export interface LineInspectorOptions {
  map: L.Map;
  getLinesLayer: () => L.GeoJSON | null;
  getGraph: () => TransitGraph | null;
  /** Fires whenever the selected line changes (including null). */
  onLineChange?: (code: string | null) => void;
}

export interface LineInspector {
  /** Programmatically select a line, or pass null to hide all. */
  selectLine(code: string | null): void;
  /** Currently selected rail line, or null. */
  current(): string | null;
  destroy(): void;
}

export function setupLineInspector({
  map,
  getLinesLayer,
  getGraph,
  onLineChange,
}: LineInspectorOptions): LineInspector {
  let selectedLineCode: string | null = null;
  let trainGroup: L.LayerGroup | null = null;

  // --- Headway data (used for train marker counts) -------------------------

  let headwayData: Record<
    string,
    { headwaySec: number; tripDurationSec: number; trainCount: number }
  > | null = null;

  fetch("/data/headways.json")
    .then((r) => r.json())
    .then((d) => {
      headwayData = d;
    })
    .catch(() => {
      // optional
    });

  // --- Filter -------------------------------------------------------------

  function applyLineFilter(code: string | null): void {
    const linesLayer = getLinesLayer();
    if (!linesLayer) return;

    stopTrainSimulation();

    // Stations stay visible at all times now — only the line geometry is
    // shown/hidden by selection.
    if (!code) {
      linesLayer.eachLayer((layer) => {
        (layer as L.Path).setStyle({ opacity: 0, weight: 0 });
      });
      return;
    }

    linesLayer.eachLayer((layer) => {
      const feature = (layer as any).feature;
      const lineCode = feature?.properties?.lineCode as string | undefined;
      if (lineCode === code) {
        (layer as L.Path).setStyle({ opacity: 0.95, weight: 6 });
      } else {
        (layer as L.Path).setStyle({ opacity: 0, weight: 0 });
      }
    });

    fitToLine(code);
    startTrainSimulation(code);
  }

  function fitToLine(code: string): void {
    const linesLayer = getLinesLayer();
    if (!linesLayer) return;
    const bounds = L.latLngBounds([]);
    linesLayer.eachLayer((layer) => {
      const feature = (layer as any).feature;
      if (feature?.properties?.lineCode !== code) return;
      const path = layer as L.Path;
      const lb = (path as unknown as { getBounds?: () => L.LatLngBounds })
        .getBounds?.();
      if (lb) bounds.extend(lb);
    });
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    }
  }

  // --- Train markers (currently disabled; kept for future use) -------------

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

    trainGroup = L.layerGroup().addTo(map);

    for (let i = 0; i < count; i++) {
      const targetDist = (total / count) * (i + 0.5);
      const dir: 1 | -1 = i % 2 === 0 ? 1 : -1;

      let lo = 1,
        hi = path.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (cum[mid] < targetDist) lo = mid + 1;
        else hi = mid;
      }

      const segLen = cum[lo] - cum[lo - 1];
      const t = segLen > 1e-9 ? (targetDist - cum[lo - 1]) / segLen : 0.5;
      const tc = Math.max(0, Math.min(1, t));
      const lng = path[lo - 1][0] + tc * (path[lo][0] - path[lo - 1][0]);
      const lat = path[lo - 1][1] + tc * (path[lo][1] - path[lo - 1][1]);

      const marker = L.marker([lat, lng], {
        icon: createTrainIcon(color, dir),
        interactive: false,
        keyboard: false,
        zIndexOffset: 1000,
      });
      marker.addTo(trainGroup!);
    }
  }

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

  function startTrainSimulation(_lineCode: string): void {
    void placeTrainMarkers;
    stopTrainSimulation();
  }

  function stopTrainSimulation(): void {
    if (trainGroup) {
      map.removeLayer(trainGroup);
      trainGroup = null;
    }
  }

  // --- Public API ---------------------------------------------------------

  function selectLine(code: string | null): void {
    selectedLineCode = code;
    applyLineFilter(code);
    onLineChange?.(code);
  }

  // Initial state: nothing visible.
  // Defer until the first real selection so we don't fight the layer init.

  return {
    selectLine,
    current: () => selectedLineCode,
    destroy() {
      stopTrainSimulation();
    },
  };
}
