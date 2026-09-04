// /durak/<slug>/ — one page per rail station, merging every line that calls
// there into a single URL.

import { escapeHtml, formatDistance, renderShell, SITE_ORIGIN } from "./html";
import type { StationPage } from "./model";

function pill(code: string, color: string): string {
  return `<a href="/hat/${code.toLowerCase()}/" style="text-decoration:none"><span class="pill" style="background:${escapeHtml(
    color
  )}">${escapeHtml(code)}</span></a>`;
}

export function stationPath(page: StationPage): string {
  return `/durak/${page.slug}/`;
}

function listLines(lines: string[]): string {
  if (lines.length === 1) return `${lines[0]} hattı`;
  return `${lines.slice(0, -1).join(", ")} ve ${lines[lines.length - 1]} hatları`;
}

export function renderStationPage(page: StationPage): string {
  const isInterchange = page.lines.length > 1;
  // "M7 Hattı" but "M2, M7 Hatları" — Turkish marks the plural on the noun, so
  // a blanket "Hatları" reads wrong on the ~150 single-line stations.
  const title =
    `${page.name} İstasyonu — ${page.lines.join(", ")} ` +
    `${isInterchange ? "Hatları" : "Hattı"} ve Aktarmalar`;
  const description =
    `${page.name} istasyonunda ${listLines(page.lines)} duruyor` +
    (isInterchange ? ", istasyon içinde aktarma yapabilirsiniz" : "") +
    (page.nearby.length
      ? `. Yürüme mesafesinde ${page.nearby.length} durak daha var`
      : "") +
    `. Hat yönleri ve canlı tren konumları tarif.ist'te.`;

  const directions = page.directions
    .map(
      (d) => `          <tr>
            <td>${pill(d.code, d.color)}</td>
            <td>${
              d.towards.length
                ? d.towards.map((t) => `${escapeHtml(t)} yönü`).join("<br />")
                : "<span style=\"color:var(--muted)\">—</span>"
            }</td>
            <td class="num">${escapeHtml(d.displayName)}</td>
          </tr>`
    )
    .join("\n");

  const nearby = page.nearby.length
    ? `<h2>Yürüme mesafesindeki duraklar</h2>
        <div class="scroll">
          <table>
            <thead><tr><th>Durak</th><th>Hatlar</th><th>Mesafe</th></tr></thead>
            <tbody>
${page.nearby
  .map(
    (n) => `              <tr>
                <td><a href="/durak/${escapeHtml(n.slug)}/">${escapeHtml(n.name)}</a></td>
                <td>${n.lines.map((c) => escapeHtml(c)).join(", ")}</td>
                <td class="num">${formatDistance(n.distM)}</td>
              </tr>`
  )
  .join("\n")}
            </tbody>
          </table>
        </div>`
    : "";

  const body = `        <h1>${escapeHtml(page.name)} İstasyonu</h1>
        <p class="lede">
          ${escapeHtml(page.name)} istasyonunda ${escapeHtml(listLines(page.lines))} duruyor.${
            isInterchange
              ? " Hatlar arasında istasyon içinde aktarma yapabilirsiniz."
              : ""
          }
        </p>

        <a class="cta" href="/?line=${encodeURIComponent(page.lines[0])}">Haritada göster</a>

        <dl class="stats">
          <div class="stat"><dt>Hat</dt><dd>${page.lines.length}</dd></div>
          <div class="stat"><dt>Tür</dt><dd style="font-size:1rem">${escapeHtml(
            page.kind ?? "—"
          )}</dd></div>
          <div class="stat"><dt>Yakın durak</dt><dd>${page.nearby.length}</dd></div>
        </dl>

        <h2>Hatlar ve yönler</h2>
        <div class="scroll">
          <table>
            <thead><tr><th>Hat</th><th>Yön</th><th>Güzergâh</th></tr></thead>
            <tbody>
${directions}
            </tbody>
          </table>
        </div>

        ${nearby}

        <h2>Canlı durum</h2>
        <p>
          ${escapeHtml(page.name)} istasyonundan geçen trenlerin anlık konumlarını ve
          servis arızalarını <a href="/">canlı haritada</a> görebilirsiniz.
        </p>`;

  return renderShell({
    title: `${title} | tarif.ist`,
    description,
    path: stationPath(page),
    ogImageAlt: `${page.name} istasyonunun İstanbul ulaşım haritasındaki konumu.`,
    breadcrumbs: [
      { name: "tarif.ist", url: "/" },
      { name: "Duraklar", url: "/durak/" },
      { name: `${page.name} İstasyonu`, url: stationPath(page) },
    ],
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "TrainStation",
        name: `${page.name} İstasyonu`,
        url: SITE_ORIGIN + stationPath(page),
        geo: {
          "@type": "GeoCoordinates",
          latitude: page.lat,
          longitude: page.lng,
        },
        address: {
          "@type": "PostalAddress",
          addressLocality: "İstanbul",
          addressCountry: "TR",
        },
      },
    ],
    body,
  });
}
