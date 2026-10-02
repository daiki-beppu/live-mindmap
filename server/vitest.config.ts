import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // テストが既定のポート（4319）を使うと、手元で開発サーバーが動いているときに EADDRINUSE で落ちる。
    // ポートを指定しない経路（play など）は、空いているポートで待ち受ける
    env: { LIVE_MINDMAP_PORT: "0" },
  },
});
