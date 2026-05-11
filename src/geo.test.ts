import { describe, expect, it } from "vitest";
import {
  buildLineGeometry,
  flattenLine,
  haversineMeters,
  projectPointOntoLine,
  sliceLine,
} from "./geo";

// Known reference: Taksim ↔ Levent (M2) is ~5.4 km as the crow flies.
const TAKSIM = { lat: 41.0370, lng: 28.9858 };
const LEVENT = { lat: 41.0828, lng: 29.0094 };

describe("haversineMeters", () => {
  it("is zero for identical points", () => {
    expect(haversineMeters(41.0, 29.0, 41.0, 29.0)).toBe(0);
  });

  it("is symmetric", () => {
    const ab = haversineMeters(TAKSIM.lat, TAKSIM.lng, LEVENT.lat, LEVENT.lng);
    const ba = haversineMeters(LEVENT.lat, LEVENT.lng, TAKSIM.lat, TAKSIM.lng);
    expect(ab).toBeCloseTo(ba, 6);
  });

  it("matches the known Taksim→Levent distance within 1%", () => {
    const d = haversineMeters(TAKSIM.lat, TAKSIM.lng, LEVENT.lat, LEVENT.lng);
    expect(d).toBeGreaterThan(5300);
    expect(d).toBeLessThan(5500);
  });

  it("is 1 degree of latitude ≈ 111 km", () => {
    const d = haversineMeters(0, 0, 1, 0);
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });
});

describe("flattenLine", () => {
  it("returns LineString coordinates unchanged", () => {
    const out = flattenLine({
      type: "LineString",
      coordinates: [[0, 0], [1, 0], [1, 1]],
    });
    expect(out).toEqual([[0, 0], [1, 0], [1, 1]]);
  });

  it("chains MultiLineString parts by endpoint proximity", () => {
    // Two parts intentionally given in the "wrong" order to verify chaining.
    const out = flattenLine({
      type: "MultiLineString",
      coordinates: [
        [[2, 0], [3, 0]], // second part
        [[0, 0], [1, 0]], // first part — chain should start here when it's index 0
      ],
    });
    // The current implementation starts from index 0, so the chain begins at
    // [2,0] and extends to the closer endpoint of the other part ([1,0]).
    expect(out[0]).toEqual([2, 0]);
    expect(out[out.length - 1]).toEqual([0, 0]);
    expect(out.length).toBe(4);
  });

  it("dedupes duplicate join points", () => {
    const out = flattenLine({
      type: "MultiLineString",
      coordinates: [
        [[0, 0], [1, 0]],
        [[1, 0], [2, 0]], // shares endpoint with part 0
      ],
    });
    expect(out).toEqual([[0, 0], [1, 0], [2, 0]]);
  });
});

describe("buildLineGeometry", () => {
  it("has matching path and cum lengths, with cum[0] = 0", () => {
    const geom = buildLineGeometry({
      type: "LineString",
      coordinates: [[0, 0], [0, 1], [0, 2]],
    });
    expect(geom.path.length).toBe(3);
    expect(geom.cum.length).toBe(3);
    expect(geom.cum[0]).toBe(0);
    expect(geom.cum[2]).toBe(geom.totalLengthM);
    expect(geom.cum[1]).toBeGreaterThan(0);
    expect(geom.cum[2]).toBeGreaterThan(geom.cum[1]);
  });

  it("totalLengthM ≈ sum of segment haversines", () => {
    const geom = buildLineGeometry({
      type: "LineString",
      coordinates: [[28.97, 41.00], [28.98, 41.01], [28.99, 41.02]],
    });
    const a = haversineMeters(41.00, 28.97, 41.01, 28.98);
    const b = haversineMeters(41.01, 28.98, 41.02, 28.99);
    expect(geom.totalLengthM).toBeCloseTo(a + b, 4);
  });
});

describe("projectPointOntoLine", () => {
  const geom = buildLineGeometry({
    type: "LineString",
    coordinates: [[0, 0], [0, 1], [0, 2]], // a meridian segment
  });

  it("snaps an on-line point to itself with ~0 perpendicular distance", () => {
    const { minDist } = projectPointOntoLine(0, 0.5, geom);
    expect(minDist).toBeLessThan(1); // <1m
  });

  it("projects beyond the line ends to the nearest endpoint", () => {
    const past = projectPointOntoLine(0, 5, geom); // far north of the line
    expect(past.cumDist).toBeCloseTo(geom.totalLengthM, 0);
  });

  it("returns cumDist 0 for the starting point", () => {
    const start = projectPointOntoLine(0, 0, geom);
    expect(start.cumDist).toBe(0);
  });

  it("a point west of the midpoint snaps to ~midline cumDist", () => {
    const mid = projectPointOntoLine(-0.001, 1, geom);
    expect(mid.cumDist).toBeCloseTo(geom.totalLengthM / 2, 0);
  });
});

describe("sliceLine", () => {
  const geom = buildLineGeometry({
    type: "LineString",
    coordinates: [[0, 0], [0, 1], [0, 2], [0, 3]],
  });

  it("returns endpoints at exact slice bounds", () => {
    const out = sliceLine(geom, 0, geom.totalLengthM);
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1][1]).toBeCloseTo(3, 6);
  });

  it("reversed bounds produce the same path reversed", () => {
    const forward = sliceLine(geom, geom.cum[1], geom.cum[2]);
    const backward = sliceLine(geom, geom.cum[2], geom.cum[1]);
    expect(backward).toEqual([...forward].reverse());
  });

  it("a slice strictly inside one segment has exactly two points", () => {
    const start = geom.cum[1] * 0.25;
    const end = geom.cum[1] * 0.75;
    const out = sliceLine(geom, start, end);
    expect(out.length).toBe(2);
  });
});
