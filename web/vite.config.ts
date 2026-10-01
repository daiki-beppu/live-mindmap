import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// ブラウザは /ws につなぐ。play が開く WebSocket（既定 4319）へ proxy するので、ブラウザ側はポートを持たない。
const port = process.env.LIVE_MINDMAP_PORT ?? "4319";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/ws": { target: `ws://127.0.0.1:${port}`, ws: true, rewrite: () => "/" } } },
});
