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

const missing = required.filter((f) => !existsSync(resolve(dataDir, f)));
if (missing.length === 0) {
  process.exit(0);
}

console.log(`transit data missing (${missing.join(", ")}) — syncing…`);

async function run() {
  await spawnSync("sync-transit-data.mjs");
  if (missing.includes("headways.json")) {
    await spawnSync("sync-gtfs.mjs");
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
