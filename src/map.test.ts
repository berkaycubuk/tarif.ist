import L from "leaflet";
import { beforeEach, describe, expect, it } from "vitest";
import { ISTANBUL_BOUNDS, ISTANBUL_CENTER, createMap, makeEndpointMarker } from "./map";
import { setThemePreference } from "./theme";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("createMap", () => {
  it("creates a leaflet map centered on Istanbul", () => {
    const el = document.createElement("div");
    Object.defineProperty(el, "clientWidth", { value: 600 });
    Object.defineProperty(el, "clientHeight", { value: 400 });
    document.body.appendChild(el);
    const map = createMap(el);
    expect(map).toBeDefined();
    expect(map.getCenter().lat).toBeCloseTo(ISTANBUL_CENTER[0], 3);
    expect(map.getCenter().lng).toBeCloseTo(ISTANBUL_CENTER[1], 3);
    expect(ISTANBUL_BOUNDS.length).toBe(2);
    // Theme switch fires the subscriber and swaps tile layers without errors.
    setThemePreference("dark");
    setThemePreference("light");
    map.remove();
  });
});

describe("makeEndpointMarker", () => {
  it("returns a marker with the start (emerald) color", () => {
    const m = makeEndpointMarker("start", [41, 29]);
    const icon = m.options.icon as L.DivIcon;
    expect(icon).toBeDefined();
    expect(String((icon as any).options.html)).toContain("#10b981");
  });
  it("returns a marker with the end (rose) color", () => {
    const m = makeEndpointMarker("end", [41, 29]);
    const icon = m.options.icon as L.DivIcon;
    expect(String((icon as any).options.html)).toContain("#ef4444");
  });
});
