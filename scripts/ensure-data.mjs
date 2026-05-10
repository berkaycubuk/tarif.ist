// Lightweight pre-step for `npm run dev` / `npm run build`.
// If the trimmed transit GeoJSON files are missing, run the full sync.
// Otherwise no-op (fast, no network).

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, "..", "public", "data");
const required = ["stations.geojson", "lines.geojson", "headways.json"];
const busIndex = resolve(dataDir, "bus", "index.json");

const missing = required.filter((f) => !existsSync(resolve(dataDir, f)));
const missingBus = !existsSync(busIndex);

if (missing.length === 0 && !missingBus) {
  process.exit(0);
}

if (missing.length) {
  console.log(`transit data missing (${missing.join(", ")}) — syncing…`);
}
if (missingBus) {
  console.log("bus data missing — syncing IETT routes…");
}

async function run() {
  if (missing.length) {
    await spawnSync("sync-transit-data.mjs");
    if (missing.includes("headways.json")) {
      await spawnSync("sync-gtfs.mjs");
    }
  }
  if (missingBus) {
    await spawnSync("sync-bus-data.mjs");
  }
  process.exit(0);
}

function spawnSync(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [resolve(__dirname, script)], {
      stdio: "inherit",
    });
    child.on("exit", resolve);
  });
}

run();
