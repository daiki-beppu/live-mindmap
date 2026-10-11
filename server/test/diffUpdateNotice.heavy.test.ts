import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { WebSocketRoute } from "playwright-core";
import { createServer } from "vite";
import type { DiffUpdateFrame, Snapshot } from "../src/core/index.ts";
import { Playwright } from "../src/playwright.ts";
import { managedPlaywright } from "./fixtures/managedPlaywright.ts";

describe("一時停止通知の実画面", () => {
  it.live("同じ画面で通知を出し入れしてもマップ・字幕を動かさず、左上の小さな文字だけを表示する", () => Effect.gen(function* () {
    const root = join(import.meta.dirname, "../../web");
    const vite = yield* Effect.acquireRelease(
      Effect.tryPromise(() => createServer({ root, configFile: join(root, "vite.config.ts"), logLevel: "silent", server: { host: "127.0.0.1", port: 0, hmr: false, ws: false } })),
      (vite) => Effect.promise(() => vite.close()),
    );
    yield* Effect.tryPromise(() => vite.listen());
    const browser = yield* Effect.acquireRelease((yield* Playwright).launch(), (b) => Effect.promise(() => b.close()));
    yield* Effect.tryPromise(async () => {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
      let socket: WebSocketRoute | undefined;
      const snapshot: Snapshot = { nodes: [{ id: "root", parent: null, kind: "会議", text: "定例", evidence: [] }], round: 0, changes: [], remarks: [] };
      await page.routeWebSocket("**/ws", (ws) => {
        socket = ws;
        ws.send(JSON.stringify(snapshot));
        ws.send(JSON.stringify({ type: "speaking", track: "相手", text: "保持している字幕" }));
        ws.send(JSON.stringify({ type: "diff-update", state: { status: "running" } } satisfies DiffUpdateFrame));
      });
      await page.goto(vite.resolvedUrls!.local[0]!);
      await page.getByText("保持している字幕", { exact: true }).waitFor();
      await page.locator(".map-node").waitFor();
      const boxes = () => Promise.all([".map", ".captions", ".side"].map((selector) => page.locator(selector).boundingBox()));
      const before = await boxes();
      expect(await page.locator(".diff-update-notice").count()).toBe(0);
      if (!socket) throw new Error("WebSocketが接続されていません");
      socket.send(JSON.stringify({ type: "diff-update", state: { status: "paused", reason: "ChatGPT の利用上限" } } satisfies DiffUpdateFrame));
      const notice = page.getByRole("status", { name: "" }).filter({ hasText: "マップの更新が止まっています（ChatGPT の利用上限）" });
      await notice.waitFor();
      const style = await notice.evaluate((el) => {
        const s = getComputedStyle(el), box = el.getBoundingClientRect();
        return { position: s.position, fontSize: s.fontSize, border: s.borderTopWidth, shadow: s.boxShadow, background: s.backgroundColor, x: box.x, y: box.y, children: el.children.length };
      });
      expect(style).toMatchObject({ position: "absolute", fontSize: "12px", border: "0px", shadow: "none", background: "rgba(0, 0, 0, 0)", x: 12, y: 8, children: 0 });
      expect(await boxes()).toEqual(before);
      await page.screenshot({ path: join(import.meta.dirname, "../../.takt/notice-browser.png") });
      for (const state of [{ status: "running" } as const, null]) {
        if (state === null) {
          socket.send(JSON.stringify({ type: "diff-update", state: { status: "paused", reason: "ChatGPT の利用上限" } } satisfies DiffUpdateFrame));
          await notice.waitFor();
        }
        socket.send(JSON.stringify({ type: "diff-update", state } satisfies DiffUpdateFrame));
        await notice.waitFor({ state: "detached" });
        expect(await boxes()).toEqual(before);
        expect(await page.getByText("保持している字幕", { exact: true }).isVisible()).toBe(true);
        expect(await page.locator(".map-node").count()).toBe(1);
      }
    });
  }).pipe(Effect.provide(managedPlaywright)), 60_000);
});
