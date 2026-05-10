import { searchPlaces, type Place } from "./geocode";
import { t } from "./i18n";

export interface AutocompleteController {
  destroy(): void;
  clear(): void;
  setValue(place: Place): void;
}

export interface AutocompleteOptions {
  input: HTMLInputElement;
  // Where the dropdown is appended; should be a `position: relative` ancestor
  // of the input that doesn't clip overflow.
  anchor: HTMLElement;
  onSelect: (place: Place) => void;
  onClear: () => void;
}

const DEBOUNCE_MS = 300;

export function setupAutocomplete({
  input,
  anchor,
  onSelect,
  onClear,
}: AutocompleteOptions): AutocompleteController {
  const dropdown = document.createElement("div");
  dropdown.className =
    "absolute left-0 right-0 top-full z-30 mt-1 hidden max-h-64 overflow-auto rounded-xl bg-white text-sm shadow-xl ring-1 ring-black/10 dark:bg-slate-800 dark:ring-white/10";
  dropdown.setAttribute("role", "listbox");
  anchor.appendChild(dropdown);

  let activeIndex = -1;
  let currentResults: Place[] = [];
  let abortCtrl: AbortController | null = null;
  let debounceTimer: number | undefined;
  let suppressNext = false;
  let hasSelection = false;

  function open() {
    dropdown.classList.remove("hidden");
  }
  function close() {
    dropdown.classList.add("hidden");
    activeIndex = -1;
  }
  function setLoading() {
    dropdown.innerHTML = `
      <div class="px-3 py-2 text-xs text-slate-500">${t("auto.searching")}</div>
    `;
    open();
  }
  function setEmpty() {
    dropdown.innerHTML = `
      <div class="px-3 py-2 text-xs text-slate-500">${t("auto.noMatches")}</div>
    `;
    open();
  }
  function setError() {
    dropdown.innerHTML = `
      <div class="px-3 py-2 text-xs text-rose-600">${t("auto.error")}</div>
    `;
    open();
  }

  function render(results: Place[]) {
    currentResults = results;
    activeIndex = -1;
    if (!results.length) {
      setEmpty();
      return;
    }
    dropdown.innerHTML = results
      .map(
        (p, i) => `
          <button
            type="button"
            role="option"
            data-index="${i}"
            class="block w-full cursor-pointer px-3 py-2 text-left transition hover:bg-sky-50 aria-selected:bg-sky-100 dark:hover:bg-slate-700 dark:aria-selected:bg-sky-900/40"
          >
            <div class="truncate font-medium text-slate-800 dark:text-slate-100">${escapeHtml(p.name)}</div>
            <div class="truncate text-[11px] text-slate-500 dark:text-slate-400">${escapeHtml(p.fullName)}</div>
          </button>
        `
      )
      .join("");
    open();
  }

  function highlight(idx: number) {
    const items = dropdown.querySelectorAll<HTMLButtonElement>("[role='option']");
    items.forEach((el, i) => {
      el.setAttribute("aria-selected", i === idx ? "true" : "false");
      if (i === idx) el.scrollIntoView({ block: "nearest" });
    });
    activeIndex = idx;
  }

  function pick(idx: number) {
    const place = currentResults[idx];
    if (!place) return;
    suppressNext = true;
    input.value = place.name;
    hasSelection = true;
    close();
    onSelect(place);
  }

  async function runSearch(q: string) {
    abortCtrl?.abort();
    abortCtrl = new AbortController();
    setLoading();
    try {
      const results = await searchPlaces(q, abortCtrl.signal);
      render(results);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      console.error("geocode failed", err);
      setError();
    }
  }

  function onInput() {
    if (suppressNext) {
      suppressNext = false;
      return;
    }
    if (hasSelection) {
      hasSelection = false;
      onClear();
    }
    window.clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (q.length < 2) {
      close();
      return;
    }
    debounceTimer = window.setTimeout(() => runSearch(q), DEBOUNCE_MS);
  }

  function onKeydown(e: KeyboardEvent) {
    if (dropdown.classList.contains("hidden")) {
      if (e.key === "ArrowDown" && currentResults.length) {
        open();
        highlight(0);
        e.preventDefault();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.min(currentResults.length - 1, activeIndex + 1);
      highlight(next);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(0, activeIndex - 1);
      highlight(next);
    } else if (e.key === "Enter") {
      if (activeIndex >= 0) {
        e.preventDefault();
        pick(activeIndex);
      }
    } else if (e.key === "Escape") {
      close();
    }
  }

  function onClickDropdown(e: MouseEvent) {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[role='option']");
    if (!target) return;
    const idx = Number(target.dataset.index);
    pick(idx);
  }

  function onFocus() {
    if (currentResults.length && input.value.trim().length >= 2) {
      open();
    }
  }

  function onDocClick(e: MouseEvent) {
    if (
      !anchor.contains(e.target as Node) &&
      !dropdown.contains(e.target as Node)
    ) {
      close();
    }
  }

  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeydown);
  input.addEventListener("focus", onFocus);
  dropdown.addEventListener("mousedown", (e) => e.preventDefault());
  dropdown.addEventListener("click", onClickDropdown);
  document.addEventListener("click", onDocClick);

  return {
    destroy() {
      input.removeEventListener("input", onInput);
      input.removeEventListener("keydown", onKeydown);
      input.removeEventListener("focus", onFocus);
      document.removeEventListener("click", onDocClick);
      dropdown.remove();
      abortCtrl?.abort();
    },
    clear() {
      hasSelection = false;
      currentResults = [];
      close();
    },
    setValue(place) {
      suppressNext = true;
      input.value = place.name;
      hasSelection = true;
      close();
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
