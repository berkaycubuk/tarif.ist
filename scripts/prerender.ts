// Generates the static SEO pages into dist/, after `vite build`.
//
// Wave 1: every rail line and every rail station, plus the two hub indexes.
// Station-pair pages (/nasil-giderim/<a>/<b>/) come later, once Search Console
// shows this batch actually getting indexed — dumping thousands of pages on a
// site with little authority gets them filed under "Discovered – currently not
// indexed" and teaches you nothing.
//
// Run: npm run prerender   (chained after build)

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildGraph } from "../src/graph";
import { loadPrerenderData } from "./lib/load-data";
import {
  buildLinePages,
  buildStationPages,
  indexLinesByStationName,
} from "./lib/model";
import { renderLineIndex, renderStationIndex } from "./lib/render-index";
import { linePath, renderLinePage } from "./lib/render-line";
import { renderStationPage, stationPath } from "./lib/render-station";
import { renderSitemapIndex, renderUrlset, type SitemapEntry } from "./lib/sitemap";
import { slugIndex } from "./lib/slug";

const DIST = resolve(import.meta.dirname, "..", "dist");

async function emit(path: string, html: string): Promise<void> {
  // "/hat/m2/" -> dist/hat/m2/index.html, so the URL keeps its trailing slash
  // and no server-side rewrite is needed beyond try_files.
  const file = resolve(DIST, `.${path}`, "index.html");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, html, "utf8");
}

async function main(): Promise<void> {
  const started = Date.now();
  const data = await loadPrerenderData();

  // Fail the build on a slug collision rather than silently overwriting a page.
  const names = data.transit.stations.features
    .map((f) => f.properties.name)
    .filter((n): n is string => !!n);
  slugIndex(names);

  const graph = buildGraph(data.transit, data.bus);
  const linesByStationName = indexLinesByStationName(graph);
  const lines = buildLinePages(graph, data, linesByStationName);
  const stations = buildStationPages(graph, data, linesByStationName);

  if (!lines.length || !stations.length) {
    throw new Error(
      `prerender: refusing to write an empty batch (${lines.length} lines, ${stations.length} stations)`
    );
  }

  const lineEntries: SitemapEntry[] = [];
  const stationEntries: SitemapEntry[] = [];

  for (const line of lines) {
    await emit(linePath(line), renderLinePage(line));
    lineEntries.push({ path: linePath(line), changefreq: "weekly", priority: "0.8" });
  }
  for (const station of stations) {
    await emit(stationPath(station), renderStationPage(station));
    stationEntries.push({
      path: stationPath(station),
      changefreq: "monthly",
      priority: "0.6",
    });
  }

  await emit("/hat/", renderLineIndex(lines));
  await emit("/durak/", renderStationIndex(stations));
  lineEntries.unshift({ path: "/hat/", changefreq: "weekly", priority: "0.9" });
  stationEntries.unshift({ path: "/durak/", changefreq: "weekly", priority: "0.9" });

  const lastmod = new Date().toISOString().slice(0, 10);
  await writeFile(
    resolve(DIST, "sitemap-lines.xml"),
    renderUrlset(lineEntries),
    "utf8"
  );
  await writeFile(
    resolve(DIST, "sitemap-stations.xml"),
    renderUrlset(stationEntries),
    "utf8"
  );
  await writeFile(
    resolve(DIST, "sitemap-pages.xml"),
    renderUrlset([{ path: "/", changefreq: "daily", priority: "1.0" }]),
    "utf8"
  );
  // Overwrites the single-URL sitemap copied out of public/.
  await writeFile(
    resolve(DIST, "sitemap.xml"),
    renderSitemapIndex(
      ["sitemap-pages.xml", "sitemap-lines.xml", "sitemap-stations.xml"],
      lastmod
    ),
    "utf8"
  );

  const total = lines.length + stations.length + 2;
  console.info(
    `prerender: ${total} pages (${lines.length} lines, ${stations.length} stations) in ${
      Date.now() - started
    }ms`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
