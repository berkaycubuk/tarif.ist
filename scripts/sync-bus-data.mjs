// Downloads IETT bus data from the IBB Open Data Portal and writes:
//   public/data/bus/index.json — searchable list of bus lines
//   public/data/bus/routes/<code>.geojson — per-line shape + stops
//
// Bus shapes for ~700 IETT lines are too big to ship as a single payload, so
// each line lives in its own file and is fetched on demand at runtime.
//
// Sources:
//   IETT GTFS — https://data.ibb.gov.tr/dataset/iett-gtfs-verisi
//     (routes/trips/stops/stop_times — used for the stop list of each line)
//   IETT route shapes —
//     https://data.ibb.gov.tr/dataset/iett-hat-guzergahlari
//     (per-itinerary GeoJSON LineStrings, keyed by HAT_KODU = line code)
//
// IETT GTFS is semicolon-delimited and double-encoded UTF-8 (the source
// strings are CP1252 mojibake of the original UTF-8 — see fixDoubleEncoded).

import { mkdir, writeFile, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "..", "public", "data", "bus");
const ROUTES_DIR = resolve(OUT_DIR, "routes");

const IETT_GTFS_PKG =
  "https://data.ibb.gov.tr/api/3/action/package_show?id=iett-gtfs-verisi";
const IETT_SHAPES_PKG =
  "https://data.ibb.gov.tr/api/3/action/package_show?id=iett-hat-guzergahlari";

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchText(url) {
  console.log(`  → ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  // IETT GTFS is shipped as UTF-8 (with BOM) but the strings inside are
  // already mojibake (Latin-1 read of the original UTF-8). We decode the file
  // bytes as UTF-8, then run fixDoubleEncoded to recover Turkish chars.
  return new TextDecoder("utf-8").decode(await res.arrayBuffer());
}

// IETT's stop_times.csv resource is silently truncated to ~1 048 575 rows
// (Excel limit). The .zip resource carries the full ~6M-row file. To avoid
// holding 150 MB of text in memory, we extract it to disk and stream it
// line-by-line. Returns the path to the extracted file (caller deletes).
async function downloadAndUnzipStopTimes(url) {
  console.log(`  → ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const zipPath = resolve(tmpdir(), `istgoto-iett-${Date.now()}.zip`);
  const outPath = resolve(tmpdir(), `istgoto-iett-${Date.now()}.txt`);
  await writeFile(zipPath, buf);

  const { openSync, closeSync } = await import("node:fs");
  await new Promise((ok, rej) => {
    const fd = openSync(outPath, "w");
    const child = spawn("unzip", ["-p", zipPath], {
      stdio: ["ignore", fd, "inherit"],
    });
    child.on("error", (err) => {
      closeSync(fd);
      rej(err);
    });
    child.on("close", (code) => {
      closeSync(fd);
      if (code !== 0) rej(new Error(`unzip exited ${code}`));
      else ok();
    });
  });
  await rm(zipPath, { force: true });
  return outPath;
}

async function streamStopTimes(path, cb) {
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  let header = null; // { sep, tripIdx, stopIdx, seqIdx, maxIdx }
  for await (let line of rl) {
    if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    if (!line) continue;
    if (!header) {
      const sep = line.includes(";") ? ";" : ",";
      const cols = line.split(sep).map((c) => c.trim().toLowerCase());
      const tripIdx = cols.indexOf("trip_id");
      const stopIdx = cols.indexOf("stop_id");
      const seqIdx = cols.indexOf("stop_sequence");
      if (tripIdx < 0 || stopIdx < 0 || seqIdx < 0) {
        throw new Error(
          `stop_times header missing required columns: ${cols.join(",")}`
        );
      }
      header = {
        sep,
        tripIdx,
        stopIdx,
        seqIdx,
        maxIdx: Math.max(tripIdx, stopIdx, seqIdx),
      };
      continue;
    }
    const fields = line.split(header.sep);
    if (fields.length <= header.maxIdx) continue;
    const tripId = fields[header.tripIdx];
    const stopId = fields[header.stopIdx];
    const seq = +fields[header.seqIdx];
    if (!tripId || !stopId || !Number.isFinite(seq)) continue;
    cb(tripId, stopId, seq);
  }
}

// CP1252 codepoints in the 0x80–0x9F range that differ from latin-1.
const CP1252_HIGH = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

// IETT GTFS strings come triple-encoded: the original UTF-8 bytes were read
// once as Latin-1 (so e.g. "Ş" U+015E → 0xC5 0x9E → "Å" + U+009E), then
// re-encoded as UTF-8. To recover the original we re-pack each char to its
// Latin-1 byte (with a CP1252 fallback for the few chars that aren't valid
// in pure Latin-1) and decode the result as UTF-8.
//
// IETT's GTFS bundle is inconsistent: routes.csv/trips.csv are mojibaked
// but stops.csv is already valid UTF-8. We unconditionally try the fix and
// only keep it when it doesn't introduce new replacement characters, so the
// already-correct rows pass through untouched.
function fixDoubleEncoded(text) {
  if (!text) return text;
  const bytes = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp <= 0xff) {
      bytes.push(cp);
    } else if (CP1252_HIGH[cp] !== undefined) {
      bytes.push(CP1252_HIGH[cp]);
    } else {
      // Unknown — pass through as UTF-8 bytes.
      const buf = Buffer.from(ch, "utf-8");
      for (const b of buf) bytes.push(b);
    }
  }
  const fixed = utf8Decoder.decode(Uint8Array.from(bytes));
  const REPL = "�";
  if (fixed.includes(REPL) && !text.includes(REPL)) return text;
  return fixed;
}

