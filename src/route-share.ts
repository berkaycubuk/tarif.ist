// Encode a planned Route into a URL-safe blob and decode it back. The intent
// is "share this exact itinerary" — the recipient sees the original
// transport choices verbatim, no re-routing.
//
// Compactness rules:
//   - Walk legs need free-form coords + meta (origin/egress/direct, names)
//   - Rail / bus legs only store lineCode + the ordered station IDs; the
//     receiver looks each ID up in the same TransitGraph
//   - Transfer legs only store the two station IDs; names + coords come from
//     graph lookup
// Output is base64url-encoded JSON in the `?r=` param. ~10 legs typically
// land under 1 KB after encoding — comfortably inside browser URL limits.

import type {
  BusLeg,
  RailLeg,
  Route,
  RouteLeg,
  TransferLeg,
  WalkLeg,
} from "./router";
import { getNode, haversineMeters, type TransitGraph, type StationNode } from "./graph";

interface ShareWalkLeg {
  k: "w";
  r: WalkLeg["role"];
  a: [number, number]; // fromLatLng
  b: [number, number]; // toLatLng
  d: number; // distM
  t: number; // durationSec
  /** optional human names — handy when the walk anchors a station-less point */
  an?: string;
  bn?: string;
}
interface ShareTransferLeg {
  k: "x";
  a: string; // from node id
  b: string; // to node id
  d: number;
  t: number;
}
interface ShareTransitLeg {
  k: "r" | "b";
  c: string; // line code
  n: string[]; // station/stop node ids in order
  t: number; // total durationSec for the leg
}
type ShareLeg = ShareWalkLeg | ShareTransferLeg | ShareTransitLeg;

export interface SharePayload {
  v: 1;
  s: [number, number]; // start coords
  e: [number, number]; // end coords
  ts: number; // route.totalSec
  tw: number; // route.totalWalkM
  legs: ShareLeg[];
}

// --- Encode -----------------------------------------------------------------

export function encodeShareRoute(
  route: Route,
  start: { lat: number; lng: number },
  end: { lat: number; lng: number }
): string {
  const payload: SharePayload = {
    v: 1,
    s: round([start.lat, start.lng]),
    e: round([end.lat, end.lng]),
    ts: Math.round(route.totalSec),
    tw: Math.round(route.totalWalkM),
    legs: route.legs.map(toShareLeg),
  };
  return encodeBase64Url(JSON.stringify(payload));
}

function toShareLeg(leg: RouteLeg): ShareLeg {
  if (leg.kind === "walk") {
    const out: ShareWalkLeg = {
      k: "w",
      r: leg.role,
      a: round([leg.fromLatLng[0], leg.fromLatLng[1]]),
      b: round([leg.toLatLng[0], leg.toLatLng[1]]),
      d: Math.round(leg.distM),
      t: Math.round(leg.durationSec),
    };
    if (leg.fromName) out.an = leg.fromName;
    if (leg.toName) out.bn = leg.toName;
    return out;
  }
  if (leg.kind === "transfer") {
    // Transfer legs in router.ts don't carry node IDs directly, but the
    // surrounding rail/bus legs do — encode the matching boarding/alighting
    // nodes by name+line via the from/to coords as a fallback. We rely on
    // the from/to station of the *adjacent* legs at decode time, so here we
    // store coords + names instead of IDs.
    return {
      k: "x",
      a: encodeStationStub(
        leg.fromName,
        leg.fromLineCode,
        leg.fromLatLng[0],
        leg.fromLatLng[1]
      ),
      b: encodeStationStub(
        leg.toName,
        leg.toLineCode,
        leg.toLatLng[0],
        leg.toLatLng[1]
      ),
      d: Math.round(leg.distM),
      t: Math.round(leg.durationSec),
    };
  }
  // rail or bus
  return {
    k: leg.kind === "rail" ? "r" : "b",
    c: leg.lineCode,
    n: leg.stations.map((s) => s.id),
    t: Math.round(leg.durationSec),
  };
}

/** Inline-encoded fallback for transfer endpoints: "name|lineCode|lat|lng".
 *  Decode side splits on `|` and rebuilds a synthetic StationNode if needed. */
function encodeStationStub(
  name: string,
  lineCode: string,
  lat: number,
  lng: number
): string {
  return `_stub_${encodeURIComponent(name)}|${encodeURIComponent(lineCode)}|${lat.toFixed(5)}|${lng.toFixed(5)}`;
}

