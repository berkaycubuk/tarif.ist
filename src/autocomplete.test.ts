import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  document.body.innerHTML = "";
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis.fetch = ORIGINAL_FETCH;
});

function buildDOM() {
  const anchor = document.createElement("div");
  anchor.style.position = "relative";
  const input = document.createElement("input");
  anchor.appendChild(input);
  document.body.appendChild(anchor);
  return { anchor, input };
}

describe("setupAutocomplete", () => {
  it("shows the dropdown after typing and selects via Enter", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        features: [
          {
            geometry: { coordinates: [29.0, 41.0] },
            properties: { osm_id: 1, osm_type: "N", name: "Taksim" },
          },
          {
            geometry: { coordinates: [29.01, 41.01] },
            properties: { osm_id: 2, osm_type: "N", name: "Kabataş" },
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const { setupAutocomplete } = await import("./autocomplete");
    const { anchor, input } = buildDOM();
    const onSelect = vi.fn();
    const onClear = vi.fn();
    const ctrl = setupAutocomplete({ input, anchor, onSelect, onClear });

    input.value = "Taksim-auto";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(400);

    const options = anchor.querySelectorAll<HTMLElement>("[role='option']");
    expect(options.length).toBe(2);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onSelect).toHaveBeenCalledOnce();
    ctrl.destroy();
  });

  it("renders the no-matches message when results are empty", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ features: [] }),
    }) as unknown as typeof fetch;
    const { setupAutocomplete } = await import("./autocomplete");
    const { anchor, input } = buildDOM();
    setupAutocomplete({ input, anchor, onSelect: vi.fn(), onClear: vi.fn() });
    input.value = "no-such-place";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(400);
    expect(anchor.textContent).toContain("eşleşme");
  });

  it("clears dropdown when typing fewer than 2 chars after a result is showing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        features: [
          {
            geometry: { coordinates: [29, 41] },
            properties: { osm_id: 9, osm_type: "N", name: "Anywhere" },
          },
        ],
      }),
    }) as unknown as typeof fetch;
    const { setupAutocomplete } = await import("./autocomplete");
    const { anchor, input } = buildDOM();
    setupAutocomplete({ input, anchor, onSelect: vi.fn(), onClear: vi.fn() });
    input.value = "Anywhere-X";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(400);
    const dropdown = anchor.querySelector("div[role='listbox']")!;
    expect(dropdown.classList.contains("hidden")).toBe(false);
    input.value = "x";
    input.dispatchEvent(new Event("input"));
    expect(dropdown.classList.contains("hidden")).toBe(true);
  });

  it("clears selection and notifies via onClear when user types after selecting", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        features: [
          {
            geometry: { coordinates: [29, 41] },
            properties: { osm_id: 1, osm_type: "N", name: "Place" },
          },
        ],
      }),
    }) as unknown as typeof fetch;
    const { setupAutocomplete } = await import("./autocomplete");
    const { anchor, input } = buildDOM();
    const onSelect = vi.fn();
    const onClear = vi.fn();
    const ctrl = setupAutocomplete({ input, anchor, onSelect, onClear });
    input.value = "Place-selSel";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(400);
    // Click the option
    const opt = anchor.querySelector<HTMLElement>("[role='option']")!;
    opt.click();
    expect(onSelect).toHaveBeenCalled();
    // The first input event is suppressed by pick(); the second carries the
    // user's edit and should clear the selection.
    input.dispatchEvent(new Event("input"));
    input.value = "Place-selSel-changed";
    input.dispatchEvent(new Event("input"));
    expect(onClear).toHaveBeenCalled();
    ctrl.destroy();
  });

  it("setValue and clear suppress side effects", async () => {
    const { setupAutocomplete } = await import("./autocomplete");
    const { anchor, input } = buildDOM();
    const onClear = vi.fn();
    const ctrl = setupAutocomplete({
      input,
      anchor,
      onSelect: vi.fn(),
      onClear,
    });
    ctrl.setValue({
      id: "x",
      name: "Taksim",
      fullName: "Taksim, İstanbul",
      lat: 41,
      lng: 29,
    });
    expect(input.value).toBe("Taksim");
    // The next input event should be suppressed (no onClear fired).
    input.dispatchEvent(new Event("input"));
    expect(onClear).not.toHaveBeenCalled();
    ctrl.clear();
    ctrl.destroy();
  });

  it("Escape closes the dropdown", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        features: [
          {
            geometry: { coordinates: [29, 41] },
            properties: { osm_id: 1, osm_type: "N", name: "Esc-Place" },
          },
        ],
      }),
    }) as unknown as typeof fetch;
    const { setupAutocomplete } = await import("./autocomplete");
    const { anchor, input } = buildDOM();
    setupAutocomplete({ input, anchor, onSelect: vi.fn(), onClear: vi.fn() });
    input.value = "Esc-Place-X";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(400);
    const dropdown = anchor.querySelector("div[role='listbox']")!;
    expect(dropdown.classList.contains("hidden")).toBe(false);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(dropdown.classList.contains("hidden")).toBe(true);
  });

  it("ArrowDown opens a closed dropdown when results are already cached", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        features: [
          {
            geometry: { coordinates: [29, 41] },
            properties: { osm_id: 1, osm_type: "N", name: "Arrow-Place" },
          },
        ],
      }),
    }) as unknown as typeof fetch;
    const { setupAutocomplete } = await import("./autocomplete");
    const { anchor, input } = buildDOM();
    setupAutocomplete({ input, anchor, onSelect: vi.fn(), onClear: vi.fn() });
    input.value = "Arrow-Place-XX";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(400);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    const dropdown = anchor.querySelector("div[role='listbox']")!;
    expect(dropdown.classList.contains("hidden")).toBe(true);
    // ArrowDown re-opens.
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(dropdown.classList.contains("hidden")).toBe(false);
  });

  it("focus re-opens dropdown when results exist", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        features: [
          {
            geometry: { coordinates: [29, 41] },
            properties: { osm_id: 1, osm_type: "N", name: "Focus-Place" },
          },
        ],
      }),
    }) as unknown as typeof fetch;
    const { setupAutocomplete } = await import("./autocomplete");
    const { anchor, input } = buildDOM();
    setupAutocomplete({ input, anchor, onSelect: vi.fn(), onClear: vi.fn() });
    input.value = "Focus-Place-XX";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(400);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    input.dispatchEvent(new Event("focus"));
    const dropdown = anchor.querySelector("div[role='listbox']")!;
    expect(dropdown.classList.contains("hidden")).toBe(false);
  });

  it("closes when clicking outside the anchor", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        features: [
          {
            geometry: { coordinates: [29, 41] },
            properties: { osm_id: 1, osm_type: "N", name: "Outside" },
          },
        ],
      }),
    }) as unknown as typeof fetch;
    const { setupAutocomplete } = await import("./autocomplete");
    const { anchor, input } = buildDOM();
    setupAutocomplete({ input, anchor, onSelect: vi.fn(), onClear: vi.fn() });
    input.value = "Outside-XX";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(400);
    const dropdown = anchor.querySelector("div[role='listbox']")!;
    expect(dropdown.classList.contains("hidden")).toBe(false);
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(dropdown.classList.contains("hidden")).toBe(true);
  });

  it("renders the error message on geocode failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("photon down"))
      .mockRejectedValueOnce(new Error("nominatim down")) as unknown as typeof fetch;
    const { setupAutocomplete } = await import("./autocomplete");
    const { anchor, input } = buildDOM();
    setupAutocomplete({ input, anchor, onSelect: vi.fn(), onClear: vi.fn() });
    input.value = "Error-Place-XX";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(400);
    expect(anchor.textContent).toContain("başarısız");
  });

  it("ignores AbortError silently", async () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    globalThis.fetch = vi.fn().mockRejectedValueOnce(err) as unknown as typeof fetch;
    const { setupAutocomplete } = await import("./autocomplete");
    const { anchor, input } = buildDOM();
    setupAutocomplete({ input, anchor, onSelect: vi.fn(), onClear: vi.fn() });
    input.value = "Abort-Place-XX";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(400);
    // No error UI — but also no results.
    expect(anchor.querySelector("[role='option']")).toBeNull();
  });
});
