import "./style.css";
import L from "leaflet";
import { createMap } from "./map";
import {
  addTransitLayers,
  loadTransitData,
  railStationKey,
  uniqueLineCodes,
  type RailStationsLayer,
} from "./transit";
import {
  buildGraph,
  type BusSegmentData,
  type TransitGraph,
} from "./graph";
import { findRoute } from "./router";
import { renderRoute } from "./route-render";
import { setupLineInspector } from "./line-inspector";
import { setupPlanPanel } from "./plan-panel";
import { setupRouteViewer } from "./route-viewer";
import { tryDecodeShareRoute } from "./route-share";
import {
  loadDisruptions,
  renderDisruptions,
  type DisruptionLayer,
} from "./disruptions";
import {
  setupBus,
  setupBusStopsLayer,
  type BusController,
  type BusStopsLayer,
} from "./bus";
import {
  setupSearchBar,
  type SearchItem,
  type RailItem,
} from "./search-bar";
import { t } from "./i18n";
import "./theme"; // applies dark class on html early
import { setupSettings } from "./settings-modal";

const app = document.querySelector<HTMLDivElement>("#app")!;

document.title = t("header.title");

app.innerHTML = `
  <div class="relative h-full w-full overflow-hidden">
    <div id="map" class="absolute inset-0"></div>

    <header class="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center px-4 pt-4 sm:justify-start sm:pl-6">
      <div class="pointer-events-auto flex items-center gap-2 rounded-full bg-white/90 px-4 py-2 shadow-lg ring-1 ring-black/5 backdrop-blur dark:bg-slate-800/90 dark:ring-white/10">
        <span class="inline-flex h-7 w-7 items-center justify-center rounded-full bg-sky-500 text-white">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
            <path d="M12 21s-7-6.4-7-12a7 7 0 1 1 14 0c0 5.6-7 12-7 12Z"/>
            <circle cx="12" cy="9" r="2.5"/>
          </svg>
        </span>
        <span class="text-sm font-semibold tracking-tight text-slate-800 dark:text-slate-100">tarif.ist</span>
        <span class="hidden text-xs text-slate-500 sm:inline dark:text-slate-400">${t("header.subtitle")}</span>
      </div>
    </header>

    <!-- Top-center search bar -->
    <div id="search-root" class="pointer-events-none absolute left-1/2 top-16 z-20 flex w-full max-w-md -translate-x-1/2 px-4 sm:top-5"></div>

    <!-- Plan panel container -->
    <section id="plan-panel-root" class="absolute inset-x-0 bottom-0 z-10 px-4 pb-4 sm:inset-y-0 sm:right-auto sm:left-6 sm:flex sm:items-center sm:px-0 sm:pb-0"></section>
  </div>
`;

setupSettings();

const mapContainer = document.querySelector<HTMLDivElement>("#map")!;
const map = createMap(mapContainer);

// --- Shared state -----------------------------------------------------------

let graph: TransitGraph | null = null;
let linesLayer: L.GeoJSON | null = null;
let disruptionLayer: DisruptionLayer | null = null;
let bus: BusController | null = null;
let railStations: RailStationsLayer | null = null;
let busStops: BusStopsLayer | null = null;
let railItems: RailItem[] = [];

// --- Selection orchestration ------------------------------------------------
// When a line is selected we hide every other line's stops/stations so the
// map shows just that line in isolation.

function selectRailLine(code: string | null): void {
  bus?.clear();
  busStops?.setStopFilter(null);
  busStops?.setHidden(code !== null);
  railStations?.setStationKeyFilter(null);
  railStations?.setHidden(false);
  railStations?.setLineFilter(code);
  lineInspector.selectLine(code);
  searchBar.setLabel(code ?? "");
}

async function selectBusLine(entry: { code: string }, show: () => Promise<{ stopIds: Set<string> } | null>): Promise<void> {
  // Hide rail entirely while we're focused on a bus route.
  railStations?.setStationKeyFilter(null);
  railStations?.setHidden(true);
  lineInspector.selectLine(null);
  busStops?.setHidden(false);
  // Pre-clear so the global layer doesn't briefly show every stop on top of
  // the route shape.
  busStops?.setStopFilter(new Set());
  searchBar.setLabel(entry.code);
  const handle = await show();
  if (handle) busStops?.setStopFilter(handle.stopIds);
  else busStops?.setStopFilter(null);
}

