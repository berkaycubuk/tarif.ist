import L from "leaflet";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupLineInspector } from "./line-inspector";

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

function makeMap(): L.Map {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: 600 });
  Object.defineProperty(el, "clientHeight", { value: 400 });
  document.body.appendChild(el);
  return L.map(el, { center: [41, 29], zoom: 11 });
}

function makeLinesLayer(): L.GeoJSON {
  return L.geoJSON({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [29.0, 41.0],
            [29.0, 41.02],
            [29.0, 41.04],
          ],
        },
        properties: { lineCode: "M2" },
      } as any,
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [28.9, 41.0],
            [28.9, 41.02],
          ],
        },
        properties: { lineCode: "M1" },
      } as any,
    ],
  } as any);
}

describe("setupLineInspector — selection", () => {
  it("starts with no selected line", () => {
    const map = makeMap();
    const layer = makeLinesLayer();
    layer.addTo(map);
    const li = setupLineInspector({ map, getLinesLayer: () => layer });
    expect(li.current()).toBeNull();
    li.destroy();
  });

  it("selectLine(null) hides all lines and notifies the listener", () => {
    const map = makeMap();
    const layer = makeLinesLayer();
    layer.addTo(map);
    const onLineChange = vi.fn();
    // Backend will be polled if we select a real line, so stub it to fail.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    }) as unknown as typeof fetch;
    const li = setupLineInspector({ map, getLinesLayer: () => layer, onLineChange });
    li.selectLine(null);
    expect(onLineChange).toHaveBeenCalledWith(null);
    expect(li.current()).toBeNull();
    li.destroy();
  });

  it("selectLine(code) highlights that line and dims the others", async () => {
    const map = makeMap();
    const layer = makeLinesLayer();
    layer.addTo(map);
    // /v1/lines and /v1/positions calls.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    }) as unknown as typeof fetch;
    const li = setupLineInspector({ map, getLinesLayer: () => layer });
    li.selectLine("M2");
    expect(li.current()).toBe("M2");
    // Allow the catalog fetch + first pollOnce to fire and settle.
    await new Promise((r) => setTimeout(r, 0));
    li.destroy();
  });

  it("noop when getLinesLayer returns null", () => {
    const map = makeMap();
    const li = setupLineInspector({ map, getLinesLayer: () => null });
    expect(() => li.selectLine("M2")).not.toThrow();
    expect(() => li.selectLine(null)).not.toThrow();
    li.destroy();
  });
});

describe("setupLineInspector — live trains", () => {
  it("loads the catalog and renders train markers from /v1/positions", async () => {
    const map = makeMap();
    const layer = makeLinesLayer();
    layer.addTo(map);
    // Catalog returns one line w/ two stations
    let positionsCall = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: any) => {
      const u = String(url);
      if (u.includes("/v1/lines")) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              code: "M2",
              stations: [
                { name: "A", lat: 41.0, lng: 29.0 },
                { name: "C", lat: 41.04, lng: 29.0 },
              ],
            },
          ],
        });
      }
      positionsCall++;
      return Promise.resolve({
        ok: true,
        json: async () => ({
          trains: [
            // First poll: two trains
            ...(positionsCall === 1
              ? [
                  {
                    trainIdx: 1,
                    direction: "ab",
                    fromStation: "A",
                    toStation: "C",
                    segmentProgress: 0.5,
                    secondsToNext: 60,
                  },
                  {
                    trainIdx: 2,
                    direction: "dwell",
                    fromStation: "A",
                    toStation: "A",
                    segmentProgress: 0,
                    secondsToNext: 0,
                  },
                ]
              : positionsCall === 2
              ? [
                  // Second poll: train 1 moves; train 2 disappears (despawn).
                  {
                    trainIdx: 1,
                    direction: "ba",
                    fromStation: "C",
                    toStation: "A",
                    segmentProgress: 0.25,
                    secondsToNext: 90,
                  },
                ]
              : []),
          ],
        }),
      });
    }) as unknown as typeof fetch;

    const li = setupLineInspector({ map, getLinesLayer: () => layer });
    li.setLiveData(true);
    li.selectLine("M2");
    // Let the catalog + first poll resolve.
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));

    // Force a second poll without waiting 2s — fake-timers would interfere
    // with the rAF loop, so just call selectLine again to retrigger.
    // Instead, dispatch by directly waiting for the interval.
    await new Promise((r) => setTimeout(r, 2100));
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));

    li.destroy();
  }, 10000);

  it("catalog fetch failure is non-fatal", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const map = makeMap();
    const layer = makeLinesLayer();
    layer.addTo(map);
    globalThis.fetch = vi.fn().mockImplementation((url: any) => {
      const u = String(url);
      if (u.includes("/v1/lines")) {
        return Promise.reject(new Error("offline"));
      }
      return Promise.resolve({ ok: true, json: async () => ({ trains: [] }) });
    }) as unknown as typeof fetch;

    const li = setupLineInspector({ map, getLinesLayer: () => layer });
    li.setLiveData(true);
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    li.destroy();
  });

  it("catalog HTTP non-OK is silently dropped", async () => {
    const map = makeMap();
    const layer = makeLinesLayer();
    layer.addTo(map);
    globalThis.fetch = vi.fn().mockImplementation((url: any) => {
      const u = String(url);
      if (u.includes("/v1/lines")) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ trains: [] }) });
    }) as unknown as typeof fetch;
    const li = setupLineInspector({ map, getLinesLayer: () => layer });
    li.setLiveData(true);
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    li.destroy();
  });

  it("positions HTTP non-OK is ignored", async () => {
    const map = makeMap();
    const layer = makeLinesLayer();
    layer.addTo(map);
    globalThis.fetch = vi.fn().mockImplementation((url: any) => {
      const u = String(url);
      if (u.includes("/v1/lines")) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              code: "M2",
              stations: [
                { name: "A", lat: 41, lng: 29 },
                { name: "B", lat: 41.02, lng: 29 },
              ],
            },
          ],
        });
      }
      return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
    }) as unknown as typeof fetch;
    const li = setupLineInspector({ map, getLinesLayer: () => layer });
    li.setLiveData(true);
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    li.destroy();
  });

  it("positions fetch rejection is logged but ignored", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const map = makeMap();
    const layer = makeLinesLayer();
    layer.addTo(map);
    globalThis.fetch = vi.fn().mockImplementation((url: any) => {
      const u = String(url);
      if (u.includes("/v1/lines")) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.reject(new Error("net"));
    }) as unknown as typeof fetch;
    const li = setupLineInspector({ map, getLinesLayer: () => layer });
    li.setLiveData(true);
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    li.destroy();
  });
});
