import "./style.css";
import L from "leaflet";
import { createMap } from "./map";
import {
  addTransitLayers,
  loadTransitData,
  uniqueLineCodes,
} from "./transit";
import { buildGraph, type TransitGraph } from "./graph";
import { findRoute } from "./router";
import { renderRoute } from "./route-render";
import { setupLineInspector } from "./line-inspector";
import { setupPlanPanel } from "./plan-panel";
import {
  loadDisruptions,
  renderDisruptions,
  type DisruptionLayer,
} from "./disruptions";
import { setupBus, type BusController } from "./bus";
import {
  setupSearchBar,
  type SearchItem,
  type RailItem,
} from "./search-bar";

const app = document.querySelector<HTMLDivElement>("#app")!;

app.innerHTML = `
  <div class="relative h-full w-full overflow-hidden">
    <div id="map" class="absolute inset-0"></div>

    <header class="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center px-4 pt-4 sm:justify-start sm:pl-6">
      <div class="pointer-events-auto flex items-center gap-2 rounded-full bg-white/90 px-4 py-2 shadow-lg ring-1 ring-black/5 backdrop-blur">
        <span class="inline-flex h-7 w-7 items-center justify-center rounded-full bg-sky-500 text-white">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
            <path d="M12 21s-7-6.4-7-12a7 7 0 1 1 14 0c0 5.6-7 12-7 12Z"/>
            <circle cx="12" cy="9" r="2.5"/>
          </svg>
        </span>
        <span class="text-sm font-semibold tracking-tight text-slate-800">İstGoto</span>
        <span class="hidden text-xs text-slate-500 sm:inline">Istanbul route planner</span>
      </div>
    </header>

    <!-- Top-center search bar -->
    <div id="search-root" class="pointer-events-none absolute left-1/2 top-16 z-20 flex w-full max-w-md -translate-x-1/2 px-4 sm:top-5"></div>

    <!-- Plan panel container -->
    <section id="plan-panel-root" class="absolute inset-x-0 bottom-0 z-10 px-4 pb-4 sm:inset-y-0 sm:right-auto sm:left-6 sm:flex sm:items-center sm:px-0 sm:pb-0"></section>
  </div>
`;

const mapContainer = document.querySelector<HTMLDivElement>("#map")!;
const map = createMap(mapContainer);

// --- Shared state -----------------------------------------------------------

let graph: TransitGraph | null = null;
let linesLayer: L.GeoJSON | null = null;
let stationsLayer: L.GeoJSON | null = null;
let disruptionLayer: DisruptionLayer | null = null;
let bus: BusController | null = null;
let railItems: RailItem[] = [];

// --- Line inspector (rail filter only — no DOM) ----------------------------

const lineInspector = setupLineInspector({
  map,
  getLinesLayer: () => linesLayer,
  getStationsLayer: () => stationsLayer,
  getGraph: () => graph,
  onLineChange: (code) => disruptionLayer?.setVisibleLine(code),
});

// --- Plan panel -------------------------------------------------------------

void setupPlanPanel({
  container: document.querySelector<HTMLElement>("#plan-panel-root")!,
  map,
  planRoute: async (start, end) => {
    if (!graph) return null;
    const route = findRoute(graph, start, end);
    if (!route) return null;
    return renderRoute(map, graph, route);
  },
  onLineSelect: (code) => {
    bus?.clear();
    lineInspector.selectLine(code);
    searchBar.setLabel(code);
  },
});

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
      bus?.clear();
      lineInspector.selectLine(item.code);
    } else {
      lineInspector.selectLine(null);
      void bus?.show(item.entry);
    }
  },
  onClear: () => {
    bus?.clear();
    lineInspector.selectLine(null);
  },
});

// --- Bootstrap --------------------------------------------------------------

Promise.all([loadTransitData(), loadDisruptions(), setupBus(map)])
  .then(([data, disruptions, busCtrl]) => {
    const layers = addTransitLayers(map, data);
    linesLayer = layers.lines;
    stationsLayer = layers.stations;
    graph = buildGraph(data);
    bus = busCtrl;

    // Map starts empty — hide the rail layers until the user picks one.
    lineInspector.selectLine(null);

    railItems = uniqueLineCodes(linesLayer).map((code) => ({
      kind: "rail",
      code,
      name: lineNameFor(code, data),
    }));

    if (disruptions.length) {
      disruptionLayer = renderDisruptions(map, graph, disruptions);
      disruptionLayer.setVisibleLine(null);
    }

    searchBar.refresh();

    console.info(
      `transit graph: ${graph.nodes.size} nodes · ${
        [...graph.edges.values()].reduce((n, arr) => n + arr.length, 0) / 2
      } edges · ${railItems.length} rail lines · ${bus.getIndex().length} bus lines`
    );
  })
  .catch((err) => {
    console.error("failed to load transit data", err);
  });

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