function decodeStationStub(
  raw: string
): { name: string; lineCode: string; lat: number; lng: number } | null {
  if (!raw.startsWith("_stub_")) return null;
  const parts = raw.slice("_stub_".length).split("|");
  if (parts.length !== 4) return null;
  const lat = Number(parts[2]);
  const lng = Number(parts[3]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    name: decodeURIComponent(parts[0]),
    lineCode: decodeURIComponent(parts[1]),
    lat,
    lng,
  };
}

// --- Decode -----------------------------------------------------------------

export interface DecodedShare {
  start: { lat: number; lng: number };
  end: { lat: number; lng: number };
  route: Route;
}

export function tryDecodeShareRoute(
  encoded: string,
  graph: TransitGraph
): DecodedShare | null {
  let payload: SharePayload;
  try {
    payload = JSON.parse(decodeBase64Url(encoded)) as SharePayload;
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1) return null;
  if (!Array.isArray(payload.legs) || !payload.s || !payload.e) return null;

  const legs: RouteLeg[] = [];
  let totalRailM = 0;
  for (const sl of payload.legs) {
    const leg = decodeShareLeg(sl, graph);
    if (!leg) return null;
    if (leg.kind === "rail" || leg.kind === "bus") totalRailM += leg.distM;
    legs.push(leg);
  }

  const route: Route = {
    legs,
    totalSec: payload.ts,
    totalWalkM: payload.tw,
    totalRailM,
  };
  return {
    start: { lat: payload.s[0], lng: payload.s[1] },
    end: { lat: payload.e[0], lng: payload.e[1] },
    route,
  };
}

function decodeShareLeg(sl: ShareLeg, graph: TransitGraph): RouteLeg | null {
  if (sl.k === "w") {
    const leg: WalkLeg = {
      kind: "walk",
      role: sl.r,
      fromLatLng: [sl.a[0], sl.a[1]],
      toLatLng: [sl.b[0], sl.b[1]],
      durationSec: sl.t,
      distM: sl.d,
    };
    if (sl.an) leg.fromName = sl.an;
    if (sl.bn) leg.toName = sl.bn;
    return leg;
  }
  if (sl.k === "x") {
    const a = resolveStationOrStub(sl.a, graph);
    const b = resolveStationOrStub(sl.b, graph);
    if (!a || !b) return null;
    const leg: TransferLeg = {
      kind: "transfer",
      fromName: a.stationName,
      toName: b.stationName,
      fromLineCode: a.lineCode,
      toLineCode: b.lineCode,
      fromLatLng: [a.lat, a.lng],
      toLatLng: [b.lat, b.lng],
      durationSec: sl.t,
      distM: sl.d,
    };
    return leg;
  }
  if (sl.k === "r" || sl.k === "b") {
    const stations: StationNode[] = [];
    for (const id of sl.n) {
      const node = getNode(graph, id);
      if (!node) return null;
      stations.push(node);
    }
    if (stations.length < 2) return null;
    let distM = 0;
    for (let i = 1; i < stations.length; i++) {
      distM += haversineMeters(
        stations[i - 1].lat,
        stations[i - 1].lng,
        stations[i].lat,
        stations[i].lng
      );
    }
    const leg: RailLeg | BusLeg = {
      kind: sl.k === "r" ? "rail" : "bus",
      lineCode: sl.c,
      fromName: stations[0].stationName,
      toName: stations[stations.length - 1].stationName,
      stations,
      durationSec: sl.t,
      distM,
    };
    return leg;
  }
  return null;
}

function resolveStationOrStub(
  raw: string,
  graph: TransitGraph
): StationNode | null {
  const stub = decodeStationStub(raw);
  if (stub) {
    return {
      id: `__stub_${stub.lat.toFixed(5)}_${stub.lng.toFixed(5)}`,
      mode: "rail",
      stationName: stub.name,
      lineCode: stub.lineCode,
      kind: null,
      lat: stub.lat,
      lng: stub.lng,
      cumDistOnLine: 0,
    };
  }
  return getNode(graph, raw) ?? null;
}

// --- Helpers ----------------------------------------------------------------

function round([lat, lng]: [number, number]): [number, number] {
  return [Number(lat.toFixed(5)), Number(lng.toFixed(5))];
}

function encodeBase64Url(s: string): string {
  // btoa needs Latin-1; first encode UTF-8 → bytes → btoa.
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "===".slice((padded.length + 3) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}
