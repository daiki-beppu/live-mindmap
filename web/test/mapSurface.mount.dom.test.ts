import { Effect, Fiber, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAP_NODE_BUTTON_CLASS } from "../src/enterFold.ts";
import { ObserveMapSurface } from "../src/app/mapSurface/mount.ts";
import type { Message } from "../src/app/mapSurface/message.ts";

// ノードのボタン上の click が、⌘/Ctrl 付きならノードの選択（ClickedNodeButton）に届かないことを Mount の段階で確かめる（Issue #816）。
// DOM が無い unit 環境なので偽の要素で capture → bubble の順に届ける。実ブラウザでの動作は未確認

type Listener = { handler: (event: unknown) => void; capture: boolean };
type ClickInit = { metaKey: boolean; ctrlKey: boolean; altKey: boolean };

class FakeElement {}

class FakeButton extends FakeElement {
  readonly nodeId: string;
  constructor(nodeId: string) {
    super();
    this.nodeId = nodeId;
  }
  closest(selector: string): unknown {
    if (selector === `.${MAP_NODE_BUTTON_CLASS}`) return this;
    if (selector === "[data-node-id]") return { dataset: { nodeId: this.nodeId } };
    return null;
  }
}

class FakeSurface {
  listeners: Array<Listener & { type: string }> = [];
  offsetWidth = 800;
  offsetHeight = 600;
  origin = { left: 0, top: 0 };
  addEventListener(type: string, handler: (event: unknown) => void, options?: boolean | { capture?: boolean }) {
    const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
    this.listeners.push({ type, handler, capture });
  }
  removeEventListener(type: string, handler: (event: unknown) => void, options?: boolean | { capture?: boolean }) {
    const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.handler === handler && l.capture === capture));
  }
  getBoundingClientRect() {
    return this.origin;
  }
  querySelectorAll() {
    return [];
  }
  dispatchEvent(event: Event) {
    for (const listener of [...this.listeners]) {
      if (listener.type === event.type) listener.handler(event);
    }
    return !event.defaultPrevented;
  }
  // capture を先に呼び、stopPropagation されたら bubble を呼ばない
  click(target: unknown, init: ClickInit) {
    let stopped = false;
    const event = { target, clientX: 10, clientY: 20, ...init, stopPropagation: () => { stopped = true; } };
    for (const l of [...this.listeners]) if (l.type === "click" && l.capture) l.handler(event);
    if (stopped) return;
    for (const l of [...this.listeners]) if (l.type === "click" && !l.capture) l.handler(event);
  }
}

beforeEach(() => {
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
});
afterEach(() => vi.unstubAllGlobals());

const observe = async (surface: FakeSurface) => {
  const got: Message[] = [];
  // FakeSurface は、この Mount が読む要素の機能だけを実装する。
  const stream = ObserveMapSurface().f(surface as unknown as Element, Stream.empty);
  const fiber = Effect.runFork(Stream.runForEach(stream, (m) => Effect.sync(() => { got.push(m); })));
  const close = () => Effect.runPromise(Fiber.interrupt(fiber));
  try {
    await expect.poll(() => surface.listeners.some((l) => l.type === "click" && l.capture), {
      timeout: 1000,
      message: "ObserveMapSurface のイベント購読が始まる",
    }).toBe(true);
    return { got, close };
  } catch (error) {
    await close();
    throw error;
  }
};

describe("ObserveMapSurface（Mount）: ノードのボタン上の click", () => {
  const tagsAfterClick = async (init: Partial<ClickInit>) => {
    const surface = new FakeSurface();
    const { got, close } = await observe(surface);
    try {
      const before = got.length;
      surface.click(new FakeButton("A"), { metaKey: false, ctrlKey: false, altKey: false, ...init });
      await expect.poll(() => got.length).toBeGreaterThan(before);
      return got.slice(before).map((m) => m._tag);
    } finally {
      await close();
    }
  };

  it("修飾キーなし: ClickedNodeButton だけが出る", async () => {
    expect(await tagsAfterClick({})).toEqual(["ClickedNodeButton"]);
  });
  it("⌘ 付き: ClickedMapSurfaceWithModifier だけが出て、ClickedNodeButton は出ない", async () => {
    expect(await tagsAfterClick({ metaKey: true })).toEqual(["ClickedMapSurfaceWithModifier"]);
  });
  it("Ctrl 付き: ⌘ 付きと同じ", async () => {
    expect(await tagsAfterClick({ ctrlKey: true })).toEqual(["ClickedMapSurfaceWithModifier"]);
  });
});

describe("ObserveMapSurface（Mount）: Safari の gesture", () => {
  it("開始と連続する変化を同期して既定動作を止めて届け、累積 scale と表示面内の座標を保つ", async () => {
    const surface = new FakeSurface();
    surface.origin = { left: 120, top: 45 };
    const { got, close } = await observe(surface);
    try {
      const start = new Event("gesturestart", { cancelable: true });
      expect(surface.dispatchEvent(start)).toBe(false);
      expect(start.defaultPrevented).toBe(true);
      await expect.poll(() => got).toEqual([{ _tag: "StartedMapSurfaceGesture" }]);

      const first = Object.assign(new Event("gesturechange", { cancelable: true }), {
        scale: 1.1, clientX: 320, clientY: 195,
      });
      expect(surface.dispatchEvent(first)).toBe(false);
      expect(first.defaultPrevented).toBe(true);
      await expect.poll(() => got).toEqual([
        { _tag: "StartedMapSurfaceGesture" },
        { _tag: "ChangedMapSurfaceGesture", scale: 1.1, x: 200, y: 150 },
      ]);

      const second = Object.assign(new Event("gesturechange", { cancelable: true }), {
        scale: 1.21, clientX: 350, clientY: 225,
      });
      expect(surface.dispatchEvent(second)).toBe(false);
      expect(second.defaultPrevented).toBe(true);
      await expect.poll(() => got).toEqual([
        { _tag: "StartedMapSurfaceGesture" },
        { _tag: "ChangedMapSurfaceGesture", scale: 1.1, x: 200, y: 150 },
        { _tag: "ChangedMapSurfaceGesture", scale: 1.21, x: 230, y: 180 },
      ]);
    } finally {
      await close();
    }
  });
});
