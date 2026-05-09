// Plan panel: form, endpoint state, autocomplete, route planning trigger,
// results display, and right-click context menu.
//
// Owns all the "plan your route" UI. Communicates with the outside world
// through a single async callback: planRoute(start, end) → RenderedRoute | null.

import L from "leaflet";
import { setupAutocomplete, type AutocompleteController } from "./autocomplete";
import { reverseGeocode, type Place } from "./geocode";
import { makeEndpointMarker } from "./map";
import type { RenderedRoute } from "./route-render";

export interface PlanPanelOptions {
  container: HTMLElement;
  map: L.Map;
  /** Called when the user requests a route. Returns rendered result or null. */
  planRoute: (start: Place, end: Place) => Promise<RenderedRoute | null>;
  /** Called when the user clicks a line badge in the itinerary. */
  onLineSelect?: (code: string) => void;
}

export interface PlanPanel {
  destroy(): void;
}

export function setupPlanPanel({
  container,
  map,
  planRoute,
  onLineSelect,
}: PlanPanelOptions): PlanPanel {
  // --- DOM ----------------------------------------------------------------

  container.innerHTML = `
    <div class="mx-auto w-full max-w-md sm:mx-0 sm:w-[380px]">
      <div class="rounded-2xl bg-white/95 p-4 shadow-xl ring-1 ring-black/5 backdrop-blur">
        <div class="mb-3">
          <h1 class="text-lg font-semibold tracking-tight text-slate-900">Plan your route</h1>
          <p class="text-xs text-slate-500">Search, or right-click the map to drop a pin.</p>
        </div>

        <form id="route-form" class="space-y-2">
          <div class="flex items-stretch gap-2 rounded-xl ring-1 ring-slate-200 focus-within:ring-2 focus-within:ring-sky-500/60">
            <div class="flex flex-1 flex-col">
              <div id="start-row" class="relative">
                <label class="flex items-center gap-3 px-3 pt-2 pb-1.5">
                  <span class="inline-block h-3 w-3 shrink-0 rounded-full bg-emerald-500 ring-4 ring-emerald-500/15"></span>
                  <input
                    id="start-input"
                    name="start"
                    type="text"
                    autocomplete="off"
                    placeholder="Start location"
                    class="w-full bg-transparent text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none"
                  />
                </label>
              </div>
              <div class="ml-[26px] border-t border-dashed border-slate-200"></div>
              <div id="end-row" class="relative">
                <label class="flex items-center gap-3 px-3 pt-1.5 pb-2">
                  <span class="inline-block h-3 w-3 shrink-0 rounded-sm bg-rose-500 ring-4 ring-rose-500/15"></span>
                  <input
                    id="end-input"
                    name="end"
                    type="text"
                    autocomplete="off"
                    placeholder="Destination"
                    class="w-full bg-transparent text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none"
                  />
                </label>
              </div>
            </div>
            <button
              id="swap-btn"
              type="button"
              aria-label="Swap start and destination"
              class="my-2 mr-2 inline-flex w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-700 active:scale-95"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
                <path d="M7 3v18"/>
                <path d="m3 7 4-4 4 4"/>
                <path d="M17 21V3"/>
                <path d="m21 17-4 4-4-4"/>
              </svg>
            </button>
          </div>

          <button
            id="plan-btn"
            type="submit"
            class="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-500/60 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
              <path d="M5 12h14"/>
              <path d="m13 5 7 7-7 7"/>
            </svg>
            Plan route
          </button>
        </form>

        <div id="results" class="mt-3 hidden rounded-xl bg-slate-50 p-3 text-xs text-slate-600 ring-1 ring-slate-200">
        </div>
      </div>

      <p class="mt-2 text-center text-[11px] text-slate-500 sm:text-left">
        Transit data: <a href="https://data.ibb.gov.tr" target="_blank" rel="noreferrer" class="underline hover:text-slate-700">İBB Açık Veri Portalı</a> · Map: OpenStreetMap & CARTO
      </p>
    </div>
  `;

  // --- Element references ---------------------------------------------------

  const form = container.querySelector<HTMLFormElement>("#route-form")!;
  const startInput = container.querySelector<HTMLInputElement>("#start-input")!;
  const endInput = container.querySelector<HTMLInputElement>("#end-input")!;
  const startRow = container.querySelector<HTMLDivElement>("#start-row")!;
  const endRow = container.querySelector<HTMLDivElement>("#end-row")!;
  const swapBtn = container.querySelector<HTMLButtonElement>("#swap-btn")!;
  const results = container.querySelector<HTMLDivElement>("#results")!;

  // --- State ----------------------------------------------------------------

  let startPlace: Place | null = null;
  let endPlace: Place | null = null;
  let startMarker: L.Marker | null = null;
  let endMarker: L.Marker | null = null;
  let activeRender: RenderedRoute | null = null;

  // --- Autocomplete ---------------------------------------------------------

  const startAuto = setupAutocomplete({
    input: startInput,
    anchor: startRow,
    onSelect: (place) => setEndpoint("start", place, false),
    onClear: () => {
      startPlace = null;
      clearMarker("start");
      clearRoute();
    },
  });

  const endAuto = setupAutocomplete({
    input: endInput,
    anchor: endRow,
    onSelect: (place) => setEndpoint("end", place, false),
    onClear: () => {
      endPlace = null;
      clearMarker("end");
      clearRoute();
    },
  });

  // --- Map right-click ------------------------------------------------------

  map.on("contextmenu", (e) => {
    showLocationMenu(e.latlng);
  });

  function showLocationMenu(latlng: L.LatLng): void {
    const node = document.createElement("div");
    node.className = "flex flex-col gap-1 py-1 min-w-[170px]";
    node.innerHTML = `
      <div class="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">
        ${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}
      </div>
      <button type="button" data-act="start"
        class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium text-slate-700 transition hover:bg-emerald-50 hover:text-emerald-800">
        <span class="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-emerald-500/15"></span>
        Set as start
      </button>
      <button type="button" data-act="end"
        class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium text-slate-700 transition hover:bg-rose-50 hover:text-rose-800">
        <span class="inline-block h-2.5 w-2.5 rounded-sm bg-rose-500 ring-2 ring-rose-500/15"></span>
        Set as destination
      </button>
    `;

    const popup = L.popup({
      closeButton: false,
      className: "pin-popup",
      minWidth: 180,
      autoPan: false,
    })
      .setLatLng(latlng)
      .setContent(node)
      .openOn(map);

    node
      .querySelectorAll<HTMLButtonElement>("button[data-act]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const kind = btn.dataset.act as "start" | "end";
          map.closePopup(popup);
          pickFromMap(kind, latlng);
        });
      });
  }

  async function pickFromMap(
    kind: "start" | "end",
    latlng: L.LatLng
  ): Promise<void> {
    const optimistic: Place = {
      id: `pin-${kind}-${Date.now()}`,
      name: `${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`,
      fullName: `${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`,
      lat: latlng.lat,
      lng: latlng.lng,
    };
    setEndpoint(kind, optimistic);

    const place = await reverseGeocode(latlng.lat, latlng.lng);
    if (!place) return;

    const current = kind === "start" ? startPlace : endPlace;
    if (!current || current.id !== optimistic.id) return;

    setEndpoint(kind, { ...place, lat: latlng.lat, lng: latlng.lng });
  }

  // --- Endpoint helpers -----------------------------------------------------

  function setEndpoint(
    kind: "start" | "end",
    place: Place,
    syncInput = true
  ): void {
    if (kind === "start") {
      startPlace = place;
      if (syncInput) startAuto.setValue(place);
    } else {
      endPlace = place;
      if (syncInput) endAuto.setValue(place);
    }
    setMarker(kind, place);
    clearRoute();
    fitToEndpoints();
  }

  function setMarker(kind: "start" | "end", place: Place): void {
    const latlng: L.LatLngTuple = [place.lat, place.lng];
    const existing = kind === "start" ? startMarker : endMarker;
    if (existing) {
      existing.setLatLng(latlng);
    } else {
      const m = makeEndpointMarker(kind, latlng).addTo(map);
      if (kind === "start") startMarker = m;
      else endMarker = m;
    }
  }

  function clearMarker(kind: "start" | "end"): void {
    const m = kind === "start" ? startMarker : endMarker;
    if (m) {
      map.removeLayer(m);
      if (kind === "start") startMarker = null;
      else endMarker = null;
    }
  }

  function syncMarker(
    kind: "start" | "end",
    place: Place | null,
    ctrl: AutocompleteController
  ): void {
    if (place) {
      setMarker(kind, place);
      ctrl.setValue(place);
    } else {
      clearMarker(kind);
      ctrl.clear();
    }
  }

  function fitToEndpoints(): void {
    if (startPlace && endPlace) {
      const bounds = L.latLngBounds(
        [startPlace.lat, startPlace.lng],
        [endPlace.lat, endPlace.lng]
      );
      map.fitBounds(bounds, { padding: [80, 80], maxZoom: 14 });
    } else if (startPlace) {
      map.setView([startPlace.lat, startPlace.lng], 14);
    } else if (endPlace) {
      map.setView([endPlace.lat, endPlace.lng], 14);
    }
  }

  function clearRoute(): void {
    if (activeRender) {
      map.removeLayer(activeRender.layer);
      activeRender = null;
    }
  }

  // --- Swap button ----------------------------------------------------------

  swapBtn.addEventListener("click", () => {
    const tmpVal = startInput.value;
    startInput.value = endInput.value;
    endInput.value = tmpVal;
    const tmpPlace = startPlace;
    startPlace = endPlace;
    endPlace = tmpPlace;
    syncMarker("start", startPlace, startAuto);
    syncMarker("end", endPlace, endAuto);
    fitToEndpoints();
  });

  // --- Form submit ----------------------------------------------------------

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (!startPlace || !endPlace) {
      results.classList.remove("hidden");
      results.innerHTML = `
        <div class="text-slate-700">Pick a start <em>and</em> a destination from the suggestions to plan a route.</div>
      `;
      return;
    }

    clearRoute();
    results.classList.remove("hidden");
    results.innerHTML = `<div class="text-[11px] text-slate-500">Finding your route…</div>`;

    try {
      const rendered = await planRoute(startPlace, endPlace);
      if (!rendered) {
        results.innerHTML = `
          <div class="font-medium text-slate-800">No route found</div>
          <div class="mt-1 text-[11px] text-slate-500">Either start or end is too far from any operational rail station, and walking the whole way isn't reasonable. Try a closer point.</div>
        `;
        return;
      }
      activeRender = rendered;
      results.innerHTML = rendered.itineraryHtml;

      // Wire line badge clicks to line inspector
      if (onLineSelect) {
        results.querySelectorAll<HTMLElement>("[data-line-code]").forEach(
          (el) => {
            el.addEventListener("click", () => {
              const code = el.dataset.lineCode;
              if (code) onLineSelect(code);
            });
          }
        );
      }
    } catch (err) {
      console.error("plan route failed", err);
      results.innerHTML = `<div class="text-rose-700">Something went wrong. Try again.</div>`;
    }
  });

  // --- Cleanup --------------------------------------------------------------

  return {
    destroy() {
      clearRoute();
      if (startMarker) map.removeLayer(startMarker);
      if (endMarker) map.removeLayer(endMarker);
      map.off("contextmenu");
      startAuto.destroy();
      endAuto.destroy();
      container.innerHTML = "";
    },
  };
}
