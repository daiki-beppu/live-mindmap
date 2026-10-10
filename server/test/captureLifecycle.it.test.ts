import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Result } from "effect";
import { beforeEach, vi } from "vitest";
import { CaptureFailed, MapCapture } from "../src/capture.ts";
import type { Snapshot } from "../src/core/index.ts";
import { Playwright } from "../src/playwright.ts";

const resources = vi.hoisted(() => ({
  createServer: vi.fn(), launch: vi.fn(), listen: vi.fn(), closeVite: vi.fn(),
  newPage: vi.fn(), closeBrowser: vi.fn(), addInitScript: vi.fn(), goto: vi.fn(),
  waitForSelector: vi.fn(), screenshot: vi.fn(),
}));
vi.mock("vite", () => ({ createServer: resources.createServer }));

const playwright = Layer.succeed(Playwright, Playwright.of({ launch: resources.launch }));

const snapshot: Snapshot = {
  nodes: [{ id: "root", parent: null, kind: "会議", text: "定例", evidence: [] }],
  round: 0, changes: [], remarks: [],
};
const directory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-capture-scope-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);
let events: string[];

beforeEach(() => {
  events = [];
  for (const mock of Object.values(resources)) mock.mockReset();
  resources.listen.mockImplementation(async () => { events.push("listen"); });
  resources.closeVite.mockImplementation(async () => { events.push("vite.close"); });
  resources.closeBrowser.mockImplementation(async () => { events.push("browser.close"); });
  resources.addInitScript.mockResolvedValue(undefined);
  resources.goto.mockResolvedValue(undefined);
  resources.waitForSelector.mockResolvedValue(undefined);
  resources.screenshot.mockImplementation(async ({ path }: { path: string }) => {
    events.push("screenshot");
    writeFileSync(path, "fake png");
  });
  resources.newPage.mockResolvedValue({
    addInitScript: resources.addInitScript, goto: resources.goto,
    waitForSelector: resources.waitForSelector, screenshot: resources.screenshot,
    locator: () => ({ count: async () => 0, all: async () => [] }),
  });
  resources.createServer.mockImplementation(async () => {
    events.push("vite.acquire");
    return { listen: resources.listen, close: resources.closeVite, resolvedUrls: { local: ["http://127.0.0.1:12345/"] } };
  });
  resources.launch.mockImplementation(async () => {
    events.push("browser.acquire");
    return { newPage: resources.newPage, close: resources.closeBrowser };
  });
});

const capture = (path: string) => Effect.gen(function* () {
  const service = yield* MapCapture;
  yield* service.capture(snapshot, path);
}).pipe(Effect.provide(MapCapture.layer.pipe(Layer.provide(playwright))));

describe("撮影 scope の資源所有権", () => {
  it.effect("成功時は撮影の最後の利用後に browser、Vite の順で一度だけ閉じる", () => Effect.gen(function* () {
    const dir = yield* directory;
    const path = join(dir, "map.png");
    yield* capture(path);
    expect(events).toEqual(["vite.acquire", "listen", "browser.acquire", "screenshot", "browser.close", "vite.close"]);
    expect(resources.screenshot).toHaveBeenCalledWith(expect.objectContaining({ path, type: "png" }));
    expect(resources.addInitScript.mock.calls[0]?.[1]).toMatchObject({ value: snapshot });
    expect(resources.closeBrowser).toHaveBeenCalledTimes(1);
    expect(resources.closeVite).toHaveBeenCalledTimes(1);
  }));

  it.effect("Vite を取得した後の listen 失敗でも Vite を閉じ、browser を取得しない", () => Effect.gen(function* () {
    const dir = yield* directory;
    resources.listen.mockRejectedValue(new Error("listen failed"));
    const result = yield* Effect.result(capture(join(dir, "map.png")));
    expect(Result.isFailure(result)).toBe(true);
    expect(resources.createServer).toHaveBeenCalledTimes(1);
    expect(resources.listen).toHaveBeenCalledTimes(1);
    expect(resources.closeVite).toHaveBeenCalledTimes(1);
    expect(resources.launch).not.toHaveBeenCalled();
  }));

  it.effect("browser の取得失敗でも取得済み Vite を閉じる", () => Effect.gen(function* () {
    const dir = yield* directory;
    resources.launch.mockRejectedValue(new Error("launch failed"));
    const result = yield* Effect.result(capture(join(dir, "map.png")));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) return;
    expect(result.failure).toBeInstanceOf(CaptureFailed);
    expect(result.failure.message).toBe("Chromium を起動できません。pnpm --filter @live-mindmap/server exec playwright install chromium を実行してください（launch failed）");
    expect(resources.createServer).toHaveBeenCalledTimes(1);
    expect(resources.launch).toHaveBeenCalledTimes(1);
    expect(resources.closeVite).toHaveBeenCalledTimes(1);
    expect(resources.closeBrowser).not.toHaveBeenCalled();
  }));

  it.effect.each(["newPage", "goto", "screenshot"] as const)("browser 取得後の %s 失敗でも browser と Vite を閉じる", (operation) => Effect.gen(function* () {
    const dir = yield* directory;
    resources[operation].mockRejectedValue(new Error(`${operation} failed`));
    const result = yield* Effect.result(capture(join(dir, "map.png")));
    expect(Result.isFailure(result)).toBe(true);
    expect(resources.launch).toHaveBeenCalledTimes(1);
    expect(resources[operation]).toHaveBeenCalledTimes(1);
    expect(events.slice(-2)).toEqual(["browser.close", "vite.close"]);
    expect(resources.closeBrowser).toHaveBeenCalledTimes(1);
    expect(resources.closeVite).toHaveBeenCalledTimes(1);
  }));

  it.effect("撮影中の fiber 中断は取得済み browser と Vite を閉じる", () => Effect.gen(function* () {
    const dir = yield* directory;
    const entered = yield* Deferred.make<void>();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    resources.screenshot.mockImplementation(async () => {
      Deferred.doneUnsafe(entered, Effect.void);
      await pending;
    });
    const fiber = yield* capture(join(dir, "map.png")).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    expect(resources.launch).toHaveBeenCalledTimes(1);
    expect(resources.closeBrowser).not.toHaveBeenCalled();
    expect(resources.closeVite).not.toHaveBeenCalled();
    yield* Fiber.interrupt(fiber).pipe(Effect.ensuring(Effect.sync(release)));
    expect(events.slice(-2)).toEqual(["browser.close", "vite.close"]);
    expect(resources.closeBrowser).toHaveBeenCalledTimes(1);
    expect(resources.closeVite).toHaveBeenCalledTimes(1);
  }));
});
