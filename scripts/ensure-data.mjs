// Lightweight pre-step for `npm run dev` / `npm run build`.
// If the trimmed transit GeoJSON files are missing, run the full sync.
// Otherwise no-op (fast, no network).

import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolvePath(__dirname, "..", "public", "data");
const required = ["stations.geojson", "lines.geojson", "headways.json"];
const busFiles = ["bus/index.json", "bus/segments.json"];

const missing = required.filter((f) => !existsSync(resolvePath(dataDir, f)));
const missingBus = busFiles.some((f) => !existsSync(resolvePath(dataDir, f)));

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
  try {
    if (missing.length) {
      await runScript("sync-transit-data.mjs");
      if (missing.includes("headways.json")) {
        await runScript("sync-gtfs.mjs");
      }
    }
    if (missingBus) {
      await runScript("sync-bus-data.mjs");
    }
    process.exit(0);
  } catch (err) {
    // Fail the build instead of producing a deploy with no transit data.
    // Cloudflare Pages (and any other CI) treats a non-zero exit as a
    // build failure, which is what we want.
    console.error(`ensure-data: ${err.message}`);
    process.exit(1);
  }
}

function runScript(script) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [resolvePath(__dirname, script)], {
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${script} exited with code ${code}`));
    });
    child.on("error", rejectRun);
  });
}

run();
