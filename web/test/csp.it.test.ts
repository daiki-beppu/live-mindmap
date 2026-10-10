import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, preview } from "vite";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const configFile = join(root, "vite.config.ts");
const assertSelfConnectionPolicy = (response: Response) => {
  const policy = response.headers.get("content-security-policy");
  expect(policy).not.toBeNull();
  const directives = policy!.split(";").map((directive) => directive.trim().split(/\s+/))
    .filter(([name]) => name!.toLowerCase() === "connect-src");
  expect(directives).toEqual([["connect-src", "'self'"]]);
};

describe("web の応答の接続先制限", () => {
  it("開発サーバーの HTML に常に connect-src 'self' を付ける", async () => {
    const server = await createServer({ root, configFile, server: { host: "127.0.0.1", port: 0, hmr: false } });
    try {
      await server.listen();
      const address = server.httpServer!.address();
      if (!address || typeof address === "string") throw new Error("web のポートを取得できません");
      const response = await fetch(`http://127.0.0.1:${address.port}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('<div id="root">');
      assertSelfConnectionPolicy(response);
    } finally {
      await server.close();
    }
  });

  it("preview の HTML にも connect-src 'self' を付ける", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "live-mindmap-csp-"));
    try {
      await writeFile(join(outDir, "index.html"), '<!doctype html><div id="root"></div>');
      const server = await preview({ root, configFile, build: { outDir }, preview: { host: "127.0.0.1", port: 0 } });
      try {
        const address = server.httpServer.address();
        if (!address || typeof address === "string") throw new Error("preview のポートを取得できません");
        const response = await fetch(`http://127.0.0.1:${address.port}/`);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('<div id="root">');
        assertSelfConnectionPolicy(response);
      } finally {
        await new Promise<void>((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
