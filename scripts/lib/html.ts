// Shared shell for the prerendered pages.
//
// These are static landing pages, not the app — they ship their own small
// stylesheet rather than the Tailwind bundle so a search visitor gets a first
// paint without waiting on the map's JS. The palette tracks the app's
// theme-color (#0ea5e9) and honours prefers-color-scheme like the SPA does.

export const SITE_ORIGIN = "https://tarif.ist";
export const ANALYTICS_ID = "284047b3-906b-4a43-88c4-e63c9fea79e5";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "18 dk", "1 sa 12 dk" — matches how the app phrases durations. */
export function formatDuration(sec: number): string {
  const mins = Math.max(1, Math.round(sec / 60));
  if (mins < 60) return `${mins} dk`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} sa ${m} dk` : `${h} sa`;
}

export function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

export interface Breadcrumb {
  name: string;
  url: string;
}

export interface ShellOptions {
  lang?: "tr" | "en";
  title: string;
  description: string;
  /** Absolute path, e.g. "/hat/m2/". Used for canonical + og:url. */
  path: string;
  ogImage?: string;
  ogImageAlt?: string;
  breadcrumbs: Breadcrumb[];
  /** JSON-LD objects, emitted as application/ld+json. */
  jsonLd?: unknown[];
  body: string;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f8fafc;--panel:#fff;--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--brand:#0284c7;--brandInk:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#0b1220;--panel:#111a2e;--ink:#e2e8f0;--muted:#94a3b8;--line:#1e293b;--brand:#38bdf8;--brandInk:#04202f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
a{color:var(--brand)}
.wrap{max-width:52rem;margin:0 auto;padding:0 1rem}
header.site{border-bottom:1px solid var(--line);background:var(--panel)}
header.site .wrap{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding-block:.75rem}
.brand{font-weight:700;text-decoration:none;color:var(--ink);letter-spacing:-.02em}
.brand span{color:var(--brand)}
nav.crumbs{font-size:.8125rem;color:var(--muted);padding-block:1rem}
nav.crumbs a{color:var(--muted)}
nav.crumbs span{margin:0 .4rem}
h1{font-size:clamp(1.5rem,4vw,2rem);line-height:1.25;letter-spacing:-.02em;margin:.25rem 0 .5rem}
h2{font-size:1.125rem;letter-spacing:-.01em;margin:2.25rem 0 .75rem}
.lede{color:var(--muted);margin:0 0 1.5rem}
.pill{display:inline-flex;align-items:center;gap:.4rem;border-radius:999px;padding:.15rem .6rem;font-size:.8125rem;font-weight:600;color:#fff;text-decoration:none}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr));gap:.75rem;margin:1.5rem 0}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:.6rem;padding:.75rem}
.stat dt{font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.stat dd{margin:.15rem 0 0;font-size:1.25rem;font-weight:650;font-variant-numeric:tabular-nums}
.cta{display:inline-block;background:var(--brand);color:var(--brandInk);font-weight:650;text-decoration:none;border-radius:.55rem;padding:.6rem 1.1rem;margin:.5rem 0}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:.6rem;overflow:hidden;font-size:.9375rem}
th,td{text-align:left;padding:.55rem .75rem;border-bottom:1px solid var(--line)}
th{font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}
td.num{font-variant-numeric:tabular-nums;color:var(--muted);white-space:nowrap}
.scroll{overflow-x:auto;margin:0 -1rem;padding:0 1rem}
ul.links{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:.5rem}
ul.links a{display:inline-block;background:var(--panel);border:1px solid var(--line);border-radius:.5rem;padding:.35rem .7rem;text-decoration:none;font-size:.9375rem}
footer.site{border-top:1px solid var(--line);margin-top:3rem;padding-block:1.5rem;color:var(--muted);font-size:.875rem}
footer.site a{color:var(--muted)}
`.trim();

export function renderShell(o: ShellOptions): string {
  const lang = o.lang ?? "tr";
  const url = SITE_ORIGIN + o.path;
  const ogImage = o.ogImage ?? `${SITE_ORIGIN}/og-image.jpg`;
  const crumbs = o.breadcrumbs
    .map((c, i) =>
      i === o.breadcrumbs.length - 1
        ? `<span aria-current="page">${escapeHtml(c.name)}</span>`
        : `<a href="${escapeHtml(c.url)}">${escapeHtml(c.name)}</a><span>›</span>`
    )
    .join("");

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: o.breadcrumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: SITE_ORIGIN + c.url,
    })),
  };

  const ld = [breadcrumbLd, ...(o.jsonLd ?? [])]
    .map(
      (obj) =>
        `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`
    )
    .join("\n    ");

  return `<!doctype html>
<html lang="${lang}">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#0ea5e9" />
    <link rel="canonical" href="${escapeHtml(url)}" />

    <title>${escapeHtml(o.title)}</title>
    <meta name="description" content="${escapeHtml(o.description)}" />

    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="tarif.ist" />
    <meta property="og:url" content="${escapeHtml(url)}" />
    <meta property="og:title" content="${escapeHtml(o.title)}" />
    <meta property="og:description" content="${escapeHtml(o.description)}" />
    <meta property="og:image" content="${escapeHtml(ogImage)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />${
      o.ogImageAlt
        ? `\n    <meta property="og:image:alt" content="${escapeHtml(o.ogImageAlt)}" />`
        : ""
    }
    <meta property="og:locale" content="${lang === "tr" ? "tr_TR" : "en_US"}" />

    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(o.title)}" />
    <meta name="twitter:description" content="${escapeHtml(o.description)}" />
    <meta name="twitter:image" content="${escapeHtml(ogImage)}" />

    <style>${STYLE}</style>
    ${ld}
    <script defer src="https://analytics.zambak.page/script.js" data-website-id="${ANALYTICS_ID}"></script>
  </head>
  <body>
    <header class="site">
      <div class="wrap">
        <a class="brand" href="/">tarif<span>.ist</span></a>
        <a href="/">Canlı harita →</a>
      </div>
    </header>
    <div class="wrap">
      <nav class="crumbs">${crumbs}</nav>
      <main>
${o.body}
      </main>
    </div>
    <footer class="site">
      <div class="wrap">
        Veriler İBB Açık Veri Portalı ve Metro İstanbul kaynaklıdır; sefer
        süreleri ortalama hızlara göre hesaplanan tahminlerdir.
        <a href="/">Canlı haritada aç</a> ·
        <a href="https://github.com/berkaycubuk/tarif.ist">Kaynak kodu</a>
      </div>
    </footer>
  </body>
</html>
`;
}
