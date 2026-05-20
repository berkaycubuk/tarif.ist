// Map-only line filter. Highlights one rail line at a time, hiding the rest;
// passing `null` hides every rail line. Stations stay visible at all times —
// they're owned by the transit layer, not by this filter.

import L from "leaflet";
import { colorForLine } from "./transit";
import { FEATURES, LIVE_TRAINS_URL } from "./flags";

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

  // --- Live train markers --------------------------------------------------
  // The server returns pure schedule data per train (which segment, how far
  // through, seconds to next station). All positioning is done here: for
  // each train we look up its from/to stations in the catalog and lerp in
  // a straight line between their coordinates. No polyline walking — that
  // turned out to be too fragile against messy MultiLineString geometry.

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
    // Straight-line interpolation between the two stations. Stations along a
    // metro line are usually <1 km apart, so a straight line is a faithful
    // approximation of the track for most of the network.
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