// Quote-aware delimited-line parser. IETT GTFS uses `;`, IBB-wide GTFS uses
// `,`. Both can include the delimiter inside double-quoted fields.
function parseDelimited(text, sep) {
  // Strip BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c === "\r") {
      // ignore
    } else {
      cell += c;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const arr = rows[r];
    if (arr.length === 1 && arr[0] === "") continue;
    const obj = {};
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i]] = arr[i] ?? "";
    }
    out.push(obj);
  }
  return out;
}

// Streaming reader for stop_times (semicolon-delimited, no quoted fields).
// Avoids materializing 6M+ row objects.
function walkStopTimes(text, cb) {
  // Strip BOM.
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  // Skip the header line.
  while (i < text.length && text.charCodeAt(i) !== 0x0a) i++;
  i++;
  while (i < text.length) {
    let lineEnd = text.indexOf("\n", i);
    if (lineEnd === -1) lineEnd = text.length;
    let lineLast = lineEnd;
    if (lineLast > i && text.charCodeAt(lineLast - 1) === 0x0d) lineLast--;
    if (lineLast > i) {
      const s1 = text.indexOf(";", i);
      if (s1 !== -1 && s1 < lineLast) {
        const s2 = text.indexOf(";", s1 + 1);
        if (s2 !== -1 && s2 < lineLast) {
          const s3 = text.indexOf(";", s2 + 1);
          const seqEnd = s3 === -1 || s3 > lineLast ? lineLast : s3;
          const tripId = text.substring(i, s1);
          const stopId = text.substring(s1 + 1, s2);
          const seq = +text.substring(s2 + 1, seqEnd);
          if (Number.isFinite(seq)) cb(tripId, stopId, seq);
        }
      }
    }
    i = lineEnd + 1;
  }
}

function safeFileName(s) {
  return s.replace(/[^A-Za-z0-9_-]/g, "_") || "_";
}

// IETT's stops.csv writes lat/lon with periods as thousand separators (e.g.
// "410.191.700.005.564" instead of "41.0191700005564"). A normal Number()
// returns NaN. Try the direct parse first; if that fails, strip non-digits
// and place the decimal after the first 2 digits — Istanbul coords start
// with 41 (lat) or 28–29 (lon), both 2-digit integer parts.
function parseCoord(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim();
  if (!s) return NaN;
  // Some rows use comma as decimal separator.
  if (!s.includes(".") && s.includes(",")) s = s.replace(",", ".");
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  const sign = s.startsWith("-") ? -1 : 1;
  const digits = s.replace(/[^\d]/g, "");
  if (digits.length < 3) return NaN;
  return sign * Number(digits.slice(0, 2) + "." + digits.slice(2));
}