function clearSelection(): void {
  bus?.clear();
  railStations?.setHidden(false);
  railStations?.setLineFilter(null);
  railStations?.setStationKeyFilter(null);
  busStops?.setHidden(false);
  busStops?.setStopFilter(null);
  lineInspector.selectLine(null);
}

/**
 * Highlight only the stations/stops actually visited by a single itinerary
 * leg — no full line/route geometry. The route polyline drawn by route-render
 * stays on the map either way.
 */
function showRouteLeg(
  kind: "rail" | "bus",
  stations: { id: string; lineCode: string; name: string }[]
): void {
  bus?.clear();
  lineInspector.selectLine(null);
  if (kind === "rail") {
    busStops?.setStopFilter(null);
    busStops?.setHidden(true);
    railStations?.setLineFilter(null);
    railStations?.setHidden(false);
    const keys = new Set(
      stations.map((s) => railStationKey(s.lineCode, s.name))
    );
    railStations?.setStationKeyFilter(keys);
  } else {
    railStations?.setStationKeyFilter(null);
    railStations?.setHidden(true);
    busStops?.setHidden(false);
    const stopIds = new Set(
      stations.map((s) => s.id.replace(/^bus#/, ""))
    );
    busStops?.setStopFilter(stopIds);
  }
  searchBar.setLabel("");
}

// --- Line inspector (rail filter only — no DOM) ----------------------------

const lineInspector = setupLineInspector({
  map,
  getLinesLayer: () => linesLayer,
  getGraph: () => graph,
  onLineChange: (code) => disruptionLayer?.setVisibleLine(code),
});

// --- Routing UI: editor vs read-only viewer --------------------------------
// A shared link (?r=encoded full route, or the older ?s & ?e endpoint pair)
// launches the read-only viewer instead of the editable plan-panel.

const planPanelRoot = document.querySelector<HTMLElement>("#plan-panel-root")!;
const sharedRouteParams = readSharedRouteParams();

const planRoute = async (
  start: { lat: number; lng: number },
  end: { lat: number; lng: number }
) => {
  if (!graph) return null;
  const route = findRoute(graph, start, end);
  if (!route) return null;
  return renderRoute(map, graph, route);
};

if (!sharedRouteParams) {
  void setupPlanPanel({
    container: planPanelRoot,
    map,
    planRoute,
    onLegSelect: (_code, kind, stationKeys) => {
      showRouteLeg(kind, stationKeys);
    },
    onClear: () => clearSelection(),
  });
}

interface SharedParams {
  /** Decoded once the graph is loaded; null when ?r is absent or invalid. */
  encoded?: string;
  start: { lat: number; lng: number };
  end: { lat: number; lng: number };
}

function readSharedRouteParams(): SharedParams | null {
  const params = new URLSearchParams(location.search);
  const encoded = params.get("r");
  if (encoded) {
    // Coordinates are inside the encoded blob — decoding waits for the graph,
    // but we still need start/end coords to mount the viewer immediately.
    // Peek at the JSON without graph lookups to grab start/end.
    const peek = peekShareEndpoints(encoded);
    if (peek) {
      return { encoded, start: peek.s, end: peek.e };
    }
  }
  const s = parseCoordParam(params.get("s"));
  const e = parseCoordParam(params.get("e"));
  if (s && e) return { start: s, end: e };
  return null;
}

function peekShareEndpoints(
  encoded: string
): { s: { lat: number; lng: number }; e: { lat: number; lng: number } } | null {
  try {
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(padded + "===".slice((padded.length + 3) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const obj = JSON.parse(new TextDecoder("utf-8").decode(bytes));
    if (
      obj &&
      Array.isArray(obj.s) &&
      Array.isArray(obj.e) &&
      obj.s.length === 2 &&
      obj.e.length === 2
    ) {
      return {
        s: { lat: obj.s[0], lng: obj.s[1] },
        e: { lat: obj.e[0], lng: obj.e[1] },
      };
    }
  } catch {
    // fall through
  }
  return null;
}

function parseCoordParam(raw: string | null): { lat: number; lng: number } | null {
  if (!raw) return null;
  const parts = raw.split(",");
  if (parts.length !== 2) return null;
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

// --- Search bar -------------------------------------------------------------

const searchBar = setupSearchBar({
  container: document.querySelector<HTMLElement>("#search-root")!,
  getItems: () => {
    const busItems: SearchItem[] = bus
      ? bus.getIndex().map((entry) => ({ kind: "bus", entry }))
      : [];
    return [...railItems, ...busItems];
  },
  onSelect: (item) => {
    if (item.kind === "rail") {
      selectRailLine(item.code);
    } else {
      const entry = item.entry;
      void selectBusLine(entry, () => bus?.show(entry) ?? Promise.resolve(null));
    }
  },
  onClear: () => clearSelection(),
});

// --- Bootstrap --------------------------------------------------------------

// Disruptions are decorative; load them in the background and apply when (or
// if) they arrive. Folding them into the critical-path Promise.all stalls
// the whole boot when the Metro İstanbul API hangs.
const disruptionsPromise = loadDisruptions();

Promise.all([
  loadTransitData(),
  setupBus(map),
  setupBusStopsLayer(map),
  loadBusSegments(),
])
  .then(([data, busCtrl, busStopsCtrl, busSegments]) => {
    const layers = addTransitLayers(map, data);
    linesLayer = layers.lines;
    railStations = layers.stations;
    graph = buildGraph(data, busSegments);
    bus = busCtrl;
    busStops = busStopsCtrl;

    // No rail line selected by default — lines stay hidden, stations + bus
    // stops are visible (zoom-gated inside their respective layers).
    clearSelection();

    railItems = uniqueLineCodes(linesLayer).map((code) => ({
      kind: "rail",
      code,
      name: lineNameFor(code, data),
    }));

    void disruptionsPromise.then((disruptions) => {
      if (!disruptions.length || !graph) return;
      disruptionLayer = renderDisruptions(map, graph, disruptions);
      disruptionLayer.setVisibleLine(null);
    });

    searchBar.refresh();

    if (sharedRouteParams) {
      const prebuilt = sharedRouteParams.encoded
        ? tryDecodeShareRoute(sharedRouteParams.encoded, graph)
        : null;
      const viewerPlanRoute: typeof planRoute = prebuilt
        ? async () => renderRoute(map, graph!, prebuilt.route)
        : planRoute;
      setupRouteViewer({
        container: planPanelRoot,
        map,
        start: sharedRouteParams.start,
        end: sharedRouteParams.end,
        planRoute: viewerPlanRoute,
        onLegSelect: (_code, kind, stationKeys) => {
          showRouteLeg(kind, stationKeys);
        },
        onExit: () => {
          // Drop the share params and reload into the editable panel.
          location.assign(location.pathname + location.hash);
        },
      });
    }

    console.info(
      `transit graph: ${graph.nodes.size} nodes · ${
        [...graph.edges.values()].reduce((n, arr) => n + arr.length, 0) / 2
      } edges · ${railItems.length} rail lines · ${bus.getIndex().length} bus lines`
    );
  })
  .catch((err) => {
    console.error("failed to load transit data", err);
  });

async function loadBusSegments(): Promise<BusSegmentData | null> {
  try {
    const res = await fetch("/data/bus/segments.json");
    if (!res.ok) {
      console.warn(`bus segments not available (HTTP ${res.status})`);
      return null;
    }
    return (await res.json()) as BusSegmentData;
  } catch (err) {
    console.warn("failed to load bus segments", err);
    return null;
  }
}

function lineNameFor(
  code: string,
  data: { lines: { features: Array<{ properties: { lineCode: string | null; name: string; shortName: string } }> } }
): string {
  for (const f of data.lines.features) {
    if (f.properties.lineCode === code) {
      return f.properties.shortName || f.properties.name || code;
    }
  }
  return code;
}
