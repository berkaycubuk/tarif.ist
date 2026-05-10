// Top-center search bar that lets the user pick a single rail or bus line.
// Behaves like a combobox: text input + dropdown of matching items, keyboard-
// navigable, click or Enter to select. Selecting a result tells the host to
// either filter the rail layers (line-inspector) or render a bus route (bus
// controller) — but not both at once. A "Clear" affordance returns the map to
// the initial empty state.

import { colorForLine } from "./transit";
import type { BusIndexEntry } from "./bus";
import { t } from "./i18n";

export type RailItem = { kind: "rail"; code: string; name: string };
export type BusItem = { kind: "bus"; entry: BusIndexEntry };
export type SearchItem = RailItem | BusItem;

export interface SearchBarOptions {
  container: HTMLElement;
  /** Async because the bus index loads after construction. */
  getItems: () => SearchItem[];
  onSelect: (item: SearchItem) => void;
  onClear: () => void;
}

export interface SearchBar {
  /** Force re-render of dropdown contents (e.g., once bus index has loaded). */
  refresh(): void;
  /** Programmatically set the input label. */
  setLabel(label: string): void;
  destroy(): void;
}

const MAX_RESULTS = 30;

export function setupSearchBar({
  container,
  getItems,
  onSelect,
  onClear,
}: SearchBarOptions): SearchBar {
  container.innerHTML = `
    <div class="pointer-events-auto w-full max-w-md">
      <div id="searchbar-shell" class="relative">
        <div class="flex items-center gap-2 rounded-full bg-white/95 pl-4 pr-2 py-2 shadow-lg ring-1 ring-black/5 backdrop-blur focus-within:ring-2 focus-within:ring-sky-500/60 dark:bg-slate-800/95 dark:ring-white/10">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500">
            <circle cx="11" cy="11" r="7"/>
            <path d="m21 21-4.3-4.3"/>
          </svg>
          <input
            id="searchbar-input"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="${t("search.placeholder")}"
            class="flex-1 bg-transparent text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none dark:text-slate-100 dark:placeholder:text-slate-500"
          />
          <button
            id="searchbar-clear"
            type="button"
            class="hidden inline-flex h-7 w-7 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-700 dark:hover:text-slate-200"
            aria-label="${t("search.clear")}"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
              <path d="M18 6 6 18"/>
              <path d="m6 6 12 12"/>
            </svg>
          </button>
        </div>
        <div id="searchbar-dropdown" class="absolute left-0 right-0 top-[calc(100%+6px)] z-20 hidden max-h-[60vh] overflow-y-auto rounded-2xl bg-white/98 shadow-xl ring-1 ring-black/5 backdrop-blur dark:bg-slate-800/98 dark:ring-white/10"></div>
      </div>
    </div>
  `;

  const input = container.querySelector<HTMLInputElement>("#searchbar-input")!;
  const dropdown = container.querySelector<HTMLDivElement>(
    "#searchbar-dropdown"
  )!;
  const clearBtn = container.querySelector<HTMLButtonElement>(
    "#searchbar-clear"
  )!;

  let activeIndex = -1;
  let lastResults: SearchItem[] = [];
  let hasSelection = false;

  function setLabel(label: string): void {
    input.value = label;
    clearBtn.classList.toggle("hidden", !label);
  }

  function clearSelection(): void {
    setLabel("");
    hasSelection = false;
    onClear();
    input.focus();
    renderResults(input.value);
  }

  clearBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    clearSelection();
  });

  function score(query: string, item: SearchItem): number {
    const q = query.trim().toLowerCase();
    if (!q) return 1;
    const code =
      item.kind === "rail" ? item.code.toLowerCase() : item.entry.code.toLowerCase();
    const name =
      item.kind === "rail" ? item.name.toLowerCase() : item.entry.longName.toLowerCase();

    if (code === q) return 1000;
    if (code.startsWith(q)) return 500 - code.length;
    if (code.includes(q)) return 200 - code.length;
    if (name.startsWith(q)) return 100 - name.length;
    if (name.includes(q)) return 50 - name.length;
    return -1;
  }

  function searchItems(query: string): SearchItem[] {
    const items = getItems();
    if (!query.trim()) {
      return items.slice(0, MAX_RESULTS);
    }
    const scored: Array<{ s: number; item: SearchItem }> = [];
    for (const item of items) {
      const s = score(query, item);
      if (s >= 0) scored.push({ s, item });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, MAX_RESULTS).map((x) => x.item);
  }

  function renderResults(query: string): void {
    const results = searchItems(query);
    lastResults = results;
    activeIndex = results.length ? 0 : -1;

    if (!results.length) {
      dropdown.innerHTML = `
        <div class="px-4 py-3 text-xs text-slate-500">${t("search.noMatches")}</div>
      `;
    } else {
      const html: string[] = [];
      for (let i = 0; i < results.length; i++) {
        html.push(renderRow(results[i], i));
      }
      dropdown.innerHTML = html.join("");
    }
    dropdown.classList.remove("hidden");
    updateActiveStyling();

    dropdown.querySelectorAll<HTMLButtonElement>("[data-idx]").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => {
        // mousedown so input blur doesn't close the dropdown first.
        e.preventDefault();
      });
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        const item = lastResults[idx];
        if (item) commit(item);
      });
      btn.addEventListener("mouseenter", () => {
        const idx = Number(btn.dataset.idx);
        if (Number.isFinite(idx)) {
          activeIndex = idx;
          updateActiveStyling();
        }
      });
    });
  }

  function renderRow(item: SearchItem, idx: number): string {
    if (item.kind === "rail") {
      const color = colorForLine(item.code);
      return `
        <button data-idx="${idx}" type="button"
                class="search-row flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-700">
          <span class="inline-flex h-7 min-w-[44px] items-center justify-center rounded-md px-2 text-xs font-bold text-white" style="background:${color}">${escapeHtml(item.code)}</span>
          <span class="flex-1 truncate text-slate-700 dark:text-slate-200">${escapeHtml(item.name)}</span>
          <span class="text-[10px] uppercase tracking-wide text-slate-400">${t("search.tag.rail")}</span>
        </button>
      `;
    }
    const e = item.entry;
    return `
      <button data-idx="${idx}" type="button"
              class="search-row flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-700">
        <span class="inline-flex h-7 min-w-[44px] items-center justify-center rounded-md bg-orange-500 px-2 text-xs font-bold text-white">${escapeHtml(e.code)}</span>
        <span class="flex-1 truncate text-slate-700 dark:text-slate-200">${escapeHtml(e.longName)}</span>
        <span class="text-[10px] uppercase tracking-wide text-slate-400">${t("search.tag.bus")}</span>
      </button>
    `;
  }

  function updateActiveStyling(): void {
    dropdown.querySelectorAll<HTMLElement>("[data-idx]").forEach((el) => {
      const idx = Number(el.dataset.idx);
      if (idx === activeIndex) {
        el.classList.add("bg-slate-100", "dark:bg-slate-700");
      } else {
        el.classList.remove("bg-slate-100", "dark:bg-slate-700");
      }
    });
  }

  function commit(item: SearchItem): void {
    const label =
      item.kind === "rail"
        ? `${item.code} · ${item.name}`
        : `${item.entry.code} · ${item.entry.longName}`;
    setLabel(label);
    hasSelection = true;
    closeDropdown();
    input.blur();
    onSelect(item);
  }

  function closeDropdown(): void {
    dropdown.classList.add("hidden");
  }

  input.addEventListener("focus", () => {
    if (hasSelection) input.select();
    renderResults(input.value);
  });

  input.addEventListener("input", () => {
    hasSelection = false;
    clearBtn.classList.toggle("hidden", !input.value);
    renderResults(input.value);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (lastResults.length) {
        activeIndex = (activeIndex + 1) % lastResults.length;
        updateActiveStyling();
        scrollActiveIntoView();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (lastResults.length) {
        activeIndex =
          (activeIndex - 1 + lastResults.length) % lastResults.length;
        updateActiveStyling();
        scrollActiveIntoView();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = lastResults[activeIndex];
      if (item) commit(item);
    } else if (e.key === "Escape") {
      if (!dropdown.classList.contains("hidden")) {
        closeDropdown();
      } else if (input.value) {
        clearSelection();
      } else {
        input.blur();
      }
    }
  });

  function scrollActiveIntoView(): void {
    const el = dropdown.querySelector<HTMLElement>(
      `[data-idx="${activeIndex}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }

  // Close dropdown when focus leaves the search bar entirely.
  document.addEventListener("mousedown", (e) => {
    if (!container.contains(e.target as Node)) {
      closeDropdown();
    }
  });

  return {
    refresh() {
      if (document.activeElement === input) {
        renderResults(input.value);
      }
    },
    setLabel,
    destroy() {
      container.innerHTML = "";
    },
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
