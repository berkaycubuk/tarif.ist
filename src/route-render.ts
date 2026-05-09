// Renders a Route on the Leaflet map (colored polylines for rail legs, dashed
// gray for walking) and returns the step-by-step itinerary HTML.
//
// renderRoute() is the single entry point. It resolves foot-routing geometry,
// draws every leg, enriches the route with real walking distances, and returns
// the enriched route + itinerary HTML. The input route is never mutated.

import L from "leaflet";
import { getLineGeometry } from "./graph";
import type { TransitGraph } from "./graph";
import { sliceLine } from "./geo";
import type { RailLeg, Route, RouteLeg, TransferLeg, WalkLeg } from "./router";
import { colorForLine } from "./transit";
import { getFootRoute, type FootRoute } from "./walk-routing";

export interface RenderedRoute {
  layer: L.LayerGroup;
  /** Enriched copy — walk/transfer durations and distances reflect OSRM routing. */
  route: Route;
  itineraryHtml: string;
}

const WALK_STYLE: L.PolylineOptions = {
  color: "#475569",
  weight: 4,
  opacity: 0.8,
  dashArray: "2 8",
  lineCap: "round",
};

/**
 * Resolve foot-routing geometry for every walk and transfer leg, draw the
 * route on the map, and return the enriched route + itinerary HTML. The input
 * route is read-only — a new enriched Route is returned.
 */
export async function renderRoute(
  map: L.Map,
  graph: TransitGraph,
  route: Route
): Promise<RenderedRoute> {
  const layer = L.layerGroup();

  // Fetch foot routes for all walk + transfer legs in parallel.
  const footRoutes = await Promise.all(
    route.legs.map((leg) => fetchLegFoot(leg))
  );

  // Compute enriched legs (new objects, input untouched)
  let totalSecDelta = 0;
  let totalWalkMDelta = 0;
  const enrichedLegs: RouteLeg[] = route.legs.map((leg, i) => {
    const foot = footRoutes[i];
    if (!foot) return leg;
    if (leg.kind === "walk") {
      totalSecDelta += foot.durationSec - leg.durationSec;
      totalWalkMDelta += foot.distM - leg.distM;
      return { ...leg, durationSec: foot.durationSec, distM: foot.distM };
    }
    if (leg.kind === "transfer") {
      totalSecDelta += foot.durationSec - leg.durationSec;
      totalWalkMDelta += foot.distM - leg.distM;
      return { ...leg, durationSec: foot.durationSec, distM: foot.distM };
    }
    return leg; // rail — never changed
  });

  const enriched: Route = {
    legs: enrichedLegs,
    totalSec: route.totalSec + totalSecDelta,
    totalWalkM: route.totalWalkM + totalWalkMDelta,
    totalRailM: route.totalRailM,
  };

  // Draw every leg using enriched values
  for (let i = 0; i < enriched.legs.length; i++) {
    const leg = enriched.legs[i];
    const foot = footRoutes[i];
    if (leg.kind === "rail") {
      drawRailLeg(layer, graph, leg);
    } else if (leg.kind === "transfer") {
      drawTransferLeg(layer, leg, foot);
    } else {
      drawWalkLeg(layer, leg, foot);
    }
  }

  layer.addTo(map);

  // Fit map to the full route
  const bounds = L.latLngBounds([]);
  for (const leg of enriched.legs) {
    if (leg.kind === "rail") {
      for (const s of leg.stations) bounds.extend([s.lat, s.lng]);
    } else {
      bounds.extend(leg.fromLatLng);
      bounds.extend(leg.toLatLng);
    }
  }
  for (const f of footRoutes) {
    if (!f) continue;
    for (const [lng, lat] of f.coords) bounds.extend([lat, lng]);
  }
  if (bounds.isValid()) {
    map.fitBounds(bounds, { padding: [80, 80], maxZoom: 15 });
  }

  return { layer, route: enriched, itineraryHtml: renderItinerary(enriched) };
}

// --- Foot routing helpers ---------------------------------------------------

async function fetchLegFoot(leg: RouteLeg): Promise<FootRoute | null> {
  if (leg.kind === "walk") {
    return getFootRoute(
      { lat: leg.fromLatLng[0], lng: leg.fromLatLng[1] },
      { lat: leg.toLatLng[0], lng: leg.toLatLng[1] }
    );
  }
  if (leg.kind === "transfer") {
    if (leg.distM < 30) return null;
    return getFootRoute(
      { lat: leg.fromLatLng[0], lng: leg.fromLatLng[1] },
      { lat: leg.toLatLng[0], lng: leg.toLatLng[1] }
    );
  }
  return null;
}

// --- Drawing ----------------------------------------------------------------

function drawRailLeg(
  layer: L.LayerGroup,
  graph: TransitGraph,
  leg: RailLeg
): void {
  const geom = getLineGeometry(graph, leg.lineCode);
  const color = colorForLine(leg.lineCode);
  const stations = leg.stations;
  if (!stations.length) return;

  let coords: L.LatLngExpression[];
  if (geom && stations.length >= 2) {
    const slice = sliceLine(
      geom,
      stations[0].cumDistOnLine,
      stations[stations.length - 1].cumDistOnLine
    );
    coords = slice.map(([lng, lat]) => [lat, lng] as L.LatLngExpression);
    if (!coords.length) {
      coords = stations.map((s) => [s.lat, s.lng]);
    }
  } else {
    coords = stations.map((s) => [s.lat, s.lng]);
  }

  L.polyline(coords, {
    color,
    weight: 7,
    opacity: 0.95,
    lineCap: "round",
    lineJoin: "round",
  }).addTo(layer);

  // Boarding & alighting markers
  const a = stations[0];
  const b = stations[stations.length - 1];
  for (const s of [a, b]) {
    L.circleMarker([s.lat, s.lng], {
      radius: 6,
      color: "#ffffff",
      weight: 2.5,
      fillColor: color,
      fillOpacity: 1,
    }).addTo(layer);
  }
}

