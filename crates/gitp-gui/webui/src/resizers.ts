// Draggable dividers: sidebar width, log pane height, terminal height.

import { $ } from "./dom";
import { ui } from "./app-state";

// Drag the divider above the terminal to resize it; the panel grows upward, so
// dragging up makes it taller.
export function setupTerminalResizer(): void {
  const divider = $("#terminal-divider");
  const app = $("#app");
  const MIN = 80;
  // Leave the rest of the window usable no matter how far the drag goes.
  const MAX_FRACTION = 0.8;
  let dragging = false;

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    const rect = app.getBoundingClientRect();
    // A collapsed or minimised window measures zero, and clamping against that
    // would snap the panel to its minimum and lose the user's chosen height.
    if (rect.height <= 0) return;
    // The status bar sits below the terminal, so measure from the panel's own
    // bottom rather than the window's.
    const bottom = $("#terminal-panel").getBoundingClientRect().bottom;
    const max = rect.height * MAX_FRACTION;
    const height = Math.max(MIN, Math.min(max, bottom - e.clientY));
    app.style.setProperty("--term-h", `${height}px`);
    ui.terminal?.fit();
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove("dragging");
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    ui.terminal?.fit();
  };

  divider.addEventListener("mousedown", (e) => {
    dragging = true;
    divider.classList.add("dragging");
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    e.preventDefault();
  });
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", stop);
}

// Drag the divider to resize the log pane; the detail pane below fills the rest.
export function setupPaneResizer(): void {
  const view = $("#history-view");
  const divider = $("#pane-divider");
  const MIN_LOG = 160;
  const MIN_DETAIL = 200;
  let dragging = false;

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    const rect = view.getBoundingClientRect();
    const max = rect.height - MIN_DETAIL - 6;
    const height = Math.max(MIN_LOG, Math.min(max, e.clientY - rect.top));
    view.style.setProperty("--log-h", `${height}px`);
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove("dragging");
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  };

  divider.addEventListener("mousedown", (e) => {
    dragging = true;
    divider.classList.add("dragging");
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    e.preventDefault();
  });
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", stop);
}

// Drag the sidebar divider to resize the sidebar; the main panel fills the rest.
export function setupSidebarResizer(): void {
  const content = $(".content");
  const divider = $("#sidebar-divider");
  const MIN = 180;
  const MAX = 480;
  let dragging = false;

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    const rect = content.getBoundingClientRect();
    const width = Math.max(MIN, Math.min(MAX, e.clientX - rect.left));
    content.style.setProperty("--sidebar-w", `${width}px`);
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove("dragging");
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  };

  divider.addEventListener("mousedown", (e) => {
    dragging = true;
    divider.classList.add("dragging");
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    e.preventDefault();
  });
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", stop);
}
