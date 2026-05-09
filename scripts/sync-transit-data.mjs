// Downloads Istanbul rail-system GeoJSON from the IBB Open Data Portal,
// filters to operational features, derives a `lineCode`, and writes
// trimmed files into public/data/. Run via `npm run sync:data`.
//
// Sources (CC-BY-style IBB Open Data License — attribute "İBB Açık Veri Portalı"):
//   https://data.ibb.gov.tr/en/dataset/rayli-sistem-istasyon-noktalari-verisi
//   https://data.ibb.gov.tr/en/dataset/rayli-ulasim-hatlari-vektor-verisi

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "..", "public", "data");

const STATIONS_URL =
  "https://data.ibb.gov.tr/dataset/04ec9805-2483-46c7-914f-30c50857a846/resource/3dc8203f-3613-48a8-85e9-24fffb7821ad/download/rayli_sistem_istasyon_poi_verisi.geojson";
const LINES_URL =
  "https://data.ibb.gov.tr/dataset/8b8603dd-2642-4789-a891-4bb7cb2c94e8/resource/fe4ec165-9d11-4b83-b031-caea3cfaae55/download/rayli_sistem_hat_verisi.geojson";

const STATION_OPERATIONAL = "Mevcut Hattaki İstasyon";
// IBB tags Marmaray with PROJE_ASAMA="Marmaray" instead of "Mevcut".
const LINE_OPERATIONAL = new Set(["Mevcut", "Marmaray"]);

const LINE_CODE_RE = /(M\d+[A-Za-z]?|T\d+|F\d+|B\d+|Marmaray)/i;

function deriveLineCode(...candidates) {
  for (const s of candidates) {
    if (typeof s !== "string") continue;
    const m = s.match(LINE_CODE_RE);
    if (m) {
      const code = m[1];
      return /marmaray/i.test(code) ? "Marmaray" : code.toUpperCase();
    }
  }
  return null;
}

async function fetchJson(url) {
  console.log(`→ fetching ${url}`);
  const res = await fetch(url, {
    headers: { "User-Agent": "istgoto-build/1.0 (+https://github.com)" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

function trimStations(geojson) {
  const features = [];
  for (const f of geojson.features ?? []) {
    const p = f.properties ?? {};
    if (p.PROJE_ASAMA !== STATION_OPERATIONAL) continue;
    const lineCode = deriveLineCode(p.PROJE_ADI);
    features.push({
      type: "Feature",
      geometry: f.geometry,
      properties: {
        name: p.ISTASYON ?? "",
        lineName: p.PROJE_ADI ?? "",
        lineCode,
        kind: p.HAT_TURU ?? null,
      },
    });
  }
  return { type: "FeatureCollection", features };
}

function trimLines(geojson) {
  const features = [];
  for (const f of geojson.features ?? []) {
    const p = f.properties ?? {};
    if (!LINE_OPERATIONAL.has(p.PROJE_ASAMA)) continue;
    const lineCode = deriveLineCode(p.PROJE_AD_KISA, p.PROJE_ADI);
    features.push({
      type: "Feature",
      geometry: f.geometry,
      properties: {
        name: p.PROJE_ADI ?? "",
        shortName: p.PROJE_AD_KISA ?? "",
        lineCode,
        kind: p.PROJE_TURU ?? null,
        lengthKm: p.UZUNLUK ?? null,
        stationCount: p.ISTASYON ?? null,
      },
    });
  }
  return { type: "FeatureCollection", features };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const [rawStations, rawLines] = await Promise.all([
    fetchJson(STATIONS_URL),
    fetchJson(LINES_URL),
  ]);

  const stations = trimStations(rawStations);
  const lines = trimLines(rawLines);

  const stationsPath = resolve(OUT_DIR, "stations.geojson");
  const linesPath = resolve(OUT_DIR, "lines.geojson");

  await writeFile(stationsPath, JSON.stringify(stations));
  await writeFile(linesPath, JSON.stringify(lines));

  console.log(
    `✓ wrote ${stations.features.length} stations → ${stationsPath}`
  );
  console.log(`✓ wrote ${lines.features.length} lines → ${linesPath}`);

  const codes = new Set();
  for (const f of [...stations.features, ...lines.features]) {
    if (f.properties.lineCode) codes.add(f.properties.lineCode);
  }
  console.log(
    `  line codes detected: ${[...codes].sort().join(", ") || "(none)"}`
  );
}

main().catch((err) => {
  console.error("sync failed:", err);
  process.exit(1);
});
