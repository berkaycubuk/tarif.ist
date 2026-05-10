// Minimal two-language i18n. Turkish is default; English is opt-in.
// We reload on language change rather than re-rendering every panel — most
// UI is built once via innerHTML and untangling that for live swap is far
// more work than a one-time `location.reload()`.

export type Lang = "tr" | "en";

const STORAGE_KEY = "tarif-ist:lang";

type Entry = { tr: string; en: string };

const dict = {
  // --- Header / branding ----------------------------------------------------
  "header.subtitle": {
    tr: "İstanbul ulaşım planlayıcı",
    en: "Istanbul route planner",
  },
  "header.title": {
    tr: "tarif.ist · İstanbul Ulaşım Planlayıcı",
    en: "tarif.ist · Istanbul Route Planner",
  },

  // --- Search bar -----------------------------------------------------------
  "search.placeholder": {
    tr: "Otobüs veya metro hattı ara…",
    en: "Search bus or metro line…",
  },
  "search.clear": { tr: "Temizle", en: "Clear" },
  "search.noMatches": {
    tr: "Eşleşen hat yok.",
    en: "No matching lines.",
  },
  "search.tag.rail": { tr: "Raylı", en: "Rail" },
  "search.tag.bus": { tr: "Otobüs", en: "Bus" },

  // --- Place autocomplete ---------------------------------------------------
  "auto.searching": { tr: "Aranıyor…", en: "Searching…" },
  "auto.noMatches": {
    tr: "İstanbul'da eşleşme yok.",
    en: "No matches in Istanbul.",
  },
  "auto.error": {
    tr: "Arama başarısız. Tekrar deneyin.",
    en: "Search failed. Try again.",
  },

  // --- Plan panel -----------------------------------------------------------
  "plan.heading": { tr: "Rotanı planla", en: "Plan your route" },
  "plan.hint": {
    tr: "Arayın veya haritaya sağ tıklayarak nokta bırakın.",
    en: "Search, or right-click the map to drop a pin.",
  },
  "plan.start.placeholder": { tr: "Başlangıç", en: "Start location" },
  "plan.end.placeholder": { tr: "Varış", en: "Destination" },
  "plan.swap": {
    tr: "Başlangıç ve varışı değiştir",
    en: "Swap start and destination",
  },
  "plan.button": { tr: "Rota planla", en: "Plan route" },
  "plan.clear": { tr: "Temizle", en: "Clear" },
  "plan.share": { tr: "Paylaş", en: "Share" },
  "plan.share.copied": { tr: "Kopyalandı", en: "Copied" },
  "plan.share.empty": {
    tr: "Önce başlangıç ve varış seçin.",
    en: "Pick a start and a destination first.",
  },

  // --- Shared route viewer --------------------------------------------------
  "viewer.title": { tr: "Paylaşılan rota", en: "Shared route" },
  "viewer.from": { tr: "Başlangıç", en: "From" },
  "viewer.to": { tr: "Varış", en: "To" },
  "viewer.exit": {
    tr: "Kendi rotanı planla",
    en: "Plan your own route",
  },
  "viewer.loading": { tr: "Rota yükleniyor…", en: "Loading route…" },
  "plan.pickEnds": {
    tr: "Rota planlamak için önerilerden başlangıç <em>ve</em> varış seçin.",
    en: "Pick a start <em>and</em> a destination from the suggestions to plan a route.",
  },
  "plan.finding": { tr: "Rota aranıyor…", en: "Finding your route…" },
  "plan.noRoute": { tr: "Rota bulunamadı", en: "No route found" },
  "plan.noRouteHint": {
    tr: "Başlangıç veya varış noktanız aktif bir raylı istasyondan çok uzak ve tüm yolu yürümek mantıklı değil. Daha yakın bir nokta seçin.",
    en: "Either start or end is too far from any operational rail station, and walking the whole way isn't reasonable. Try a closer point.",
  },
  "plan.error": {
    tr: "Bir şeyler ters gitti. Tekrar deneyin.",
    en: "Something went wrong. Try again.",
  },
  "plan.footer.transitData": { tr: "Ulaşım verileri", en: "Transit data" },
  "plan.footer.map": {
    tr: "Harita: OpenStreetMap & CARTO",
    en: "Map: OpenStreetMap & CARTO",
  },

  // --- Settings modal -------------------------------------------------------
  "settings.open": { tr: "Ayarlar", en: "Settings" },
  "settings.close": { tr: "Kapat", en: "Close" },
  "settings.title": { tr: "Ayarlar", en: "Settings" },
  "settings.language": { tr: "Dil", en: "Language" },
  "settings.theme": { tr: "Tema", en: "Theme" },
  "settings.theme.system": { tr: "Sistem", en: "System" },
  "settings.theme.light": { tr: "Açık", en: "Light" },
  "settings.theme.dark": { tr: "Koyu", en: "Dark" },

  // --- Itinerary (route-render) --------------------------------------------
  "itin.minSuffix": { tr: "dk", en: "min" },
  "itin.walk": { tr: "yürüme", en: "walk" },
  "itin.transit": { tr: "ulaşım", en: "transit" },
  "itin.leg.walkKm": { tr: "{km} km yürü", en: "Walk {km} km" },
  "itin.leg.walkTo": {
    tr: "<strong>{place}</strong> noktasına yürü",
    en: "Walk to <strong>{place}</strong>",
  },
  "itin.leg.walkDest": { tr: "Varışa yürü", en: "Walk to destination" },
  "itin.leg.walkDestFrom": {
    tr: "<strong>{place}</strong> noktasından varışa yürü",
    en: "Walk to destination from <strong>{place}</strong>",
  },
  "itin.leg.transfer": {
    tr: "<strong>{place}</strong> aktarması",
    en: "Transfer at <strong>{place}</strong>",
  },
  "itin.leg.stop": { tr: "durak", en: "stop" },
  "itin.leg.stops": { tr: "durak", en: "stops" },
  "itin.fallback.station": { tr: "istasyon", en: "station" },
} satisfies Record<string, Entry>;

export type DictKey = keyof typeof dict;

function readInitialLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "tr" || v === "en") return v;
  } catch {
    // ignore (private mode, etc)
  }
  return "tr";
}

let currentLang: Lang = readInitialLang();

export function getLang(): Lang {
  return currentLang;
}

export function setLang(lang: Lang): void {
  if (lang === currentLang) return;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // ignore
  }
  // Reload — every panel reads its strings at render time, so a fresh load
  // is simpler than rewiring every component for live swap.
  location.reload();
}

export function t(key: DictKey, vars?: Record<string, string | number>): string {
  const entry = dict[key];
  let s = entry[currentLang];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return s;
}
