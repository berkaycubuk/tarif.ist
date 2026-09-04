// /hat/ and /durak/ — hub pages. They exist partly for humans and partly so
// every generated page is reachable from the homepage in two clicks; orphaned
// pages are the usual reason a big batch never gets crawled.

import { escapeHtml, renderShell } from "./html";
import type { LinePage, StationPage } from "./model";
import { linePath } from "./render-line";
import { stationPath } from "./render-station";

export function renderLineIndex(lines: LinePage[]): string {
  const rows = lines
    .map(
      (l) => `          <tr>
            <td><a href="${linePath(l)}" style="text-decoration:none"><span class="pill" style="background:${escapeHtml(
              l.color
            )}">${escapeHtml(l.code)}</span></a></td>
            <td><a href="${linePath(l)}">${escapeHtml(l.from)} – ${escapeHtml(l.to)}</a></td>
            <td class="num">${escapeHtml(l.kind ?? "—")}</td>
            <td class="num">${l.stops.length}</td>
          </tr>`
    )
    .join("\n");

  return renderShell({
    title: "İstanbul Metro, Tramvay ve Marmaray Hatları | tarif.ist",
    description:
      `İstanbul'un ${lines.length} raylı sistem hattı: metro, tramvay, Marmaray ve ` +
      `füniküler. Her hattın durakları, sefer sıklığı ve aktarma noktaları.`,
    path: "/hat/",
    breadcrumbs: [
      { name: "tarif.ist", url: "/" },
      { name: "Hatlar", url: "/hat/" },
    ],
    body: `        <h1>İstanbul raylı sistem hatları</h1>
        <p class="lede">
          İstanbul'daki ${lines.length} metro, tramvay, Marmaray ve füniküler hattı.
          Her hattın durak listesi, sefer sıklığı ve aktarma noktaları için hattın
          üzerine dokunun.
        </p>
        <div class="scroll">
          <table>
            <thead><tr><th>Hat</th><th>Güzergâh</th><th>Tür</th><th>Durak</th></tr></thead>
            <tbody>
${rows}
            </tbody>
          </table>
        </div>`,
  });
}

export function renderStationIndex(stations: StationPage[]): string {
  const items = stations
    .map(
      (s) =>
        `          <li><a href="${stationPath(s)}">${escapeHtml(s.name)}</a></li>`
    )
    .join("\n");

  return renderShell({
    title: "İstanbul Metro ve Marmaray Durakları | tarif.ist",
    description:
      `İstanbul raylı sistem ağındaki ${stations.length} durak. Her durakta hangi ` +
      `hatların durduğunu, yönleri ve yürüme mesafesindeki aktarmaları görün.`,
    path: "/durak/",
    breadcrumbs: [
      { name: "tarif.ist", url: "/" },
      { name: "Duraklar", url: "/durak/" },
    ],
    body: `        <h1>İstanbul raylı sistem durakları</h1>
        <p class="lede">
          Ağdaki ${stations.length} durağın tamamı. Her durak sayfasında orada duran
          hatlar, gidiş yönleri ve yürüme mesafesindeki aktarma noktaları var.
        </p>
        <ul class="links">
${items}
        </ul>`,
  });
}
