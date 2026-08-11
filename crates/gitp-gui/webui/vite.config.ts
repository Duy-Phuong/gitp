import { defineConfig } from "vite";

// Tauri expects a fixed port and no clearScreen so its logs stay visible.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2021",
    outDir: "dist",
  },
});
