// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import { setupWelcome, type WelcomeCallbacks } from "./welcome";

function mount(overrides: Partial<WelcomeCallbacks> = {}) {
  const host = document.createElement("section");
  const cb: WelcomeCallbacks = {
    open: vi.fn(),
    browse: vi.fn(),
    clone: vi.fn(),
    init: vi.fn(),
    workspaces: vi.fn(),
    favorites: () => ["/Users/me/code/app"],
    recent: () => ["/Users/me/code/app", "/Users/me/code/lib", "/srv/other"],
    ...overrides,
  };
  const handle = setupWelcome(host, cb);
  return { host, cb, handle };
}

const texts = (host: HTMLElement, sel: string) => [...host.querySelectorAll(sel)].map((n) => n.textContent);

describe("the welcome screen", () => {
  it("shows when no repository is open, and hides once one is", () => {
    const { host, handle } = mount();
    handle.sync(false);
    expect(host.classList.contains("hidden")).toBe(false);
    expect(host.querySelector(".welcome-brand")?.textContent).toBe("gitp");
    handle.sync(true);
    expect(host.classList.contains("hidden")).toBe(true);
    expect(host.children.length).toBe(0);
  });

  it("lists favorites with their key, then the other recent repositories as ~/ paths", () => {
    const { host, handle } = mount();
    handle.sync(false);
    expect(texts(host, ".welcome-list h3")).toEqual(["Favorites", "Recent"]);
    expect(texts(host, ".welcome-list:first-of-type .welcome-repo-name")).toEqual(["app"]);
    expect(texts(host, ".welcome-list:first-of-type kbd")).toEqual(["⌘1"]);
    // A favorite is not repeated under Recent.
    expect(texts(host, ".welcome-list:last-of-type .welcome-repo-path")).toEqual(["~/code/lib", "/srv/other"]);
  });

  it("opens a repository on click, and runs the actions", () => {
    const { host, cb, handle } = mount();
    handle.sync(false);
    host.querySelector<HTMLElement>(".welcome-list:last-of-type .welcome-repo")?.click();
    expect(cb.open).toHaveBeenCalledWith("/Users/me/code/lib");
    for (const [i, fn] of [cb.browse, cb.clone, cb.init, cb.workspaces].entries()) {
      host.querySelectorAll<HTMLElement>(".welcome-action")[i].click();
      expect(fn).toHaveBeenCalledOnce();
    }
  });

  it("says so when nothing has been opened yet", () => {
    const { host, handle } = mount({ favorites: () => [], recent: () => [] });
    handle.sync(false);
    expect(host.querySelector(".welcome-list")).toBeNull();
    expect(host.querySelector(".welcome-empty")?.textContent).toMatch(/show up here/);
  });
});
