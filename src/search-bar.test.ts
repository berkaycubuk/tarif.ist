import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupSearchBar, type SearchItem } from "./search-bar";

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

function build(items: SearchItem[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const onSelect = vi.fn();
  const onClear = vi.fn();
  const bar = setupSearchBar({
    container,
    getItems: () => items,
    onSelect,
    onClear,
  });
  const input = container.querySelector<HTMLInputElement>("#searchbar-input")!;
  const dropdown = container.querySelector<HTMLDivElement>("#searchbar-dropdown")!;
  const clearBtn = container.querySelector<HTMLButtonElement>("#searchbar-clear")!;
  return { container, bar, onSelect, onClear, input, dropdown, clearBtn };
}

const railItem: SearchItem = { kind: "rail", code: "M2", name: "Yenikapı – Hacıosman" };
const railItem2: SearchItem = { kind: "rail", code: "M3", name: "Kirazlı – Olimpiyat" };
const busItem: SearchItem = {
  kind: "bus",
  entry: { code: "55A", longName: "Sarıyer - Kabataş", file: "55A.geojson" },
};

describe("setupSearchBar", () => {
  it("renders results on focus and supports keyboard navigation + Enter", () => {
    const { input, dropdown, onSelect } = build([railItem, railItem2, busItem]);
    input.dispatchEvent(new Event("focus"));
    expect(dropdown.classList.contains("hidden")).toBe(false);
    expect(dropdown.querySelectorAll("[data-idx]").length).toBe(3);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("renders the no-matches message when query has no hits", () => {
    const { input, dropdown } = build([railItem]);
    input.value = "nothing here";
    input.dispatchEvent(new Event("input"));
    expect(dropdown.textContent).toContain("Eşleşen hat yok");
  });

  it("clicking the clear button fires onClear and refocuses input", () => {
    const { input, clearBtn, onClear, bar } = build([railItem]);
    bar.setLabel("M2 · Foo");
    expect(input.value).toBe("M2 · Foo");
    expect(clearBtn.classList.contains("hidden")).toBe(false);
    clearBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClear).toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("click-on-row commits and labels the selection", () => {
    const { input, dropdown, onSelect } = build([railItem, busItem]);
    input.dispatchEvent(new Event("focus"));
    const row = dropdown.querySelector<HTMLButtonElement>("[data-idx='1']")!;
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    row.click();
    expect(onSelect).toHaveBeenCalled();
    expect(input.value).toContain("55A");
  });

  it("Escape closes dropdown first, then clears when invoked again", () => {
    const { input, dropdown, onClear } = build([railItem]);
    input.dispatchEvent(new Event("focus"));
    input.value = "M";
    input.dispatchEvent(new Event("input"));
    expect(dropdown.classList.contains("hidden")).toBe(false);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(dropdown.classList.contains("hidden")).toBe(true);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClear).toHaveBeenCalled();
  });

  it("Escape with empty input + hidden dropdown blurs the field", () => {
    const { input } = build([railItem]);
    const blurSpy = vi.spyOn(input, "blur");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(blurSpy).toHaveBeenCalled();
  });

  it("scoring prefers exact code matches, then prefix, then name", () => {
    const items: SearchItem[] = [
      { kind: "rail", code: "M2", name: "Hacıosman line" },
      { kind: "rail", code: "M22", name: "Other" },
      { kind: "rail", code: "X", name: "Long-prefix m2 example" },
    ];
    const { input, dropdown } = build(items);
    input.value = "m2";
    input.dispatchEvent(new Event("input"));
    const rows = [...dropdown.querySelectorAll<HTMLElement>("[data-idx]")];
    expect(rows[0].textContent).toContain("M2");
  });

  it("refresh re-renders only while the input is focused", () => {
    let items: SearchItem[] = [railItem];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const bar = setupSearchBar({
      container,
      getItems: () => items,
      onSelect: vi.fn(),
      onClear: vi.fn(),
    });
    const input = container.querySelector<HTMLInputElement>("#searchbar-input")!;
    const dropdown = container.querySelector<HTMLDivElement>("#searchbar-dropdown")!;
    items = [railItem, railItem2, busItem];
    bar.refresh();
    // No focus → no re-render.
    expect(dropdown.querySelectorAll("[data-idx]").length).toBe(0);
    input.focus();
    input.dispatchEvent(new Event("focus"));
    bar.refresh();
    expect(dropdown.querySelectorAll("[data-idx]").length).toBe(3);
    bar.destroy();
    expect(container.innerHTML).toBe("");
  });

  it("mouseenter on a row updates the active selection", () => {
    const { input, dropdown } = build([railItem, railItem2]);
    input.dispatchEvent(new Event("focus"));
    const second = dropdown.querySelector<HTMLElement>("[data-idx='1']")!;
    second.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(second.className).toContain("bg-slate-100");
  });

  it("clicking outside the bar closes the dropdown", () => {
    const { input, dropdown } = build([railItem]);
    input.dispatchEvent(new Event("focus"));
    expect(dropdown.classList.contains("hidden")).toBe(false);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(dropdown.classList.contains("hidden")).toBe(true);
  });
});
