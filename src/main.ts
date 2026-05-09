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

    <!-- Plan panel container -->
    <section id="plan-panel-root" class="absolute inset-x-0 bottom-0 z-10 px-4 pb-4 sm:inset-y-0 sm:right-auto sm:left-6 sm:flex sm:items-center sm:px-0 sm:pb-0"></section>

    <!-- Legend container -->
    <aside id="legend-root" class="pointer-events-auto absolute right-4 top-4 z-10 hidden max-w-[200px] rounded-xl bg-white/95 p-3 text-xs shadow-lg ring-1 ring-black/5 backdrop-blur sm:block"></aside>
  </div>
`;

const mapContainer = document.querySelector<HTMLDivElement>("#map")!;
const map = createMap(mapContainer);

// --- Shared state (owned by main.ts, injected into sub-modules) --------------

let graph: TransitGraph | null = null;
let linesLayer: L.GeoJSON | null = null;
let stationsLayer: L.GeoJSON | null = null;
let disruptionLayer: DisruptionLayer | null = null;

// --- Line inspector ---------------------------------------------------------

const lineInspector = setupLineInspector({
  container: document.querySelector<HTMLElement>("#legend-root")!,
  map,
  getLinesLayer: () => linesLayer,
  getStationsLayer: () => stationsLayer,
  getGraph: () => graph,
  onLineChange: (code) => disruptionLayer?.setVisibleLine(code),
});

// --- Plan panel -------------------------------------------------------------

// Stored for potential destroy/cleanup. Referenced via closure in onLineSelect.
void setupPlanPanel({
  container: document.querySelector<HTMLElement>("#plan-panel-root")!,
  map,
  planRoute: async (start, end) => {
    if (!graph) return null;
    const route = findRoute(graph, start, end);
    if (!route) return null;
    return renderRoute(map, graph, route);
  },
  onLineSelect: (code) => lineInspector.selectLine(code),
});

// --- Bootstrap --------------------------------------------------------------

Promise.all([loadTransitData(), loadDisruptions()])
  .then(([data, disruptions]) => {
    const layers = addTransitLayers(map, data);
    linesLayer = layers.lines;
    stationsLayer = layers.stations;
    graph = buildGraph(data);
    lineInspector.setLines(uniqueLineCodes(linesLayer));
    console.info(
      `transit graph: ${graph.nodes.size} nodes, ${
        [...graph.edges.values()].reduce((n, arr) => n + arr.length, 0) / 2
      } edges`
    );

    if (disruptions.length) {
      disruptionLayer = renderDisruptions(map, graph, disruptions);
      const badges = new Map(
        [...disruptionLayer.countsByLine].map(([code, count]) => [
          code,
          { count, severity: disruptionLayer!.severityByLine.get(code)! },
        ])
      );
      lineInspector.setDisruptionBadges(badges);
      console.info(
        `disruptions: ${disruptions.length} active across ${disruptionLayer.countsByLine.size} line(s)`
      );
    }
  })
  .catch((err) => {
    console.error("failed to load transit data", err);
  });
