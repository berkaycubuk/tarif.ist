// Downloads GTFS schedule data from IBB Open Data Portal, computes per-line
// headway and trip-duration estimates from actual stop_times, then writes a
// compact JSON file into public/data/ for the frontend.
//
// Source: https://data.ibb.gov.tr/en/dataset/public-transport-gtfs-data

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withRetry } from "./_retry.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "..", "public", "data");

const PKG_URL =
  "https://data.ibb.gov.tr/api/3/action/package_show?id=public-transport-gtfs-data";

const RAIL_AGENCIES = new Set(["4", "11"]); // TCDD (Marmaray), Metro Istanbul

const ROUTE_TO_LINE = {
  // GTFS route_short_name → our line code
  M1A: "M1A",
  M1B: "M1B",
  M2: "M2",
  M2A: "M2", // branch – merged into M2
  M3: "M3",
  M3A: "M3", // branch – merged into M3
  M4: "M4",
  M5: "M5",
  M6: "M6",
  M7: "M7",
  M8: "M8",
  M9: "M9",
  T1: "T1",
  T3: "T3",
  T4: "T4",
  F1: "F1",
  F2: "F2",
  F3: "F4", // F3 (Seyrantepe–Vadistanbul) → F4 in our data
  TF1: "F4", // Maçka–Taşkışla teleferik → approximate as F4
  TF2: "F4",
  Marmaray: "Marmaray",
  Marmaray1: "Marmaray",
  Marmaray2: "Marmaray",
};

async function fetchJson(url) {
  return withRetry(
    async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res.json();
    },
    { label: url }
  );
}

function parseCsv(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const vals = line.split(",");
    const obj = {};
    headers.forEach((h, i) => (obj[h] = vals[i]));
    return obj;
  });
}

async function fetchCsv(url) {
  return withRetry(
    async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return parseCsv(await res.text());
    },
    { label: url }
  );
}

function timeToSec(hhmmss) {
  const parts = hhmmss.split(":").map(Number);
  return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
}

