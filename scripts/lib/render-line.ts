// /hat/<code>/ — one page per rail line.

import {
  escapeHtml,
  formatDistance,
  formatDuration,
  renderShell,
  SITE_ORIGIN,
} from "./html";
import { colorForLine } from "../../src/colors";
import type { LinePage } from "./model";

/** "Metro Hattı", "Tramvay Hattı"… falls back to a neutral noun. */
function kindNoun(kind: string | null): string {
  return kind ? `${kind} Hattı` : "Hattı";
}

function pill(code: string, color: string, href?: string): string {
  const inner = `<span class="pill" style="background:${escapeHtml(color)}">${escapeHtml(code)}</span>`;
  return href ? `<a href="${escapeHtml(href)}" style="text-decoration:none">${inner}</a>` : inner;
}

export function linePath(page: LinePage): string {
  return `/hat/${page.slug}/`;
}

export function renderLinePage(page: LinePage): string {
  const noun = kindNoun(page.kind);
  const stopCount = page.stops.length;
  const headwayText = page.headway
    ? `${Math.round(page.headway.headwaySec / 60)} dk`
    : "—";

  const title = `${page.code} ${noun} — Duraklar, Sefer Sıklığı ve Süre`;
  const description =
    `${page.code} ${page.from} – ${page.to} hattı: ${stopCount} durak, ` +
    `uçtan uca yaklaşık ${formatDuration(page.totalSec)}` +
    (page.headway ? `, ortalama ${headwayText} arayla sefer` : "") +
    `. Aktarma noktaları ve canlı tren konumları tarif.ist'te.`;

  const ogImage =
    `${SITE_ORIGIN}/og/line.png?code=${encodeURIComponent(page.code)}` +
    `&name=${encodeURIComponent(page.displayName)}` +
    `&kind=${encodeURIComponent(page.kind ?? "")}&lang=tr`;

  const rows = page.stops
    .map((s, i) => {
      const transfers = s.transfers.length
        ? s.transfers.map((c) => pill(c, colorForLine(c), `/hat/${c.toLowerCase()}/`)).join(" ")
        : `<span style="color:var(--muted)">—</span>`;
      return `          <tr>
            <td class="num">${i + 1}</td>
            <td><a href="/durak/${escapeHtml(s.slug)}/">${escapeHtml(s.node.stationName)}</a></td>
            <td>${transfers}</td>
            <td class="num">${i === 0 ? "—" : formatDistance(s.prevDistM)}</td>
            <td class="num">${i === 0 ? "0 dk" : formatDuration(s.cumSec)}</td>
          </tr>`;
    })
    .join("\n");

  const connects = page.connects.length
    ? `<h2>Aktarma yapabileceğiniz hatlar</h2>
        <ul class="links">
${page.connects
  .map((c) => `          <li><a href="/hat/${c.toLowerCase()}/">${escapeHtml(c)} hattı</a></li>`)
  .join("\n")}
        </ul>`
    : "";

  const body = `        <h1>${escapeHtml(page.code)} ${escapeHtml(noun)}</h1>
        <p class="lede">
          ${escapeHtml(page.from)} ile ${escapeHtml(page.to)} arasında çalışan
          ${escapeHtml(page.code)} hattında ${stopCount} durak var. Uçtan uca yolculuk
          duraklardaki beklemelerle birlikte yaklaşık ${formatDuration(page.totalSec)} sürüyor.
        </p>

        <a class="cta" href="/?line=${encodeURIComponent(page.code)}">Hattı canlı haritada aç</a>

        <dl class="stats">
          <div class="stat"><dt>Durak</dt><dd>${stopCount}</dd></div>
          <div class="stat"><dt>Uçtan uca</dt><dd>${formatDuration(page.totalSec)}</dd></div>
          <div class="stat"><dt>Sefer sıklığı</dt><dd>${headwayText}</dd></div>
          <div class="stat"><dt>Hat uzunluğu</dt><dd>${
            page.lengthKm ? `${page.lengthKm.toFixed(1)} km` : "—"
          }</dd></div>
        </dl>

        <h2>${escapeHtml(page.code)} hattı durakları</h2>
        <div class="scroll">
          <table>
            <thead>
              <tr><th>#</th><th>Durak</th><th>Aktarma</th><th>Önceki duraktan</th><th>Toplam</th></tr>
            </thead>
            <tbody>
${rows}
            </tbody>
          </table>
        </div>

        ${connects}

        <h2>Canlı durum</h2>
        <p>
          ${escapeHtml(page.code)} hattındaki tren konumlarını ve Metro İstanbul'un
          yayınladığı arıza bildirimlerini
          <a href="/?line=${encodeURIComponent(page.code)}">canlı haritada</a>
          takip edebilirsiniz.
        </p>`;

  return renderShell({
    title: `${title} | tarif.ist`,
    description,
    path: linePath(page),
    ogImage,
    ogImageAlt: `${page.code} hattının İstanbul haritası üzerindeki güzergâhı.`,
    breadcrumbs: [
      { name: "tarif.ist", url: "/" },
      { name: "Hatlar", url: "/hat/" },
      { name: `${page.code} ${noun}`, url: linePath(page) },
    ],
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "ItemList",
        name: `${page.code} ${noun} durakları`,
        numberOfItems: stopCount,
        itemListElement: page.stops.map((s, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: s.node.stationName,
          item: `${SITE_ORIGIN}/durak/${s.slug}/`,
        })),
      },
    ],
    body,
  });
}
