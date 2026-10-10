/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";

// ブラウザは /ws につなぐ。play が開く WebSocket（既定 4319）へ proxy するので、ブラウザ側はポートを持たない。
const port = process.env.LIVE_MINDMAP_PORT ?? "4319";
const headers = { "Content-Security-Policy": "connect-src 'self'" };

const IT = "**/*.it.test.?(c|m)[jt]s?(x)";
const HEAVY = "**/*.heavy.test.?(c|m)[jt]s?(x)";

export default defineConfig({
  plugins: [react()],
  // 層はファイル名の接尾辞で決める: foo.test.ts = unit、foo.it.test.ts = 軽い IT、foo.heavy.test.ts = 重い IT（web の typecheck が server/scripts/check-test-layers.ts で、unit が本物の資源を直接 import していないか点検する）
  test: {
    projects: [
      { extends: true, test: { name: "unit", exclude: [...configDefaults.exclude, IT, HEAVY] } },
      { extends: true, test: { name: "it", include: [IT] } },
      { extends: true, test: { name: "heavy", include: [HEAVY] } },
    ],
  },
  server: { headers, proxy: { "/ws": { target: `ws://127.0.0.1:${port}`, ws: true, rewrite: () => "/" } } },
  preview: { headers },
});