async function main() {
  console.log("→ fetching dataset metadata");
  const [gtfsPkg, shapesPkg] = await Promise.all([
    fetchJson(IETT_GTFS_PKG),
    fetchJson(IETT_SHAPES_PKG),
  ]);

  // The csv stop_times resource is silently truncated at the Excel row limit
  // (≈1.05M rows), so we have to use the zip variant — it carries the full
  // ~6M-row file.
  const gtfsResources = { stop_times: null, stop_times_zip: null };
  for (const r of gtfsPkg.result.resources) {
    if (r.name === "stop_times") {
      if (r.format === "ZIP") gtfsResources.stop_times_zip = r.url;
      else gtfsResources.stop_times = r.url;
    } else {
      gtfsResources[r.name] = r.url;
    }
  }
  for (const required of ["routes", "trips", "stops", "stop_times_zip"]) {
    if (!gtfsResources[required]) {
      throw new Error(`IETT GTFS missing resource: ${required}`);
    }
  }

  const shapesResource = shapesPkg.result.resources.find(
    (r) => r.format === "GeoJSON"
  );
  if (!shapesResource) {
    throw new Error("IETT shapes GeoJSON resource not found");
  }

  console.log("→ downloading IETT GTFS (routes / trips / stops)");
  // Serialize — IBB occasionally drops parallel TLS connections.
  let routesText = await fetchText(gtfsResources.routes);
  let tripsText = await fetchText(gtfsResources.trips);
  let stopsText = await fetchText(gtfsResources.stops);

  const routes = parseDelimited(routesText, ";").map(fixRow);
  routesText = null;
  const trips = parseDelimited(tripsText, ";").map(fixRow);
  tripsText = null;
  const stops = parseDelimited(stopsText, ";").map(fixRow);
  stopsText = null;

  console.log("→ downloading + unzipping IETT stop_times (~22 MB → 150 MB)");
  const stopTimesPath = await downloadAndUnzipStopTimes(
    gtfsResources.stop_times_zip
  );

  // Build trip → [stopId, ...] (in stop_sequence order) by streaming the txt
  // line by line. We keep only the bare minimum: stops are recorded as
  // (seq, stopId) tuples and re-sorted at the end.
  const stopTimesByTrip = new Map();
  let stopTimeCount = 0;
  await streamStopTimes(stopTimesPath, (tripId, stopId, seq) => {
    let arr = stopTimesByTrip.get(tripId);
    if (!arr) {
      arr = [];
      stopTimesByTrip.set(tripId, arr);
    }
    arr.push([seq, stopId]);
    stopTimeCount++;
  });
  // Order each trip's stops by stop_sequence — IETT's file isn't guaranteed
  // sorted, and we render the stop list in route order.
  for (const arr of stopTimesByTrip.values()) {
    arr.sort((a, b) => a[0] - b[0]);
  }
  await rm(stopTimesPath, { force: true });

  console.log("→ downloading IETT route shapes (~250 MB GeoJSON)");
  const shapesGeoJson = await fetchJson(shapesResource.url);
  const shapesFeatures = shapesGeoJson.features ?? [];

  console.log(
    `  ${routes.length} routes · ${trips.length} trips · ${stops.length} stops · ${stopTimeCount} stop_times · ${shapesFeatures.length} shape itineraries`
  );

  // Keep only buses (route_type=3, although IETT-only feed should already be).
  const busRoutes = routes.filter((r) => r.route_type === "3");
  console.log(`  → ${busRoutes.length} bus routes`);

  // route_id → route_short_name (line code)
  const routeIdToCode = new Map();
  const codeToLongName = new Map();
  for (const r of busRoutes) {
    routeIdToCode.set(r.route_id, r.route_short_name);
    if (r.route_long_name && !codeToLongName.has(r.route_short_name)) {
      codeToLongName.set(r.route_short_name, r.route_long_name);
    }
  }

  // Group trips by line code.
  const tripsByCode = new Map();
  for (const t of trips) {
    const code = routeIdToCode.get(t.route_id);
    if (!code) continue;
    let arr = tripsByCode.get(code);
    if (!arr) {
      arr = [];
      tripsByCode.set(code, arr);
    }
    arr.push(t);
  }

  // Index stops.
  const stopMap = new Map();
  for (const s of stops) stopMap.set(s.stop_id, s);

  // Group shape features by HAT_KODU.
  const shapesByCode = new Map();
  for (const f of shapesFeatures) {
    const p = f.properties ?? {};
    const code = (p.HAT_KODU || "").trim();
    if (!code) continue;
    if (p.DURUM && p.DURUM !== "1") continue; // active only
    if (!f.geometry || f.geometry.type !== "LineString") continue;
    let arr = shapesByCode.get(code);
    if (!arr) {
      arr = [];
      shapesByCode.set(code, arr);
    }
    arr.push(f);
  }

  // Reset output directory.
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(ROUTES_DIR, { recursive: true });

  const index = [];
  const usedFileNames = new Set();
  let writtenFiles = 0;

  // Global stop accumulator: stopId → { name, lat, lng, lines: Set<code> }.
  // Written out as bus/stops.geojson so the map can show every IETT stop
  // without having to load all per-route files.
  const allStops = new Map();

  // Per-route stop sequence (longest direction wins). Written out as
  // bus/segments.json — the routing graph needs ordered stop lists at boot,
  // and loading every per-route GeoJSON would mean ~70 MB of fetches.
  const routeSequences = new Map(); // code -> string[] (stopIds)

  // Iterate over all unique line codes (union of GTFS and shapes).
  const allCodes = new Set([...tripsByCode.keys(), ...shapesByCode.keys()]);

  for (const code of allCodes) {
    const features = [];

    // --- shapes ---
    const shapeList = shapesByCode.get(code) ?? [];
    // Pick the longest GİDİŞ + longest DÖNÜŞ (one per direction).
    let bestGidis = null;
    let bestDonus = null;
    let fallback = null;
    for (const f of shapeList) {
      const yon = (f.properties?.YON || "").trim().toUpperCase();
      const len = Number(f.properties?.UZUNLUK?.toString().replace(",", ".")) || 0;
      const coordCount = f.geometry.coordinates.length;
      if (coordCount < 2) continue;
      const score = len > 0 ? len : coordCount;
      if (yon === "GİDİŞ" || yon === "GIDIS") {
        if (!bestGidis || score > bestGidis._score) {
          bestGidis = { ...f, _score: score };
        }
      } else if (yon === "DÖNÜŞ" || yon === "DONUS") {
        if (!bestDonus || score > bestDonus._score) {
          bestDonus = { ...f, _score: score };
        }
      } else if (!fallback || score > fallback._score) {
        fallback = { ...f, _score: score };
      }
    }

    function pushShape(feat, dir) {
      if (!feat) return;
      features.push({
        type: "Feature",
        geometry: feat.geometry,
        properties: {
          kind: "shape",
          direction: dir,
        },
      });
    }
    pushShape(bestGidis, "0");
    pushShape(bestDonus, "1");
    if (!bestGidis && !bestDonus) pushShape(fallback, "0");

    // --- stops ---
    const lineTrips = tripsByCode.get(code) ?? [];
    const tripsByDir = new Map();
    for (const t of lineTrips) {
      const dir = t.direction_id || "0";
      let arr = tripsByDir.get(dir);
      if (!arr) {
        arr = [];
        tripsByDir.set(dir, arr);
      }
      arr.push(t);
    }
    const seen = new Set();
    let longestDirSequence = [];
    for (const [dir, dirTrips] of tripsByDir) {
      let bestTrip = null;
      let bestLen = 0;
      for (const t of dirTrips) {
        const sts = stopTimesByTrip.get(t.trip_id);
        if (sts && sts.length > bestLen) {
          bestTrip = t;
          bestLen = sts.length;
        }
      }
      if (!bestTrip) continue;
      const sts = stopTimesByTrip.get(bestTrip.trip_id) ?? [];
      const dirSequence = [];
      let prevSeqStop = null;
      for (const [, stopId] of sts) {
        const stop = stopMap.get(stopId);
        if (!stop) continue;
        const lat = parseCoord(stop.stop_lat);
        const lon = parseCoord(stop.stop_lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        // Sanity-check the parse landed in/near Istanbul.
        if (lat < 40 || lat > 42 || lon < 27 || lon > 30) continue;

        if (stopId !== prevSeqStop) {
          dirSequence.push(stopId);
          prevSeqStop = stopId;
        }

        const key = `${stopId}|${dir}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const stopName = (stop.stop_name || "").trim();
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [lon, lat] },
          properties: {
            kind: "stop",
            name: stopName,
            direction: dir,
            stopId,
          },
        });
        let agg = allStops.get(stopId);
        if (!agg) {
          agg = { name: stopName, lat, lng: lon, lines: new Set() };
          allStops.set(stopId, agg);
        }
        agg.lines.add(code);
      }
      if (dirSequence.length > longestDirSequence.length) {
        longestDirSequence = dirSequence;
      }
    }
    if (longestDirSequence.length >= 2) {
      routeSequences.set(code, longestDirSequence);
    }

    if (!features.length) continue;

    let baseName = safeFileName(code);
    let fileName = `${baseName}.geojson`;
    let suffix = 1;
    while (usedFileNames.has(fileName)) {
      fileName = `${baseName}-${suffix}.geojson`;
      suffix++;
    }
    usedFileNames.add(fileName);

    const fc = { type: "FeatureCollection", features };
    await writeFile(resolve(ROUTES_DIR, fileName), JSON.stringify(fc));
    writtenFiles++;

    // Pull a human-readable name. GTFS route_long_name is usually
    // "ORIGIN - DESTINATION"; shapes have HAT_ADI which can be cleaner.
    let longName = codeToLongName.get(code) ?? "";
    if (!longName && shapeList.length) {
      longName = (shapeList[0].properties?.HAT_ADI || "").trim();
    }

    index.push({
      code,
      longName,
      file: fileName,
    });
  }

  index.sort((a, b) =>
    a.code.localeCompare(b.code, "tr", { numeric: true, sensitivity: "base" })
  );

  await writeFile(resolve(OUT_DIR, "index.json"), JSON.stringify(index));
  console.log(`✓ wrote ${writtenFiles} per-line files`);
  console.log(`✓ wrote bus index → ${resolve(OUT_DIR, "index.json")}`);

  // Global stop layer — one Point feature per unique stopId, with the list
  // of line codes serving it. Sorted line codes give a stable, search-friendly
  // payload; the file ends up ~1–2 MB for ~7–9k stops.
  const stopFeatures = [];
  for (const [stopId, agg] of allStops) {
    stopFeatures.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [agg.lng, agg.lat] },
      properties: {
        stopId,
        name: agg.name,
        lines: [...agg.lines].sort((a, b) =>
          a.localeCompare(b, "tr", { numeric: true, sensitivity: "base" })
        ),
      },
    });
  }
  const stopsFC = { type: "FeatureCollection", features: stopFeatures };
  await writeFile(resolve(OUT_DIR, "stops.geojson"), JSON.stringify(stopsFC));
  console.log(`✓ wrote ${stopFeatures.length} unique bus stops → stops.geojson`);

  // Compact segments file for the routing graph: every stop's coordinates +
  // ordered stop sequences per route. Loaded once at boot to wire bus stops
  // and bus edges into the transit graph.
  const segStops = {};
  for (const [stopId, agg] of allStops) {
    segStops[stopId] = { lat: agg.lat, lng: agg.lng, name: agg.name };
  }
  const segRoutes = [];
  for (const entry of index) {
    const seq = routeSequences.get(entry.code);
    if (!seq || seq.length < 2) continue;
    segRoutes.push({ code: entry.code, longName: entry.longName, stops: seq });
  }
  await writeFile(
    resolve(OUT_DIR, "segments.json"),
    JSON.stringify({ stops: segStops, routes: segRoutes })
  );
  console.log(
    `✓ wrote ${segRoutes.length} route sequences → segments.json`
  );
}

function fixRow(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === "string" ? fixDoubleEncoded(v) : v;
  }
  return out;
}

main().catch((err) => {
  console.error("bus sync failed:", err);
  process.exit(1);
});