function drawTransferLeg(
  layer: L.LayerGroup,
  leg: TransferLeg,
  foot: FootRoute | null
): void {
  if (
    leg.fromLatLng[0] === leg.toLatLng[0] &&
    leg.fromLatLng[1] === leg.toLatLng[1]
  ) {
    return;
  }
  drawWalkPath(layer, foot, leg.fromLatLng, leg.toLatLng);
}

function drawWalkLeg(
  layer: L.LayerGroup,
  leg: WalkLeg,
  foot: FootRoute | null
): void {
  drawWalkPath(layer, foot, leg.fromLatLng, leg.toLatLng);
}

function drawWalkPath(
  layer: L.LayerGroup,
  foot: FootRoute | null,
  from: [number, number],
  to: [number, number]
): void {
  const coords: L.LatLngExpression[] = foot
    ? foot.coords.map(([lng, lat]) => [lat, lng] as L.LatLngExpression)
    : [from, to];
  L.polyline(coords, WALK_STYLE).addTo(layer);
}

// --- Itinerary HTML ---------------------------------------------------------

function renderItinerary(route: Route): string {
  const totalMin = Math.max(1, Math.round(route.totalSec / 60));
  const walkKm = (route.totalWalkM / 1000).toFixed(1);
  const transitMin = Math.round((route.totalSec - route.totalWalkM / 1.4) / 60);

  const summary = `
    <div class="flex items-baseline justify-between">
      <div class="text-base font-semibold text-slate-900">${totalMin} min</div>
      <div class="text-[11px] text-slate-500">walk ${walkKm} km${transitMin > 0 ? ` · transit ~${Math.max(0, transitMin)} min` : ""}</div>
    </div>
  `;

  const stepsHtml = route.legs
    .map((leg) => renderLeg(leg))
    .filter(Boolean)
    .join("");

  return `
    <div class="space-y-2">
      ${summary}
      <ol class="space-y-1.5">${stepsHtml}</ol>
    </div>
  `;
}

function renderLeg(leg: RouteLeg): string {
  const min = Math.max(1, Math.round(leg.durationSec / 60));

  if (leg.kind === "walk") {
    if (leg.role === "direct") {
      return liRow(
        walkIcon(),
        `Walk ${(leg.distM / 1000).toFixed(1)} km`,
        `${min} min`,
        "bg-slate-100 text-slate-700"
      );
    }
    if (leg.role === "origin") {
      return liRow(
        walkIcon(),
        `Walk to <strong>${escapeHtml(leg.toName ?? "station")}</strong>`,
        `${Math.round(leg.distM)} m · ${min} min`,
        "bg-slate-100 text-slate-700"
      );
    }
    return liRow(
      walkIcon(),
      `Walk to destination${leg.fromName ? ` from <strong>${escapeHtml(leg.fromName)}</strong>` : ""}`,
      `${Math.round(leg.distM)} m · ${min} min`,
      "bg-slate-100 text-slate-700"
    );
  }

  if (leg.kind === "transfer") {
    return liRow(
      transferIcon(),
      `Transfer at <strong>${escapeHtml(leg.fromName)}</strong>${
        leg.fromLineCode && leg.toLineCode
          ? ` <span class="text-[10px] text-slate-500">(${escapeHtml(leg.fromLineCode)} → ${escapeHtml(leg.toLineCode)})</span>`
          : ""
      }`,
      `${Math.round(leg.distM)} m · ${min} min`,
      "bg-amber-50 text-amber-800"
    );
  }

  // rail
  const stops = Math.max(1, leg.stations.length - 1);
  const color = colorForLine(leg.lineCode);
  const badge = `
    <span data-line-code="${escapeHtml(leg.lineCode)}" style="background:${color};color:#fff;cursor:pointer" class="inline-flex h-5 min-w-[26px] items-center justify-center rounded-md px-1.5 text-[10px] font-bold tracking-tight hover:ring-2 hover:ring-offset-1 hover:ring-sky-400 transition">${escapeHtml(leg.lineCode)}</span>
  `;
  return liRow(
    badge,
    `<strong>${escapeHtml(leg.fromName)}</strong> → <strong>${escapeHtml(leg.toName)}</strong>`,
    `${stops} stop${stops === 1 ? "" : "s"} · ${min} min`,
    ""
  );
}

function liRow(
  badge: string,
  primary: string,
  secondary: string,
  badgeBg: string
): string {
  const bg = badgeBg
    ? `<span class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded ${badgeBg}">${badge}</span>`
    : badge;
  return `
    <li class="flex items-start gap-2 text-xs">
      <span class="mt-0.5 inline-flex shrink-0">${bg}</span>
      <div class="min-w-0 flex-1">
        <div class="text-slate-800">${primary}</div>
        <div class="text-[11px] text-slate-500">${secondary}</div>
      </div>
    </li>
  `;
}

function walkIcon(): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-3 w-3"><circle cx="13" cy="4" r="2"/><path d="M9 21h2l1-7 4 4v5"/><path d="M5 12h2l3-3 3 3-3 4-2-1"/></svg>`;
}

function transferIcon(): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-3 w-3"><path d="M3 7h13l-3-3"/><path d="M21 17H8l3 3"/></svg>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
