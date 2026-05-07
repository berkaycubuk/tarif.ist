import "./style.css";
import { createMap } from "./map";

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

    <section class="absolute inset-x-0 bottom-0 z-10 px-4 pb-4 sm:inset-y-0 sm:right-auto sm:left-6 sm:flex sm:items-center sm:px-0 sm:pb-0">
      <div class="mx-auto w-full max-w-md sm:mx-0 sm:w-[380px]">
        <div class="rounded-2xl bg-white/95 p-4 shadow-xl ring-1 ring-black/5 backdrop-blur">
          <div class="mb-3">
            <h1 class="text-lg font-semibold tracking-tight text-slate-900">Plan your route</h1>
            <p class="text-xs text-slate-500">Metro & İETT bus directions across Istanbul.</p>
          </div>

          <form id="route-form" class="space-y-2">
            <div class="relative flex items-stretch gap-2 rounded-xl ring-1 ring-slate-200 focus-within:ring-2 focus-within:ring-sky-500/60">
              <div class="flex flex-1 flex-col">
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
                <div class="ml-[26px] border-t border-dashed border-slate-200"></div>
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
          Powered by OpenStreetMap, Metro İstanbul & İETT (coming soon).
        </p>
      </div>
    </section>
  </div>
`;

const mapContainer = document.querySelector<HTMLDivElement>("#map")!;
createMap(mapContainer);

const form = document.querySelector<HTMLFormElement>("#route-form")!;
const startInput = document.querySelector<HTMLInputElement>("#start-input")!;
const endInput = document.querySelector<HTMLInputElement>("#end-input")!;
const swapBtn = document.querySelector<HTMLButtonElement>("#swap-btn")!;
const results = document.querySelector<HTMLDivElement>("#results")!;

swapBtn.addEventListener("click", () => {
  const tmp = startInput.value;
  startInput.value = endInput.value;
  endInput.value = tmp;
  startInput.focus();
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const from = startInput.value.trim();
  const to = endInput.value.trim();

  if (!from || !to) {
    results.classList.remove("hidden");
    results.textContent = "Please enter both a start location and a destination.";
    return;
  }

  results.classList.remove("hidden");
  results.innerHTML = `
    <div class="font-medium text-slate-800">Route preview</div>
    <div class="mt-1 truncate"><span class="text-emerald-600">●</span> ${escapeHtml(from)}</div>
    <div class="truncate"><span class="text-rose-600">■</span> ${escapeHtml(to)}</div>
    <div class="mt-2 text-slate-500">Routing engine arrives in phase 2.</div>
  `;
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
