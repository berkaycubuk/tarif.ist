// Map-only line filter. Highlights one rail line at a time, hiding the rest;
// passing `null` hides every rail line. Stations stay visible at all times —
// they're owned by the transit layer, not by this filter.

import L from "leaflet";
import { colorForLine } from "./transit";
import { FEATURES, LIVE_TRAINS_URL } from "./flags";
import {
  buildLineGeometry,
  projectPointOntoLine,
  type LineGeometry,
} from "./geo";

export interface LineInspectorOptions {
  map: L.Map;
  getLinesLayer: () => L.GeoJSON | null;
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
  onLineChange,
}: LineInspectorOptions): LineInspector {
  let selectedLineCode: string | null = null;
  let trainGroup: L.LayerGroup | null = null;

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
    if (FEATURES.liveTrainPositions) startTrainSimulation(code);
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

  // --- Live train markers --------------------------------------------------
  // The server returns pure schedule data per train (which segment, how far
  // through, seconds to next station). The frontend positions each train by
  // projecting both stations onto the *visible* line polyline (the one the
  // user actually sees on the map) and walking that polyline between them,
  // so markers always sit on the line — even when the backend's station
  // ordering treats geographically distant stations as adjacent.

  const POLL_INTERVAL_MS = 2000;

  interface BackendTrain {
    trainIdx: number;
    direction: "ab" | "ba" | "dwell";
    fromStation: string;
    toStation: string;
    segmentProgress: number;
    secondsToNext: number;
  }

  interface BackendStation {
    name: string;
    lat: number;
    lng: number;
  }

  interface LiveTrainState {
    marker: L.Marker;
    /** Marker position at the start of the current rAF interpolation. */
    fromLat: number;
    fromLng: number;
    /** Position the marker is heading toward (latest poll target). */
    toLat: number;
    toLng: number;
    startMs: number;
    durationMs: number;
  }

  const liveTrains = new Map<number, LiveTrainState>();
  /** Station lat/lng by line code, fetched once from /v1/lines?stations=1
   *  and cached for the session. */
  const stationCoords = new Map<string, Map<string, BackendStation>>();
  /** Cached projection data per line code: the parsed LineGeometry of the
   *  visible polyline, plus the cumulative distance (metres) at which each
   *  station projects onto it. Built lazily on first train tick. */
  const lineProjections = new Map<
    string,
    { geom: LineGeometry; stationDist: Map<string, number> }
  >();
  let catalogPromise: Promise<void> | null = null;
  let liveLineCode: string | null = null;
  let pollTimer: number | undefined;
  let rafHandle: number | undefined;
  let abortCtrl: AbortController | null = null;

  function startTrainSimulation(lineCode: string): void {
    stopTrainSimulation();
    if (!FEATURES.liveTrainPositions) return;
    liveLineCode = lineCode;
    if (!trainGroup) trainGroup = L.layerGroup().addTo(map);
    void ensureCatalog().then(() => {
      if (liveLineCode !== lineCode) return;
      void pollOnce(lineCode);
      pollTimer = window.setInterval(() => {
        void pollOnce(lineCode);
      }, POLL_INTERVAL_MS);
      rafHandle = requestAnimationFrame(tickInterpolation);
    });
  }

  function stopTrainSimulation(): void {
    liveLineCode = null;
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    if (rafHandle !== undefined) {
      cancelAnimationFrame(rafHandle);
      rafHandle = undefined;
    }
    if (abortCtrl) {
      abortCtrl.abort();
      abortCtrl = null;
    }
    liveTrains.clear();
    if (trainGroup) {
      map.removeLayer(trainGroup);
      trainGroup = null;
    }
  }

  async function ensureCatalog(): Promise<void> {
    if (!catalogPromise) catalogPromise = loadCatalog();
    return catalogPromise;
  }

  async function loadCatalog(): Promise<void> {
    try {
      const res = await fetch(`${LIVE_TRAINS_URL}/v1/lines?stations=1`);
      if (!res.ok) return;
      const body = (await res.json()) as Array<{
        code: string;
        stations?: BackendStation[];
      }>;
      for (const l of body) {
        if (!l.stations) continue;
        const map = new Map<string, BackendStation>();
        for (const s of l.stations) map.set(s.name, s);
        stationCoords.set(l.code, map);
      }
    } catch (err) {
      console.warn("failed to load line catalog", err);
    }
  }

  /** Build (and cache) projection data for the *visible* polyline of `code`.
   *  Pulls geometry straight from the live `linesLayer`, so the trains track
   *  whatever line the user actually sees on the map. */
  function ensureProjection(
    lineCode: string
  ): { geom: LineGeometry; stationDist: Map<string, number> } | null {
    const cached = lineProjections.get(lineCode);
    if (cached) return cached;
    const linesLayer = getLinesLayer();
    if (!linesLayer) return null;
    let visibleGeom:
      | { type: "LineString" | "MultiLineString"; coordinates: any }
      | null = null;
    linesLayer.eachLayer((layer) => {
      if (visibleGeom) return;
      const feature = (layer as any).feature;
      if (feature?.properties?.lineCode !== lineCode) return;
      const g = feature.geometry;
      if (g?.type === "LineString" || g?.type === "MultiLineString") {
        visibleGeom = g;
      }
    });
    if (!visibleGeom) return null;
    const geom = buildLineGeometry(visibleGeom);
    if (geom.path.length < 2) return null;
    const stations = stationCoords.get(lineCode);
    const stationDist = new Map<string, number>();
    if (stations) {
      for (const [name, s] of stations) {
        const { cumDist } = projectPointOntoLine(s.lng, s.lat, geom);
        stationDist.set(name, cumDist);
      }
    }
    const entry = { geom, stationDist };
    lineProjections.set(lineCode, entry);
    return entry;
  }

  function pointAlongLine(
    geom: LineGeometry,
    dist: number
  ): [number, number] {
    const { path, cum, totalLengthM } = geom;
    if (dist <= 0) return [path[0][1], path[0][0]];
    const last = path.length - 1;
    if (dist >= totalLengthM) return [path[last][1], path[last][0]];
    // Binary search for the segment containing `dist`.
    let lo = 0;
    let hi = last;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= dist) lo = mid;
      else hi = mid;
    }
    const segLen = cum[hi] - cum[lo];
    const f = segLen > 0 ? (dist - cum[lo]) / segLen : 0;
    const [ax, ay] = path[lo];
    const [bx, by] = path[hi];
    return [ay + (by - ay) * f, ax + (bx - ax) * f];
  }

  /** Resolve a train to a target [lat, lng], or null when its station names
   *  aren't in the catalog yet (e.g. the load is still in flight). */
  function targetLatLngFor(
    lineCode: string,
    t: BackendTrain
  ): [number, number] | null {
    const coords = stationCoords.get(lineCode);
    if (!coords) return null;
    const from = coords.get(t.fromStation);
    const to = coords.get(t.toStation);
    if (!from || !to) return null;
    if (t.fromStation === t.toStation || t.direction === "dwell") {
      return [from.lat, from.lng];
    }
    // Walk the renderedPath between the two stations' projections so the
    // marker tracks the visible line through curves, Y-branches, and
    // bay-skirting segments.
    const proj = ensureProjection(lineCode);
    if (proj) {
      const fromDist = proj.stationDist.get(t.fromStation);
      const toDist = proj.stationDist.get(t.toStation);
      if (fromDist !== undefined && toDist !== undefined) {
        const target = fromDist + (toDist - fromDist) * t.segmentProgress;
        return pointAlongLine(proj.geom, target);
      }
    }
    // Fallback for lines whose geometry never loaded: straight-line lerp.
    return [
      from.lat + (to.lat - from.lat) * t.segmentProgress,
      from.lng + (to.lng - from.lng) * t.segmentProgress,
    ];
  }

  async function pollOnce(lineCode: string): Promise<void> {
    if (liveLineCode !== lineCode) return;

    abortCtrl?.abort();
    abortCtrl = new AbortController();
    const myCtrl = abortCtrl;

    try {
      const url = `${LIVE_TRAINS_URL}/v1/positions/${encodeURIComponent(lineCode)}`;
      const res = await fetch(url, { signal: myCtrl.signal });
      if (!res.ok) return;
      const body = (await res.json()) as { trains?: BackendTrain[] };
      if (liveLineCode !== lineCode) return;
      applyTrains(lineCode, body.trains ?? []);
    } catch (err) {
      if ((err as { name?: string } | null)?.name !== "AbortError") {
        console.warn("live train poll failed", err);
      }
    }
  }

  function applyTrains(lineCode: string, trains: BackendTrain[]): void {
    if (!trainGroup) return;
    const color = colorForLine(lineCode);
    const now = performance.now();
    const seen = new Set<number>();

    for (const t of trains) {
      const target = targetLatLngFor(lineCode, t);
      if (!target) continue;
      const [targetLat, targetLng] = target;
      seen.add(t.trainIdx);
      const existing = liveTrains.get(t.trainIdx);
      if (existing) {
        // Snapshot the current interpolated position as the new "from" so
        // the marker glides smoothly into the fresh target.
        const eased = interpFraction(existing, now);
        existing.fromLat =
          existing.fromLat + (existing.toLat - existing.fromLat) * eased;
        existing.fromLng =
          existing.fromLng + (existing.toLng - existing.fromLng) * eased;
        existing.toLat = targetLat;
        existing.toLng = targetLng;
        existing.startMs = now;
        existing.durationMs = POLL_INTERVAL_MS;
        existing.marker.setIcon(createTrainIcon(color, t.direction));
      } else {
        const marker = L.marker([targetLat, targetLng], {
          icon: createTrainIcon(color, t.direction),
          interactive: false,
          keyboard: false,
          zIndexOffset: 1000,
        });
        marker.addTo(trainGroup);
        liveTrains.set(t.trainIdx, {
          marker,
          fromLat: targetLat,
          fromLng: targetLng,
          toLat: targetLat,
          toLng: targetLng,
          startMs: now,
          durationMs: POLL_INTERVAL_MS,
        });
      }
    }

    for (const [idx, state] of liveTrains) {
      if (!seen.has(idx)) {
        trainGroup.removeLayer(state.marker);
        liveTrains.delete(idx);
      }
    }
  }

  function interpFraction(state: LiveTrainState, now: number): number {
    if (state.durationMs <= 0) return 1;
    const f = (now - state.startMs) / state.durationMs;
    if (f <= 0) return 0;
    if (f >= 1) return 1;
    return f;
  }

  function tickInterpolation(): void {
    rafHandle = undefined;
    if (liveLineCode === null) return;
    const now = performance.now();
    for (const state of liveTrains.values()) {
      const f = interpFraction(state, now);
      const lat = state.fromLat + (state.toLat - state.fromLat) * f;
      const lng = state.fromLng + (state.toLng - state.fromLng) * f;
      state.marker.setLatLng([lat, lng]);
    }
    rafHandle = requestAnimationFrame(tickInterpolation);
  }

  function createTrainIcon(color: string, direction: "ab" | "ba" | "dwell"): L.DivIcon {
    // The leading-dot indicator gives the rider a sense of heading; for
    // dwelling trains we centre it so the marker reads as "stopped".
    const dotStyle =
      direction === "ab"
        ? "right: 2px;"
        : direction === "ba"
          ? "left: 2px;"
          : "left: 50%; transform: translate(-50%, -50%);";
    const opacity = direction === "dwell" ? 0.6 : 1;
    return L.divIcon({
      className: "train-marker",
      html: `<div style="
        width: 24px; height: 13px;
        background: ${color};
        border: 2px solid #fff;
        border-radius: 7px;
        box-shadow: 0 2px 6px rgba(0,0,0,0.35);
        opacity: ${opacity};
        position: relative;
      ">
        <div style="
          position: absolute; top: 50%;
          ${direction === "dwell" ? "" : "transform: translateY(-50%);"}
          width: 5px; height: 5px;
          background: #fff;
          border-radius: 50%;
          ${dotStyle}
        "></div>
      </div>`,
      iconSize: [24, 13],
      iconAnchor: [12, 6],
    });
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
