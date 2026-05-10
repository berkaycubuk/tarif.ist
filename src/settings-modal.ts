// Settings: a cog-iconed chip in the top-right that opens an overlay modal
// with language and theme selectors. Both controls apply changes
// immediately — language reloads the page (per i18n's strategy), theme
// flips the html.dark class without a reload.

import { getLang, setLang, t, type Lang } from "./i18n";
import {
  getThemePreference,
  setThemePreference,
  type ThemePreference,
} from "./theme";

export interface SettingsController {
  destroy(): void;
}

const COG_HTML = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>`;

export function setupSettings(): SettingsController {
  // --- Cog button -----------------------------------------------------------

  const button = document.createElement("button");
  button.type = "button";
  button.id = "settings-button";
  button.setAttribute("aria-label", t("settings.open"));
  button.className =
    "pointer-events-auto absolute right-4 top-4 z-20 inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/95 text-slate-600 shadow-lg ring-1 ring-black/5 backdrop-blur transition hover:text-slate-900 hover:bg-white sm:right-6 sm:top-5 dark:bg-slate-800/95 dark:text-slate-300 dark:ring-white/10 dark:hover:bg-slate-700 dark:hover:text-white";
  button.innerHTML = COG_HTML;
  document.body.appendChild(button);

  // --- Modal (lazy-built on first open) ------------------------------------

  let overlay: HTMLDivElement | null = null;

  function open(): void {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className =
      "fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 backdrop-blur-sm";
    overlay.innerHTML = renderCard();
    document.body.appendChild(overlay);
    bindCardEvents(overlay);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", onKey);
  }

  function close(): void {
    if (!overlay) return;
    document.removeEventListener("keydown", onKey);
    overlay.remove();
    overlay = null;
    button.focus();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
  }

  button.addEventListener("click", open);

  function renderCard(): string {
    const lang = getLang();
    const theme = getThemePreference();
    return `
      <div role="dialog" aria-modal="true"
           class="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-black/5 dark:bg-slate-800 dark:ring-white/10">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">${t("settings.title")}</h2>
          <button type="button" id="settings-close"
                  aria-label="${t("settings.close")}"
                  class="-mr-1 inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
              <path d="M18 6 6 18"/>
              <path d="m6 6 12 12"/>
            </svg>
          </button>
        </div>

        <div class="space-y-5">
          <section>
            <div class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              ${t("settings.language")}
            </div>
            <div class="grid grid-cols-2 gap-2" data-group="lang">
              ${segmentBtn("lang", "tr", "Türkçe", lang === "tr")}
              ${segmentBtn("lang", "en", "English", lang === "en")}
            </div>
          </section>

          <section>
            <div class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              ${t("settings.theme")}
            </div>
            <div class="grid grid-cols-3 gap-2" data-group="theme">
              ${segmentBtn("theme", "system", t("settings.theme.system"), theme === "system")}
              ${segmentBtn("theme", "light", t("settings.theme.light"), theme === "light")}
              ${segmentBtn("theme", "dark", t("settings.theme.dark"), theme === "dark")}
            </div>
          </section>
        </div>
      </div>
    `;
  }

  function bindCardEvents(root: HTMLElement): void {
    root
      .querySelector<HTMLButtonElement>("#settings-close")
      ?.addEventListener("click", close);

    root
      .querySelectorAll<HTMLButtonElement>('[data-group="lang"] button')
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const value = btn.dataset.value as Lang;
          setLang(value); // reloads the page
        });
      });

    root
      .querySelectorAll<HTMLButtonElement>('[data-group="theme"] button')
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const value = btn.dataset.value as ThemePreference;
          setThemePreference(value);
          // Repaint the segment selection without rebuilding the modal.
          markSelected(root, "theme", value);
        });
      });
  }

  return {
    destroy() {
      close();
      button.remove();
    },
  };
}

function segmentBtn(
  group: string,
  value: string,
  label: string,
  active: boolean
): string {
  const base =
    "rounded-lg px-3 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-sky-500/60";
  const on =
    "bg-sky-500 text-white shadow-sm dark:bg-sky-500";
  const off =
    "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600";
  return `<button type="button" data-group-btn="${group}" data-value="${value}"
                  class="${base} ${active ? on : off}">${label}</button>`;
}

function markSelected(root: HTMLElement, group: string, value: string): void {
  root
    .querySelectorAll<HTMLButtonElement>(`[data-group="${group}"] button`)
    .forEach((btn) => {
      const isOn = btn.dataset.value === value;
      btn.className = btn.className
        .replace(/\bbg-sky-500\b/g, "")
        .replace(/\btext-white\b/g, "")
        .replace(/\bshadow-sm\b/g, "")
        .replace(/\bbg-slate-100\b/g, "")
        .replace(/\bbg-slate-700\b/g, "")
        .replace(/\btext-slate-700\b/g, "")
        .replace(/\btext-slate-200\b/g, "")
        .replace(/\bhover:bg-slate-200\b/g, "")
        .replace(/\bhover:bg-slate-600\b/g, "")
        .trim();
      btn.className +=
        " " +
        (isOn
          ? "bg-sky-500 text-white shadow-sm dark:bg-sky-500"
          : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600");
    });
}
