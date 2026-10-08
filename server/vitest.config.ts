import { configDefaults, defineConfig } from "vitest/config";

const IT = "**/*.it.test.?(c|m)[jt]s?(x)";
const HEAVY = "**/*.heavy.test.?(c|m)[jt]s?(x)";

export default defineConfig({
  test: {
    // テストが既定のポート（4319）を使うと、手元で開発サーバーが動いているときに EADDRINUSE で落ちる。
    // ポートを指定しない経路（play など）は、空いているポートで待ち受ける
    env: { LIVE_MINDMAP_PORT: "0" },
    setupFiles: ["test/setup.ts"],
    // CI のランナーは手元より遅い（偽のヘルパーを子プロセスで起動するテストが既定の 5 秒を超える）
    testTimeout: 20_000,
    // 層はファイル名の接尾辞で決める: foo.test.ts = unit、foo.it.test.ts = 軽い IT、foo.heavy.test.ts = 重い IT
    projects: [
      { extends: true, test: { name: "unit", exclude: [...configDefaults.exclude, IT, HEAVY] } },
      { extends: true, test: { name: "it", include: [IT] } },
      { extends: true, test: { name: "heavy", include: [HEAVY] } },
    ],
  },
});
