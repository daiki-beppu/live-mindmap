/// <reference types="vitest/config" />
import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";

const port = process.env.LIVE_MINDMAP_PORT ?? "4319";
const headers = { "Content-Security-Policy": "connect-src 'self'" };

const IT = "**/*.it.test.?(c|m)[jt]s?(x)";
const HEAVY = "**/*.heavy.test.?(c|m)[jt]s?(x)";

// foldkit() の view-identity 変換は全モジュールの関数の返り値を包み import を足すので、vi.hoisted を使う unit テストが壊れる。vitest の mode（"test"）では外す。
export default defineConfig(({ mode }) => {
  const plugins = mode === "test" ? [] : foldkit();
  for (const plugin of plugins) {
    if (plugin.name !== "foldkit") continue;
    const reload = plugin.handleHotUpdate;
    if (typeof reload !== "function") throw new Error("Foldkit の handleHotUpdate がありません");
    // Foldkit reloads the document even for CSS. Let Vite update CSS in place.
    plugin.handleHotUpdate = function (context) {
      if (context.file.endsWith(".css")) return;
      return reload.call(this, context);
    };
  }
  return {
    plugins,
    test: {
      projects: [
        { extends: true, test: { name: "unit", exclude: [...configDefaults.exclude, IT, HEAVY] } },
        { extends: true, test: { name: "it", include: [IT] } },
        { extends: true, test: { name: "heavy", include: [HEAVY] } },
      ],
    },
    server: { headers, proxy: { "/ws": { target: `ws://127.0.0.1:${port}`, ws: true }, "/session/self-pause": { target: `http://127.0.0.1:${port}` }, "/session/speaker-name": { target: `http://127.0.0.1:${port}` } } },
    preview: { headers },
  };
});
