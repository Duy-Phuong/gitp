import { describe, expect, it } from "vitest";

import { formatBytes, imageMime } from "./image-diff";

describe("imageMime", () => {
  it("knows image extensions, in any case", () => {
    expect(imageMime("logo.png")).toBe("image/png");
    expect(imageMime("assets/Photo.JPG")).toBe("image/jpeg");
    expect(imageMime("a/b/icon.svg")).toBe("image/svg+xml");
    expect(imageMime("favicon.ico")).toBe("image/x-icon");
  });

  it("refuses other files, and dots that aren't an extension", () => {
    expect(imageMime("main.rs")).toBeNull();
    expect(imageMime("png")).toBeNull();
    expect(imageMime(".png")).toBeNull();
    expect(imageMime("img.png/readme")).toBeNull();
  });
});

describe("formatBytes", () => {
  it("picks a unit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(12.5 * 1024 * 1024)).toBe("12.5 MB");
  });
});
