// Plan panel: form, endpoint state, autocomplete, route planning trigger,
// and results display.
//
// Owns all the "plan your route" UI. Communicates with the outside world
// through a single async callback: planRoute(start, end) → RenderedRoute | null.

import L from "leaflet";
import { setupAutocomplete, type AutocompleteController } from "./autocomplete";
import { type Place } from "./geocode";
import { makeEndpointMarker } from "./map";
import type { RenderedRoute } from "./route-render";
import { t } from "./i18n";
import { encodeShareRoute } from "./route-share";

export interface PlanPanelOptions {
  container: HTMLElement;
  map: L.Map;
  /** Called when the user requests a route. Returns rendered result or null. */
  planRoute: (start: Place, end: Place) => Promise<RenderedRoute | null>;
  /**
   * Called when the user clicks a line badge inside the itinerary. Passes the
   * leg's line code, kind, and the IDs of the stations/stops it actually
   * traverses — host typically highlights only those, not the whole line.
   */
  onLegSelect?: (
    code: string,
    kind: "rail" | "bus",
    stationKeys: { id: string; lineCode: string; name: string }[]
  ) => void;
  /**
   * Called once a route has been rendered. Host typically uses this to
   * filter the rail-station and bus-stop layers down to just the stops the
   * route visits, so the map isn't cluttered with unrelated markers.
   */
  onRouteShown?: (stations: {
    rail: { id: string; lineCode: string; name: string }[];
    bus: { id: string; lineCode: string; name: string }[];
  }) => void;
  /** Called when a previously-shown route is cleared from the map. */
  onRouteCleared?: () => void;
  /** Called after the user clears the panel (so map filters can reset). */
  onClear?: () => void;
}

export interface PlanPanel {
  destroy(): void;
}

