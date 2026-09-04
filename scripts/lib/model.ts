// Turns the routing graph into the page models the templates render.
// Everything here comes out of buildGraph() — station order, inter-station
// distances and times are the same numbers the app's route planner uses, so
// the pages can't drift from what the map shows.

import type { StationNode, TransitGraph } from "../../src/graph";
import { getEdges } from "../../src/graph";
import { colorForLine } from "../../src/colors";
import { slugify } from "./slug";
import type { Headway, PrerenderData } from "./load-data";
import { lineDisplayName, lineKind, lineLengthKm } from "./load-data";

export interface StopOnLine {
  node: StationNode;
  slug: string;
  /** Metres from the previous stop; 0 at the first. */
  prevDistM: number;
  /** Seconds from the previous stop, including dwell; 0 at the first. */
  prevSec: number;
  /** Cumulative seconds from the line's first station. */
  cumSec: number;
  /** Other line codes you can change to here, on foot or in-station. */
  transfers: string[];
}

export interface LinePage {
  code: string;
  slug: string;
  displayName: string;
  kind: string | null;
  lengthKm: number | null;
  headway: Headway | undefined;
  stops: StopOnLine[];
  /** First and last station names, in graph order. */
  from: string;
  to: string;
  totalSec: number;
  /** Line codes sharing at least one transfer with this one. */
  connects: string[];
  color: string;
}

export interface NearbyStation {
  name: string;
  slug: string;
  distM: number;
  lines: string[];
}

export interface StationPage {
  slug: string;
  name: string;
  /** Line codes calling here, in stable order. */
  lines: string[];
  kind: string | null;
  lat: number;
  lng: number;
  /** Per line: which way the tracks go from this station. */
  directions: Array<{
    code: string;
    color: string;
    towards: string[];
    displayName: string;
  }>;
  /** Different-name stations within transfer range. */
  nearby: NearbyStation[];
}

function railEdgeBetween(
  graph: TransitGraph,
  a: StationNode,
  b: StationNode
): { weightSec: number; distM: number } | null {
  for (const e of getEdges(graph, a.id)) {
    if (e.to === b.id && e.kind === "rail") {
      return { weightSec: e.weightSec, distM: e.distM };
    }
  }
  return null;
}

/** Rail nodes only — bus stops get their own pages in a later wave. */
function railNodes(graph: TransitGraph): StationNode[] {
  return [...graph.nodes.values()].filter((n) => n.mode === "rail");
}

/**
 * Line codes reachable from this node without riding anything: the other lines
 * calling at the same station name, plus anything a transfer edge reaches.
 */
function transfersAt(
  graph: TransitGraph,
  node: StationNode,
  linesByStationName: Map<string, Set<string>>
): string[] {
  const out = new Set<string>(linesByStationName.get(node.stationName) ?? []);
  for (const e of getEdges(graph, node.id)) {
    if (e.kind !== "transfer") continue;
    const target = graph.nodes.get(e.to);
    if (target && target.mode === "rail" && target.lineCode) {
      out.add(target.lineCode);
    }
  }
  out.delete(node.lineCode);
  return [...out].sort(compareLineCodes);
}

/** M1A, M2, M11 … then T, F, Marmaray — numeric-aware so M11 follows M9. */
export function compareLineCodes(a: string, b: string): number {
  const parse = (s: string): [string, number, string] => {
    const m = /^([A-Za-z]+)(\d*)(.*)$/.exec(s) ?? [];
    return [m[1] ?? s, m[2] ? Number(m[2]) : 0, m[3] ?? ""];
  };
  const [ap, an, as] = parse(a);
  const [bp, bn, bs] = parse(b);
  if (ap !== bp) return ap.localeCompare(bp, "tr");
  if (an !== bn) return an - bn;
  return as.localeCompare(bs, "tr");
}

