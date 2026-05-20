import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  document.body.innerHTML = "";
  Object.defineProperty(window, "location", {
    value: { ...window.location, reload: vi.fn(), assign: vi.fn() },
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("setupSettings", () => {
  it("mounts the cog button", async () => {
    const { setupSettings } = await import("./settings-modal");
    setupSettings();
    expect(document.getElementById("settings-button")).not.toBeNull();
  });

  it("opens the modal on click and renders language + theme segments", async () => {
    const { setupSettings } = await import("./settings-modal");
    setupSettings();
    const btn = document.getElementById("settings-button") as HTMLButtonElement;
    btn.click();
    expect(document.querySelector("[role='dialog']")).not.toBeNull();
    expect(document.querySelectorAll('[data-group="lang"] button').length).toBe(2);
    expect(document.querySelectorAll('[data-group="theme"] button').length).toBe(3);
  });

  it("clicking a theme segment updates the active styling", async () => {
    const { setupSettings } = await import("./settings-modal");
    setupSettings();
    (document.getElementById("settings-button") as HTMLButtonElement).click();
    const darkBtn = document.querySelector<HTMLButtonElement>(
      '[data-group="theme"] [data-value="dark"]'
    )!;
    darkBtn.click();
    expect(darkBtn.className).toContain("bg-sky-500");
  });

  it("clicking a language segment calls setLang (which reloads the page)", async () => {
    const { setupSettings } = await import("./settings-modal");
    setupSettings();
    (document.getElementById("settings-button") as HTMLButtonElement).click();
    const en = document.querySelector<HTMLButtonElement>(
      '[data-group="lang"] [data-value="en"]'
    )!;
    en.click();
    expect((window.location as any).reload).toHaveBeenCalled();
  });

  it("Escape and close button dismiss the overlay", async () => {
    const { setupSettings } = await import("./settings-modal");
    const ctrl = setupSettings();
    const btn = document.getElementById("settings-button") as HTMLButtonElement;
    btn.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector("[role='dialog']")).toBeNull();
    btn.click();
    (document.getElementById("settings-close") as HTMLButtonElement).click();
    expect(document.querySelector("[role='dialog']")).toBeNull();
    btn.click();
    // Backdrop click
    const overlay = document.querySelector("[role='dialog']")!.parentElement!;
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector("[role='dialog']")).toBeNull();
    ctrl.destroy();
    expect(document.getElementById("settings-button")).toBeNull();
  });

  it("opening twice is a no-op", async () => {
    const { setupSettings } = await import("./settings-modal");
    setupSettings();
    const btn = document.getElementById("settings-button") as HTMLButtonElement;
    btn.click();
    btn.click();
    expect(document.querySelectorAll("[role='dialog']").length).toBe(1);
  });
});
