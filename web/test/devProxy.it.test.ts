import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";

// Issue #1069: ライブ画面の M が送る POST /session/self-pause は、開発用サーバー（Vite）の proxy で、操作用ポート（LIVE_MINDMAP_PORT）へ届く。
// Issue #1026: 字幕の名前の欄が送る POST /session/speaker-name も同じ。
const root = join(import.meta.dirname, "..");
const configFile = join(root, "vite.config.ts");

const proxied = [
  { path: "/session/self-pause", body: { paused: true } },
  { path: "/session/speaker-name", body: { label: "相手 B", name: "田中" } },
] as const;

describe("開発用サーバーの proxy", () => {
  it.each(proxied)("POST $path を、LIVE_MINDMAP_PORT の操作用ポートへ同じパス・同じ本文で渡す", async ({ path, body: sent }) => {
    const received: { method?: string; url?: string; body: string }[] = [];
    const target = createHttpServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        received.push({ method: request.method, url: request.url, body });
        response.statusCode = 204;
        response.end();
      });
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address === "string") throw new Error("操作用ポートの代役のポートを取得できません");
    const previous = process.env.LIVE_MINDMAP_PORT;
    process.env.LIVE_MINDMAP_PORT = String(address.port);
    try {
      const server = await createServer({ root, configFile, server: { host: "127.0.0.1", port: 0, hmr: false } });
      try {
        await server.listen();
        const web = server.httpServer!.address();
        if (!web || typeof web === "string") throw new Error("web のポートを取得できません");
        const response = await fetch(`http://127.0.0.1:${web.port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sent),
        });
        expect(response.status).toBe(204);
        expect(received).toEqual([{ method: "POST", url: path, body: JSON.stringify(sent) }]);
      } finally {
        await server.close();
      }
    } finally {
      if (previous === undefined) delete process.env.LIVE_MINDMAP_PORT;
      else process.env.LIVE_MINDMAP_PORT = previous;
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });
});
