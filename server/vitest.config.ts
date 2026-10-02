import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // テストが既定のポート（4319）を使うと、手元で開発サーバーが動いているときに EADDRINUSE で落ちる。
    // ポートを指定しない経路（play など）は、空いているポートで待ち受ける
    env: { LIVE_MINDMAP_PORT: "0" },
    setupFiles: ["test/setup.ts"],
    // CI のランナーは手元より遅い（偽のヘルパーを子プロセスで起動するテストが既定の 5 秒を超える）
    testTimeout: 20_000,
  },
});
