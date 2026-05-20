import L from "leaflet";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupPlanPanel } from "./plan-panel";
import type { RenderedRoute } from "./route-render";
import type { Place } from "./geocode";

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  document.body.innerHTML = "";
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ features: [] }),
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

function fakePlace(name: string, lat: number, lng: number): Place {
  return { id: name, name, fullName: `${name} full`, lat, lng };
}

function fakeRendered(map: L.Map, totalSec = 600): RenderedRoute {
  const layer = L.layerGroup();
  layer.addTo(map);
  return {
    layer,
    route: {
      totalSec,
      totalWalkM: 100,
      totalRailM: 200,
      legs: [
        {
          kind: "walk",
          role: "origin",
          fromLatLng: [41.0, 29.0],
          toLatLng: [41.001, 29.001],
          durationSec: 60,
          distM: 100,
        },
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
              lat: 41.001,
              lng: 29.001,
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
          durationSec: 540,
          distM: 200,
        },
      ],
    },
    itineraryHtml: `
      <span data-line-code="M2" data-line-kind="rail" data-leg-index="1">M2</span>
    `,
  };
}

describe("setupPlanPanel", () => {
  it("submitting without endpoints shows the pickEnds message", async () => {
    const map = makeMap();
    const container = document.createElement("div");
    document.body.appendChild(container);
    setupPlanPanel({
      container,
      map,
      planRoute: async () => null,
    });
    const form = container.querySelector<HTMLFormElement>("#route-form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const results = container.querySelector<HTMLElement>("#results")!;
    expect(results.classList.contains("hidden")).toBe(false);
    expect(results.textContent).toMatch(/(başlangıç|start)/i);
  });

  it("successful plan renders itinerary + invokes onRouteShown and onLegSelect", async () => {
    const map = makeMap();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const onRouteShown = vi.fn();
    const onLegSelect = vi.fn();
    const planRoute = vi.fn().mockImplementation(async () => fakeRendered(map));
    setupPlanPanel({
      container,
      map,
      planRoute,
      onRouteShown,
      onLegSelect,
    });
    // Simulate the panel having endpoints by triggering the start/end input
    // selection via the autocomplete onSelect callbacks. Easiest path is to
    // call setEndpoint indirectly: type and pick.
    const startInput = container.querySelector<HTMLInputElement>("#start-input")!;
    const endInput = container.querySelector<HTMLInputElement>("#end-input")!;
    // Stub fetch to return a single place per query
    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        features: [
          {
            geometry: { coordinates: [29 + calls * 0.01, 41 + calls * 0.01] },
            properties: { osm_id: ++calls, osm_type: "N", name: `P${calls}` },
          },
        ],
      }),
    })) as unknown as typeof fetch;

    vi.useFakeTimers();
    try {
      startInput.value = "Start";
      startInput.dispatchEvent(new Event("input"));
      await vi.advanceTimersByTimeAsync(400);
      container
        .querySelector<HTMLElement>("#start-row [role='option']")!
        .click();
      endInput.value = "End";
      endInput.dispatchEvent(new Event("input"));
      await vi.advanceTimersByTimeAsync(400);
      container
        .querySelector<HTMLElement>("#end-row [role='option']")!
        .click();
    } finally {
      vi.useRealTimers();
    }

    const form = container.querySelector<HTMLFormElement>("#route-form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    // The submit handler is async; wait a tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(planRoute).toHaveBeenCalled();
    expect(onRouteShown).toHaveBeenCalled();
    // Click the rail-line badge in the itinerary.
    container
      .querySelector<HTMLElement>("[data-line-code]")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onLegSelect).toHaveBeenCalledWith(
      "M2",
      "rail",
      expect.any(Array)
    );
  });

  it("renders the no-route message when planRoute returns null", async () => {
    const map = makeMap();
    const container = document.createElement("div");
    document.body.appendChild(container);
    setupPlanPanel({
      container,
      map,
      planRoute: async () => null,
    });
    // Programmatic setValue via autocomplete API to fake endpoints.
    const startInput = container.querySelector<HTMLInputElement>("#start-input")!;
    const endInput = container.querySelector<HTMLInputElement>("#end-input")!;
    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        features: [
          {
            geometry: { coordinates: [29 + calls * 0.01, 41 + calls * 0.01] },
            properties: { osm_id: ++calls, osm_type: "N", name: `P${calls}` },
          },
        ],
      }),
    })) as unknown as typeof fetch;

    vi.useFakeTimers();
    try {
      for (const i of [startInput, endInput]) {
        i.value = "Anywhere-here";
        i.dispatchEvent(new Event("input"));
        await vi.advanceTimersByTimeAsync(400);
        const anchor = i.closest("#start-row, #end-row")!;
        anchor.querySelector<HTMLElement>("[role='option']")!.click();
      }
    } finally {
      vi.useRealTimers();
    }

    const form = container.querySelector<HTMLFormElement>("#route-form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    const results = container.querySelector<HTMLElement>("#results")!;
    expect(results.innerHTML).toMatch(/(bulunamadı|No route)/);
  });

  it("renders an error message when planRoute throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const map = makeMap();
    const container = document.createElement("div");
    document.body.appendChild(container);
    setupPlanPanel({
      container,
      map,
      planRoute: async () => {
        throw new Error("boom");
      },
    });
    const startInput = container.querySelector<HTMLInputElement>("#start-input")!;
    const endInput = container.querySelector<HTMLInputElement>("#end-input")!;
    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        features: [
          {
            geometry: { coordinates: [29 + calls * 0.01, 41 + calls * 0.01] },
            properties: { osm_id: ++calls, osm_type: "N", name: `P${calls}` },
          },
        ],
      }),
    })) as unknown as typeof fetch;
    vi.useFakeTimers();
    try {
      for (const i of [startInput, endInput]) {
        i.value = "Throw-here";
        i.dispatchEvent(new Event("input"));
        await vi.advanceTimersByTimeAsync(400);
        const anchor = i.closest("#start-row, #end-row")!;
        anchor.querySelector<HTMLElement>("[role='option']")!.click();
      }
    } finally {
      vi.useRealTimers();
    }
    const form = container.querySelector<HTMLFormElement>("#route-form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    const results = container.querySelector<HTMLElement>("#results")!;
    expect(results.textContent).toMatch(/(ters gitti|wrong)/);
  });

  it("collapse button toggles plan body visibility", () => {
    const map = makeMap();
    const container = document.createElement("div");
    document.body.appendChild(container);
    setupPlanPanel({ container, map, planRoute: async () => null });
    const btn = container.querySelector<HTMLButtonElement>("#plan-collapse")!;
    const body = container.querySelector<HTMLDivElement>("#plan-body")!;
    btn.click();
    expect(body.classList.contains("hidden")).toBe(true);
    btn.click();
    expect(body.classList.contains("hidden")).toBe(false);
  });

  it("swap button swaps inputs and endpoint state", async () => {
    const map = makeMap();
    const container = document.createElement("div");
    document.body.appendChild(container);
    setupPlanPanel({ container, map, planRoute: async () => null });
    const startInput = container.querySelector<HTMLInputElement>("#start-input")!;
    const endInput = container.querySelector<HTMLInputElement>("#end-input")!;
    startInput.value = "A-only";
    endInput.value = "B-only";
    container.querySelector<HTMLButtonElement>("#swap-btn")!.click();
    expect(startInput.value).toBe("B-only");
    expect(endInput.value).toBe("A-only");
  });

  it("clear button resets inputs and URL params", () => {
    const map = makeMap();
    const container = document.createElement("div");
    document.body.appendChild(container);
    history.replaceState(null, "", "/?r=abc&s=1,1&e=2,2");
    const onClear = vi.fn();
    setupPlanPanel({ container, map, planRoute: async () => null, onClear });
    container.querySelector<HTMLButtonElement>("#plan-clear")!.click();
    expect(onClear).toHaveBeenCalled();
    expect(location.search).not.toContain("r=");
  });

  it("share button without endpoints flashes the empty message", () => {
    const map = makeMap();
    const container = document.createElement("div");
    document.body.appendChild(container);
    setupPlanPanel({ container, map, planRoute: async () => null });
    const share = container.querySelector<HTMLButtonElement>("#plan-share")!;
    share.click();
    expect(share.textContent).toMatch(/(Önce|Pick)/);
  });

  it("share button copies link when endpoints are set and active render exists", async () => {
    const map = makeMap();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const planRoute = vi.fn().mockImplementation(async () => fakeRendered(map));
    setupPlanPanel({ container, map, planRoute });
    const startInput = container.querySelector<HTMLInputElement>("#start-input")!;
    const endInput = container.querySelector<HTMLInputElement>("#end-input")!;
    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        features: [
          {
            geometry: { coordinates: [29 + calls * 0.01, 41 + calls * 0.01] },
            properties: { osm_id: ++calls, osm_type: "N", name: `P${calls}` },
          },
        ],
      }),
    })) as unknown as typeof fetch;
    vi.useFakeTimers();
    try {
      for (const i of [startInput, endInput]) {
        i.value = "PlaceX-now";
        i.dispatchEvent(new Event("input"));
        await vi.advanceTimersByTimeAsync(400);
        const anchor = i.closest("#start-row, #end-row")!;
        anchor.querySelector<HTMLElement>("[role='option']")!.click();
      }
    } finally {
      vi.useRealTimers();
    }
    // Share with endpoints but no active render → encodes coords.
    container.querySelector<HTMLButtonElement>("#plan-share")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(writeText).toHaveBeenCalled();
  });

  it("share falls back to prompt when clipboard rejects", async () => {
    const map = makeMap();
    const container = document.createElement("div");
    document.body.appendChild(container);
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: vi.fn().mockRejectedValue(new Error("blocked")),
      },
      configurable: true,
    });
    const promptSpy = vi.fn().mockReturnValue("");
    Object.defineProperty(window, "prompt", {
      value: promptSpy,
      configurable: true,
      writable: true,
    });
    setupPlanPanel({ container, map, planRoute: async () => null });
    const startInput = container.querySelector<HTMLInputElement>("#start-input")!;
    const endInput = container.querySelector<HTMLInputElement>("#end-input")!;
    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        features: [
          {
            geometry: { coordinates: [29 + calls * 0.01, 41 + calls * 0.01] },
            properties: { osm_id: ++calls, osm_type: "N", name: `P${calls}` },
          },
        ],
      }),
    })) as unknown as typeof fetch;
    vi.useFakeTimers();
    try {
      for (const i of [startInput, endInput]) {
        i.value = "PlaceY-now";
        i.dispatchEvent(new Event("input"));
        await vi.advanceTimersByTimeAsync(400);
        const anchor = i.closest("#start-row, #end-row")!;
        anchor.querySelector<HTMLElement>("[role='option']")!.click();
      }
    } finally {
      vi.useRealTimers();
    }
    container.querySelector<HTMLButtonElement>("#plan-share")!.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(promptSpy).toHaveBeenCalled();
  });

  it("destroy tears down all resources", () => {
    const map = makeMap();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const ctrl = setupPlanPanel({ container, map, planRoute: async () => null });
    ctrl.destroy();
    expect(container.innerHTML).toBe("");
  });
});
