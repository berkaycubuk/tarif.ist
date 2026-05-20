import L from "leaflet";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupRouteViewer } from "./route-viewer";
import type { RenderedRoute } from "./route-render";

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  document.body.innerHTML = "";
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({}),
  }) as unknown as typeof fetch;
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

function fakeRendered(map: L.Map): RenderedRoute {
  const layer = L.layerGroup();
  layer.addTo(map);
  return {
    layer,
    route: {
      totalSec: 600,
      totalWalkM: 100,
      totalRailM: 200,
      legs: [
        {
          kind: "rail",
          lineCode: "M2",
          fromName: "A",
          toName: "B",
          stations: [
            {
              id: "M2#0",
              mode: "rail",
              stationName: "A",
              lineCode: "M2",
              kind: "Metro",
              lat: 41,
              lng: 29,
              cumDistOnLine: 0,
            },
            {
              id: "M2#1",
              mode: "rail",
              stationName: "B",
              lineCode: "M2",
              kind: "Metro",
              lat: 41.01,
              lng: 29.01,
              cumDistOnLine: 0,
            },
          ],
          durationSec: 300,
          distM: 1000,
        },
        {
          kind: "bus",
          lineCode: "55A",
          fromName: "X",
          toName: "Y",
          stations: [
            {
              id: "bus#1",
              mode: "bus",
              stationName: "X",
              lineCode: "",
              kind: "Bus",
              lat: 41.01,
              lng: 29.01,
              cumDistOnLine: 0,
            },
            {
              id: "bus#2",
              mode: "bus",
              stationName: "Y",
              lineCode: "",
              kind: "Bus",
              lat: 41.02,
              lng: 29.02,
              cumDistOnLine: 0,
            },
          ],
          durationSec: 300,
          distM: 1100,
        },
      ],
    },
    itineraryHtml: `
      <span data-line-code="M2" data-line-kind="rail" data-leg-index="0">M2</span>
      <span data-line-code="55A" data-line-kind="bus" data-leg-index="1">55A</span>
    `,
  };
}

describe("setupRouteViewer", () => {
  it("mounts the panel, renders the route, and fires onRouteShown + onLegSelect", async () => {
    // First two fetches are reverseGeocode calls — return null bodies; the
    // route fetch itself doesn't happen because we provide a fake planRoute.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }) as unknown as typeof fetch;
    const map = makeMap();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const onRouteShown = vi.fn();
    const onLegSelect = vi.fn();
    const planRoute = vi.fn().mockImplementation(async () => fakeRendered(map));
    setupRouteViewer({
      container,
      map,
      start: { lat: 41.41, lng: 29.41 },
      end: { lat: 41.42, lng: 29.42 },
      planRoute,
      onLegSelect,
      onRouteShown,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(planRoute).toHaveBeenCalled();
    expect(onRouteShown).toHaveBeenCalled();
    container
      .querySelector<HTMLElement>("[data-line-code='M2']")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onLegSelect).toHaveBeenCalledWith("M2", "rail", expect.any(Array));
    container
      .querySelector<HTMLElement>("[data-line-code='55A']")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onLegSelect).toHaveBeenCalledWith("55A", "bus", expect.any(Array));
  });

  it("updates labels when reverse geocoding succeeds", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          place_id: 1,
          display_name: "Taksim, İstanbul",
          lat: "41",
          lon: "29",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          place_id: 2,
          display_name: "Kabataş, İstanbul",
          lat: "41.02",
          lon: "29.02",
        }),
      }) as unknown as typeof fetch;
    const map = makeMap();
    const container = document.createElement("div");
    document.body.appendChild(container);
    setupRouteViewer({
      container,
      map,
      start: { lat: 42.11, lng: 30.11 },
      end: { lat: 42.12, lng: 30.12 },
      planRoute: async () => fakeRendered(map),
    });
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toContain("Taksim");
    expect(container.textContent).toContain("Kabataş");
  });

  it("shows the noRoute panel when planRoute returns null", async () => {
    const map = makeMap();
    const container = document.createElement("div");
    document.body.appendChild(container);
    setupRouteViewer({
      container,
      map,
      start: { lat: 41.41, lng: 29.41 },
      end: { lat: 41.42, lng: 29.42 },
      planRoute: async () => null,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toMatch(/(bulunamadı|No route)/);
  });

  it("shows the error panel when planRoute throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const map = makeMap();
    const container = document.createElement("div");
    document.body.appendChild(container);
    setupRouteViewer({
      container,
      map,
      start: { lat: 41.41, lng: 29.41 },
      end: { lat: 41.42, lng: 29.42 },
      planRoute: async () => {
        throw new Error("boom");
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toMatch(/(ters gitti|wrong)/);
  });

  it("collapse toggles body, exit + destroy clean up", async () => {
    const map = makeMap();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const onExit = vi.fn();
    const ctrl = setupRouteViewer({
      container,
      map,
      start: { lat: 41.41, lng: 29.41 },
      end: { lat: 41.42, lng: 29.42 },
      planRoute: async () => fakeRendered(map),
      onExit,
    });
    container.querySelector<HTMLButtonElement>("#viewer-collapse")!.click();
    expect(
      container.querySelector<HTMLElement>("#viewer-body")!.classList.contains("hidden")
    ).toBe(true);
    container.querySelector<HTMLButtonElement>("#viewer-collapse")!.click();
    container.querySelector<HTMLButtonElement>("#viewer-exit")!.click();
    expect(onExit).toHaveBeenCalled();
    ctrl.destroy();
    expect(container.innerHTML).toBe("");
  });
});