export function setupPlanPanel({
  container,
  map,
  planRoute,
  onLegSelect,
  onRouteShown,
  onRouteCleared,
  onClear,
}: PlanPanelOptions): PlanPanel {
  // --- DOM ----------------------------------------------------------------

  container.innerHTML = `
    <div class="mx-auto w-full max-w-md sm:mx-0 sm:w-[380px]">
      <div class="rounded-2xl bg-white/95 p-4 shadow-xl ring-1 ring-black/5 backdrop-blur dark:bg-slate-800/95 dark:ring-white/10">
        <div class="mb-3 flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h1 class="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">${t("plan.heading")}</h1>
            <p class="text-xs text-slate-500 dark:text-slate-400">${t("plan.hint")}</p>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <button
              id="plan-share"
              type="button"
              class="rounded-md px-2 py-1 text-[11px] font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100"
            >${t("plan.share")}</button>
            <button
              id="plan-clear"
              type="button"
              class="rounded-md px-2 py-1 text-[11px] font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100"
            >${t("plan.clear")}</button>
          </div>
        </div>

        <form id="route-form" class="space-y-2">
          <div class="flex items-stretch gap-2 rounded-xl ring-1 ring-slate-200 focus-within:ring-2 focus-within:ring-sky-500/60 dark:ring-slate-700">
            <div class="flex flex-1 flex-col">
              <div id="start-row" class="relative">
                <label class="flex items-center gap-3 px-3 pt-2 pb-1.5">
                  <span class="inline-block h-3 w-3 shrink-0 rounded-full bg-emerald-500 ring-4 ring-emerald-500/15"></span>
                  <input
                    id="start-input"
                    name="start"
                    type="text"
                    autocomplete="off"
                    placeholder="${t("plan.start.placeholder")}"
                    class="w-full bg-transparent text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none dark:text-slate-100 dark:placeholder:text-slate-500"
                  />
                </label>
              </div>
              <div class="ml-[26px] border-t border-dashed border-slate-200 dark:border-slate-700"></div>
              <div id="end-row" class="relative">
                <label class="flex items-center gap-3 px-3 pt-1.5 pb-2">
                  <span class="inline-block h-3 w-3 shrink-0 rounded-sm bg-rose-500 ring-4 ring-rose-500/15"></span>
                  <input
                    id="end-input"
                    name="end"
                    type="text"
                    autocomplete="off"
                    placeholder="${t("plan.end.placeholder")}"
                    class="w-full bg-transparent text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none dark:text-slate-100 dark:placeholder:text-slate-500"
                  />
                </label>
              </div>
            </div>
            <button
              id="swap-btn"
              type="button"
              aria-label="${t("plan.swap")}"
              class="my-2 mr-2 inline-flex w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-700 active:scale-95 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-slate-100"
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
            ${t("plan.button")}
          </button>
        </form>

        <div id="results" class="mt-3 hidden rounded-xl bg-slate-50 p-3 text-xs text-slate-600 ring-1 ring-slate-200 dark:bg-slate-900/40 dark:text-slate-300 dark:ring-slate-700">
        </div>
      </div>

      <p class="mt-2 text-center text-[11px] text-slate-500 sm:text-left dark:text-slate-500">
        ${t("plan.footer.transitData")}: <a href="https://data.ibb.gov.tr" target="_blank" rel="noreferrer" class="underline hover:text-slate-700">İBB Açık Veri Portalı</a> · ${t("plan.footer.map")}
      </p>
      <p class="mt-1 text-center text-[11px] text-slate-500 sm:text-left dark:text-slate-500">
        ${t("plan.footer.builtBy")}: <a href="https://berkaycubuk.com" target="_blank" rel="noreferrer" class="underline hover:text-slate-700">Berkay Çubuk</a>
        · <a href="https://github.com/berkaycubuk/tarif.ist/issues" target="_blank" rel="noreferrer" class="underline hover:text-slate-700">${t("plan.footer.reportIssue")}</a>
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
  const clearBtn = container.querySelector<HTMLButtonElement>("#plan-clear")!;
  const shareBtn = container.querySelector<HTMLButtonElement>("#plan-share")!;

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

  // --- Clear button --------------------------------------------------------

  function clearAll(): void {
    startInput.value = "";
    endInput.value = "";
    startPlace = null;
    endPlace = null;
    clearMarker("start");
    clearMarker("end");
    clearRoute();
    startAuto.clear();
    endAuto.clear();
    results.classList.add("hidden");
    results.innerHTML = "";
    // Drop share params from the URL so a refresh starts clean.
    const url = new URL(location.href);
    if (
      url.searchParams.has("s") ||
      url.searchParams.has("e") ||
      url.searchParams.has("r")
    ) {
      url.searchParams.delete("s");
      url.searchParams.delete("e");
      url.searchParams.delete("r");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    onClear?.();
  }

  clearBtn.addEventListener("click", clearAll);

  // --- Share button --------------------------------------------------------

  let shareTimer: number | undefined;
  shareBtn.addEventListener("click", async () => {
    if (!startPlace || !endPlace) {
      flashShareLabel(t("plan.share.empty"), 2000);
      return;
    }
    const url = new URL(location.origin + location.pathname);
    if (activeRender) {
      // Encode the full planned route — recipient sees the same itinerary
      // verbatim, no re-routing.
      url.searchParams.set(
        "r",
        encodeShareRoute(activeRender.route, startPlace, endPlace)
      );
    } else {
      // No route planned yet — fall back to coordinates only; the recipient
      // will get whatever the router produces from those endpoints.
      url.searchParams.set(
        "s",
        `${startPlace.lat.toFixed(5)},${startPlace.lng.toFixed(5)}`
      );
      url.searchParams.set(
        "e",
        `${endPlace.lat.toFixed(5)},${endPlace.lng.toFixed(5)}`
      );
    }
    const link = url.toString();
    try {
      await navigator.clipboard.writeText(link);
      flashShareLabel(t("plan.share.copied"), 1500);
    } catch {
      // Clipboard API blocked (e.g. http://) — fall back to a prompt so the
      // user can still copy manually.
      prompt(t("plan.share"), link);
    }
  });

  function flashShareLabel(label: string, ms: number): void {
    const original = t("plan.share");
    shareBtn.textContent = label;
    if (shareTimer) clearTimeout(shareTimer);
    shareTimer = window.setTimeout(() => {
      shareBtn.textContent = original;
    }, ms);
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
      onRouteCleared?.();
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
        <div class="text-slate-700">${t("plan.pickEnds")}</div>
      `;
      return;
    }

    clearRoute();
    results.classList.remove("hidden");
    results.innerHTML = `<div class="text-[11px] text-slate-500">${t("plan.finding")}</div>`;

    try {
      const rendered = await planRoute(startPlace, endPlace);
      if (!rendered) {
        results.innerHTML = `
          <div class="font-medium text-slate-800">${t("plan.noRoute")}</div>
          <div class="mt-1 text-[11px] text-slate-500">${t("plan.noRouteHint")}</div>
        `;
        return;
      }
      activeRender = rendered;
      results.innerHTML = rendered.itineraryHtml;
      onRouteShown?.(gatherRouteStations(rendered));

      // Wire line badge clicks to per-leg highlighting.
      if (onLegSelect) {
        results.querySelectorAll<HTMLElement>("[data-line-code]").forEach(
          (el) => {
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
          }
        );
      }
    } catch (err) {
      console.error("plan route failed", err);
      results.innerHTML = `<div class="text-rose-700">${t("plan.error")}</div>`;
    }
  });

  // --- Cleanup --------------------------------------------------------------

  return {
    destroy() {
      clearRoute();
      if (startMarker) map.removeLayer(startMarker);
      if (endMarker) map.removeLayer(endMarker);
      startAuto.destroy();
      endAuto.destroy();
      container.innerHTML = "";
    },
  };
}

function gatherRouteStations(rendered: RenderedRoute): {
  rail: { id: string; lineCode: string; name: string }[];
  bus: { id: string; lineCode: string; name: string }[];
} {
  const rail: { id: string; lineCode: string; name: string }[] = [];
  const bus: { id: string; lineCode: string; name: string }[] = [];
  for (const leg of rendered.route.legs) {
    if (leg.kind === "rail") {
      for (const s of leg.stations) {
        rail.push({ id: s.id, lineCode: s.lineCode, name: s.stationName });
      }
    } else if (leg.kind === "bus") {
      for (const s of leg.stations) {
        bus.push({ id: s.id, lineCode: s.lineCode, name: s.stationName });
      }
    }
  }
  return { rail, bus };
}

