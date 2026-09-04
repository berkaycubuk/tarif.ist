import { afterEach, describe, expect, it } from "vitest";
import { setupInfo } from "./info-modal";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("setupInfo", () => {
  it("mounts the info button to the document", () => {
    setupInfo();
    expect(document.getElementById("info-button")).not.toBeNull();
  });

  it("opens an overlay when the button is clicked", () => {
    setupInfo();
    const btn = document.getElementById("info-button") as HTMLButtonElement;
    btn.click();
    const overlay = document.querySelector("[role='dialog']");
    expect(overlay).not.toBeNull();
  });

  it("does not double-mount the overlay on repeated open calls", () => {
    setupInfo();
    const btn = document.getElementById("info-button") as HTMLButtonElement;
    btn.click();
    btn.click();
    expect(document.querySelectorAll("[role='dialog']").length).toBe(1);
  });

  it("closes on Escape", () => {
    setupInfo();
    const btn = document.getElementById("info-button") as HTMLButtonElement;
    btn.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector("[role='dialog']")).toBeNull();
  });

  it("closes when the close button is clicked", () => {
    setupInfo();
    const btn = document.getElementById("info-button") as HTMLButtonElement;
    btn.click();
    const close = document.getElementById("info-close") as HTMLButtonElement;
    close.click();
    expect(document.querySelector("[role='dialog']")).toBeNull();
  });

  it("closes when the backdrop is clicked", () => {
    setupInfo();
    (document.getElementById("info-button") as HTMLButtonElement).click();
    const overlay = document.querySelector("[role='dialog']")!.parentElement!;
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector("[role='dialog']")).toBeNull();
  });

  it("destroy removes the button and any open overlay", () => {
    const ctrl = setupInfo();
    const btn = document.getElementById("info-button") as HTMLButtonElement;
    btn.click();
    ctrl.destroy();
    expect(document.getElementById("info-button")).toBeNull();
    expect(document.querySelector("[role='dialog']")).toBeNull();
  });
});

describe("setupInfo — prerendered page links", () => {
  // The generated /hat/ and /durak/ pages are only reachable from the SPA
  // through these two links. Without them the whole batch is orphaned, which
  // is a common reason a large set of pages never gets crawled.
  it("links to the line and station indexes", () => {
    setupInfo();
    (document.getElementById("info-button") as HTMLButtonElement).click();
    const hrefs = [
      ...document.querySelectorAll<HTMLAnchorElement>("[role='dialog'] a"),
    ].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/hat/");
    expect(hrefs).toContain("/durak/");
  });
});