export function buildLinePages(
  graph: TransitGraph,
  data: PrerenderData,
  linesByStationName: Map<string, Set<string>>
): LinePage[] {
  const pages: LinePage[] = [];

  for (const [code, nodes] of graph.byLine) {
    // Bus routes share byLine with rail; they're keyed by route code and have
    // bus-mode nodes. Skip them here — wave 1 is rail only.
    if (!code || !nodes.length || nodes[0].mode !== "rail") continue;

    const stops: StopOnLine[] = [];
    let cumSec = 0;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const edge = i > 0 ? railEdgeBetween(graph, nodes[i - 1], node) : null;
      if (edge) cumSec += edge.weightSec;
      stops.push({
        node,
        slug: slugify(node.stationName),
        prevDistM: edge?.distM ?? 0,
        prevSec: edge?.weightSec ?? 0,
        cumSec,
        transfers: transfersAt(graph, node, linesByStationName),
      });
    }

    const connects = [...new Set(stops.flatMap((s) => s.transfers))].sort(
      compareLineCodes
    );

    pages.push({
      code,
      slug: slugify(code),
      displayName: lineDisplayName(data.transit, code),
      kind: lineKind(data.transit, code) ?? nodes[0].kind,
      lengthKm: lineLengthKm(data.transit, code),
      headway: data.headways[code],
      stops,
      from: nodes[0].stationName,
      to: nodes[nodes.length - 1].stationName,
      totalSec: cumSec,
      connects,
      color: colorForLine(code),
    });
  }

  return pages.sort((a, b) => compareLineCodes(a.code, b.code));
}

/** Station name → the set of rail line codes calling there. */
export function indexLinesByStationName(
  graph: TransitGraph
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const n of railNodes(graph)) {
    if (!n.lineCode) continue;
    let set = out.get(n.stationName);
    if (!set) out.set(n.stationName, (set = new Set()));
    set.add(n.lineCode);
  }
  return out;
}

export function buildStationPages(
  graph: TransitGraph,
  data: PrerenderData,
  linesByStationName: Map<string, Set<string>>
): StationPage[] {
  const byName = new Map<string, StationNode[]>();
  for (const n of railNodes(graph)) {
    let arr = byName.get(n.stationName);
    if (!arr) byName.set(n.stationName, (arr = []));
    arr.push(n);
  }

  const pages: StationPage[] = [];

  for (const [name, nodes] of byName) {
    const slug = slugify(name);
    if (!slug) continue;

    const lines = [...new Set(nodes.map((n) => n.lineCode).filter(Boolean))].sort(
      compareLineCodes
    );

    // Which stations you can reach on foot, excluding other platforms of this
    // same station (those are already listed as in-station interchanges).
    const nearbyByName = new Map<string, number>();
    for (const n of nodes) {
      for (const e of getEdges(graph, n.id)) {
        if (e.kind !== "transfer") continue;
        const t = graph.nodes.get(e.to);
        if (!t || t.mode !== "rail" || t.stationName === name) continue;
        const prev = nearbyByName.get(t.stationName);
        if (prev === undefined || e.distM < prev) {
          nearbyByName.set(t.stationName, e.distM);
        }
      }
    }

    const directions = nodes.map((n) => {
      const ordered = graph.byLine.get(n.lineCode) ?? [];
      const i = ordered.findIndex((x) => x.id === n.id);
      const towards: string[] = [];
      if (i > 0) towards.push(ordered[0].stationName);
      if (i >= 0 && i < ordered.length - 1) {
        towards.push(ordered[ordered.length - 1].stationName);
      }
      return {
        code: n.lineCode,
        color: colorForLine(n.lineCode),
        towards,
        displayName: lineDisplayName(data.transit, n.lineCode),
      };
    });

    pages.push({
      slug,
      name,
      lines,
      kind: nodes[0].kind,
      lat: nodes[0].lat,
      lng: nodes[0].lng,
      directions: directions.sort((a, b) => compareLineCodes(a.code, b.code)),
      nearby: [...nearbyByName]
        .sort((a, b) => a[1] - b[1])
        .map(([n, distM]) => ({
          name: n,
          slug: slugify(n),
          distM,
          lines: [...(linesByStationName.get(n) ?? [])].sort(compareLineCodes),
        })),
    });
  }

  return pages.sort((a, b) => a.name.localeCompare(b.name, "tr"));
}
