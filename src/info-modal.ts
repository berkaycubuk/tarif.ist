// Info: a small "i" chip in the top-right (just left of the settings cog) that
// opens an overlay modal with attribution and credits. Mobile-only — on sm+
// the same content lives in the panel footer below the plan/viewer card.

import { t } from "./i18n";

export interface InfoController {
  destroy(): void;
}

const INFO_HTML = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
    <circle cx="12" cy="12" r="10"/>
    <path d="M12 16v-4"/>
    <path d="M12 8h.01"/>
  </svg>`;

export function setupInfo(): InfoController {
  const button = document.createElement("button");
  button.type = "button";
  button.id = "info-button";
  button.setAttribute("aria-label", t("info.open"));
  // Sits just to the left of the settings cog (which is at right-4). The cog
  // is h-9 w-9 (36px) so we offset by ~52px to leave a small gap. Hidden on
  // sm+ where the footer below the panel already shows this info.
  button.className =
    "pointer-events-auto absolute right-[56px] top-4 z-20 inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/95 text-slate-600 shadow-lg ring-1 ring-black/5 backdrop-blur transition hover:text-slate-900 hover:bg-white sm:hidden dark:bg-slate-800/95 dark:text-slate-300 dark:ring-white/10 dark:hover:bg-slate-700 dark:hover:text-white";
  button.innerHTML = INFO_HTML;
  document.body.appendChild(button);

  let overlay: HTMLDivElement | null = null;

  function open(): void {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className =
      "fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 backdrop-blur-sm";
    overlay.innerHTML = renderCard();
    document.body.appendChild(overlay);

    overlay
      .querySelector<HTMLButtonElement>("#info-close")
      ?.addEventListener("click", close);

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
    return `
      <div role="dialog" aria-modal="true"
           class="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-black/5 dark:bg-slate-800 dark:ring-white/10">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">${t("info.title")}</h2>
          <button type="button" id="info-close"
                  aria-label="${t("settings.close")}"
                  class="-mr-1 inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
              <path d="M18 6 6 18"/>
              <path d="m6 6 12 12"/>
            </svg>
          </button>
        </div>

        <div class="space-y-4 text-sm text-slate-600 dark:text-slate-300">
          <section>
            <div class="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              ${t("plan.footer.transitData")}
            </div>
            <p>
              <a href="https://data.ibb.gov.tr" target="_blank" rel="noreferrer"
                 class="text-sky-600 underline hover:text-sky-700 dark:text-sky-400 dark:hover:text-sky-300">
                İBB Açık Veri Portalı
              </a>
            </p>
          </section>

          <section>
            <div class="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              ${t("info.mapLabel")}
            </div>
            <p>OpenStreetMap &amp; CARTO</p>
          </section>

          <section>
            <div class="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              ${t("plan.footer.builtBy")}
            </div>
            <p>
              <a href="https://berkaycubuk.com" target="_blank" rel="noreferrer"
                 class="text-sky-600 underline hover:text-sky-700 dark:text-sky-400 dark:hover:text-sky-300">
                Berkay Çubuk
              </a>
            </p>
          </section>

          <section>
            <a href="https://github.com/berkaycubuk/tarif.ist/issues" target="_blank" rel="noreferrer"
               class="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
                <path d="M12 9v4"/>
                <path d="M12 17h.01"/>
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              </svg>
              ${t("plan.footer.reportIssue")}
            </a>
          </section>
        </div>
      </div>
    `;
  }

  return {
    destroy() {
      close();
      button.remove();
    },
  };
}
