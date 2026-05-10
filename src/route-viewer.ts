// Read-only "shared route" panel mounted in place of the editable plan-panel
// when the URL carries ?s=lat,lng&e=lat,lng. Renders the same itinerary HTML
// so it stays consistent with the editing experience, but exposes no inputs,
// no plan/clear/share controls — just the route and an exit affordance back
// to the editor.
//
// Reuses the host's planRoute callback so the routing engine and map drawing
// are identical to the editable case.

import L from "leaflet";
import { reverseGeocode, type Place } from "./geocode";
import { makeEndpointMarker } from "./map";
import type { RenderedRoute } from "./route-render";
import { t } from "./i18n";

export interface RouteViewerOptions {
  container: HTMLElement;
  map: L.Map;
  start: { lat: number; lng: number };
  end: { lat: number; lng: number };
  planRoute: (start: Place, end: Place) => Promise<RenderedRoute | null>;
  onLegSelect?: (
    code: string,
    kind: "rail" | "bus",
    stationKeys: { id: string; lineCode: string; name: string }[]
  ) => void;
  /** Called when the viewer exits (user clicks "Plan your own route"). */
  onExit?: () => void;
}

export interface RouteViewer {
  destroy(): void;
}

function placeFromLatLng(lat: number, lng: number, kind: "start" | "end"): Place {
  const coordLabel = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  return {
    id: `viewer-${kind}-${Date.now()}`,
    name: coordLabel,
    fullName: coordLabel,
    lat,
    lng,
  };
}

export function setupRouteViewer({
  container,
  map,
  start,
  end,
  planRoute,
  onLegSelect,
  onExit,
}: RouteViewerOptions): RouteViewer {
  container.innerHTML = `
    <div class="mx-auto w-full max-w-md sm:mx-0 sm:w-[380px]">
      <div class="rounded-2xl bg-white/95 p-4 shadow-xl ring-1 ring-black/5 backdrop-blur dark:bg-slate-800/95 dark:ring-white/10">
        <div class="mb-3 flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-[10px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400">
              ${t("viewer.title")}
            </div>
            <h1 class="mt-0.5 text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">
              <span id="viewer-from-label" class="text-slate-700 dark:text-slate-200">…</span>
              <span class="text-slate-400 dark:text-slate-500"> → </span>
              <span id="viewer-to-label" class="text-slate-700 dark:text-slate-200">…</span>
            </h1>
          </div>
        </div>

        <div class="space-y-1.5 rounded-xl ring-1 ring-slate-200 px-3 py-2 dark:ring-slate-700">
          <div class="flex items-center gap-2 text-xs">
            <span class="inline-block h-3 w-3 shrink-0 rounded-full bg-emerald-500 ring-4 ring-emerald-500/15"></span>
            <span class="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200" id="viewer-from-line">…</span>
          </div>
          <div class="flex items-center gap-2 text-xs">
            <span class="inline-block h-3 w-3 shrink-0 rounded-sm bg-rose-500 ring-4 ring-rose-500/15"></span>
            <span class="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200" id="viewer-to-line">…</span>
          </div>
        </div>

        <div id="viewer-results" class="mt-3 rounded-xl bg-slate-50 p-3 text-xs text-slate-600 ring-1 ring-slate-200 dark:bg-slate-900/40 dark:text-slate-300 dark:ring-slate-700">
          <div class="text-[11px] text-slate-500 dark:text-slate-400">${t("viewer.loading")}</div>
        </div>

        <button
          id="viewer-exit"
          type="button"
          class="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
            <path d="M12 5v14"/>
            <path d="M5 12h14"/>
          </svg>
          ${t("viewer.exit")}
        </button>
      </div>

      <p class="mt-2 text-center text-[11px] text-slate-500 sm:text-left dark:text-slate-500">
        ${t("plan.footer.transitData")}: <a href="https://data.ibb.gov.tr" target="_blank" rel="noreferrer" class="underline hover:text-slate-700">İBB Açık Veri Portalı</a> · ${t("plan.footer.map")}
      </p>
    </div>
  `;

  const fromLabel = container.querySelector<HTMLElement>("#viewer-from-label")!;
  const toLabel = container.querySelector<HTMLElement>("#viewer-to-label")!;
  const fromLine = container.querySelector<HTMLElement>("#viewer-from-line")!;
  const toLine = container.querySelector<HTMLElement>("#viewer-to-line")!;
  const results = container.querySelector<HTMLElement>("#viewer-results")!;
  const exitBtn = container.querySelector<HTMLButtonElement>("#viewer-exit")!;

  const startPlace = placeFromLatLng(start.lat, start.lng, "start");
  const endPlace = placeFromLatLng(end.lat, end.lng, "end");

  // Drop start/end pins on the map. Read-only — no popup.
  const startMarker = makeEndpointMarker("start", [start.lat, start.lng]).addTo(map);
  const endMarker = makeEndpointMarker("end", [end.lat, end.lng]).addTo(map);

  // Set provisional labels to coords until reverse-geocode resolves.
  fromLabel.textContent = startPlace.name;
  toLabel.textContent = endPlace.name;
  fromLine.textContent = startPlace.name;
  toLine.textContent = endPlace.name;

  void Promise.all([
    reverseGeocode(start.lat, start.lng),
    reverseGeocode(end.lat, end.lng),
  ]).then(([s, e]) => {
    if (s) {
      fromLabel.textContent = s.name;
      fromLine.textContent = s.fullName ?? s.name;
    }
    if (e) {
      toLabel.textContent = e.name;
      toLine.textContent = e.fullName ?? e.name;
    }
  });

  let activeRender: RenderedRoute | null = null;

  void planRoute(startPlace, endPlace)
    .then((rendered) => {
      if (!rendered) {
        results.innerHTML = `
          <div class="font-medium text-slate-800 dark:text-slate-100">${t("plan.noRoute")}</div>
          <div class="mt-1 text-[11px] text-slate-500 dark:text-slate-400">${t("plan.noRouteHint")}</div>
        `;
        return;
      }
      activeRender = rendered;
      results.innerHTML = rendered.itineraryHtml;

      // Wire badge clicks the same way the editor does.
      if (onLegSelect) {
        results
          .querySelectorAll<HTMLElement>("[data-line-code]")
          .forEach((el) => {
            el.addEventListener("click", () => {
              const code = el.dataset.lineCode;
              const kind = (el.dataset.lineKind as "rail" | "bus") ?? "rail";
              const idx = Number(el.dataset.legIndex);
              const leg =
                Number.isFinite(idx) && activeRender
                  ? activeRender.route.legs[idx]
                  : undefined;
              if (!code || !leg || !("stations" in leg)) return;
              const stationKeys = leg.stations.map((s) => ({
                id: s.id,
                lineCode: s.lineCode,
                name: s.stationName,
              }));
              onLegSelect(code, kind, stationKeys);
            });
          });
      }
    })
    .catch((err) => {
      console.error("viewer plan route failed", err);
      results.innerHTML = `<div class="text-rose-700">${t("plan.error")}</div>`;
    });

  exitBtn.addEventListener("click", () => {
    onExit?.();
  });

  return {
    destroy() {
      if (activeRender) map.removeLayer(activeRender.layer);
      map.removeLayer(startMarker);
      map.removeLayer(endMarker);
      container.innerHTML = "";
    },
  };
}