async function main() {
  console.log("→ fetching GTFS package metadata");
  const pkg = await fetchJson(PKG_URL);
  const resources = {};
  for (const r of pkg.result.resources) {
    resources[r.name] = r.url;
  }

  console.log("→ downloading GTFS files");
  const [routes, trips, stopTimes] = await Promise.all([
    fetchCsv(resources.routes),
    fetchCsv(resources.trips),
    fetchCsv(resources.stop_times),
  ]);

  // Index trips by trip_id → { route_id, trip_id }
  const tripMap = new Map();
  for (const t of trips) {
    tripMap.set(t.trip_id, t);
  }

  // Group stop_times by trip_id, sorted by stop_sequence
  const stopsByTrip = new Map();
  for (const s of stopTimes) {
    let arr = stopsByTrip.get(s.trip_id);
    if (!arr) {
      arr = [];
      stopsByTrip.set(s.trip_id, arr);
    }
    arr.push(s);
  }
  for (const [, arr] of stopsByTrip) {
    arr.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
  }

  // Group by line code (our normalized codes)
  // Per (lineCode, direction, service_id) we collect departure times in seconds.
  const lineData = new Map(); // lineCode → { durationsSec: [], departuresByService: Map<string, number[]> }

  for (const route of routes) {
    if (!RAIL_AGENCIES.has(route.agency_id)) continue;
    const gtfsName = route.route_short_name;
    const lineCode = ROUTE_TO_LINE[gtfsName];
    if (!lineCode) {
      console.log(`  skipping unknown GTFS route: ${gtfsName}`);
      continue;
    }

    if (!lineData.has(lineCode)) {
      lineData.set(lineCode, { durationsSec: [], departuresByService: new Map() });
    }
    const ld = lineData.get(lineCode);

    // Process all trips for this route
    for (const trip of trips) {
      if (trip.route_id !== route.route_id) continue;
      const stops = stopsByTrip.get(trip.trip_id);
      if (!stops || stops.length < 2) continue;

      const departure = stops[0].departure_time || stops[0].arrival_time;
      const arrival = stops[stops.length - 1].arrival_time || stops[stops.length - 1].departure_time;
      if (!departure || !arrival) continue;

      const durSec = timeToSec(arrival) - timeToSec(departure);
      if (durSec <= 0 || durSec > 7200) continue;

      ld.durationsSec.push(durSec);

      // Group departures by direction + service_id for headway calculation
      const dir = trip.direction_id || "0";
      const svc = trip.service_id;
      const key = `${dir}|${svc}`;
      let depList = ld.departuresByService.get(key);
      if (!depList) {
        depList = [];
        ld.departuresByService.set(key, depList);
      }
      depList.push(timeToSec(departure));
    }
  }

  // Compute per-line estimates
  const result = {};
  for (const [code, ld] of lineData) {
    if (!ld.durationsSec.length) continue;

    // Average trip duration
    const avgTripSec = Math.round(
      ld.durationsSec.reduce((a, b) => a + b, 0) / ld.durationsSec.length
    );

    // Best headway: for each (direction, service) group, find the minimum
    // interval between consecutive sorted departures. Take the best (smallest)
    // interval across all groups — this represents peak headway.
    let bestHeadwaySec = Infinity;
    for (const [, depList] of ld.departuresByService) {
      if (depList.length < 2) continue;
      depList.sort((a, b) => a - b);

      // Calculate intervals between consecutive departures
      for (let i = 1; i < depList.length; i++) {
        const gap = depList[i] - depList[i - 1];
        // Skip gaps > 2 hours (service breaks) and <= 0 (duplicates)
        if (gap > 0 && gap <= 7200 && gap < bestHeadwaySec) {
          bestHeadwaySec = gap;
        }
      }
    }

    // Fall back to a reasonable default if we couldn't determine headway
    if (!isFinite(bestHeadwaySec) || bestHeadwaySec < 60) {
      bestHeadwaySec = 300; // 5 min default
    }
    const headwaySec = Math.round(bestHeadwaySec);

    // Number of trains = round_trip_time / headway
    // Add a 5-min terminal layover per end
    const roundTripSec = avgTripSec * 2 + 600;
    const trainCount = Math.max(2, Math.round(roundTripSec / headwaySec));

    result[code] = {
      headwaySec,
      tripDurationSec: avgTripSec,
      trainCount,
    };
  }

  // Fallback defaults for lines not in GTFS (M11, T5, etc.)
  const DEFAULTS = {
    Metro: { headwaySec: 300, tripDurationSec: 2400, trainCount: 10 },
    Tramvay: { headwaySec: 360, tripDurationSec: 3000, trainCount: 8 },
    Marmaray: { headwaySec: 450, tripDurationSec: 6000, trainCount: 14 },
    Füniküler: { headwaySec: 360, tripDurationSec: 240, trainCount: 2 },
    Teleferik: { headwaySec: 600, tripDurationSec: 480, trainCount: 2 },
  };

  // Pull line kinds from the transit data to fill in missing lines
  const stationsPath = resolve(OUT_DIR, "stations.geojson");
  const { readFile } = await import("node:fs/promises");
  let stationKind = {};
  try {
    const raw = JSON.parse(await readFile(stationsPath, "utf-8"));
    for (const f of raw.features || []) {
      const lc = f.properties?.lineCode;
      const kind = f.properties?.kind;
      if (lc && kind && !result[lc]) {
        stationKind[lc] = kind;
      }
    }
  } catch {
    // stations file not available yet — skip fallback enrichment
  }

  for (const [lc, kind] of Object.entries(stationKind)) {
    if (result[lc]) continue;
    const def = DEFAULTS[kind] || DEFAULTS.Metro;
    result[lc] = { ...def };
  }

  const outPath = resolve(OUT_DIR, "headways.json");
  await writeFile(outPath, JSON.stringify(result, null, 2));
  console.log(`✓ wrote headways for ${Object.keys(result).length} lines → ${outPath}`);

  for (const [code, d] of Object.entries(result).sort()) {
    console.log(
      `  ${code}: trip ${Math.round(d.tripDurationSec / 60)}m · headway ${Math.round(d.headwaySec / 60)}m · ${d.trainCount} trains`
    );
  }
}

main().catch((err) => {
  console.error("GTFS sync failed:", err);
  process.exit(1);
});
