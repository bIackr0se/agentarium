import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import agentariumApiPlugin from "./server/vite-plugin.mjs";

export default defineConfig(({ command, mode }) => ({
  plugins: [
    react(),
    ...(command === "serve" && mode !== "test" ? [agentariumApiPlugin()] : []),
  ],
  server: {
    host: "127.0.0.1",
    port: 4173,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
  test: {
    environment: "jsdom",
    globals: true,
    css: false,
    clearMocks: true,
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["tests/**", "node_modules/**", "dist/**"],
  },
}));
