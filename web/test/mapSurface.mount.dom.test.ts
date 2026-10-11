import { Effect, Fiber, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAP_NODE_BUTTON_CLASS } from "../src/enterFold.ts";
import { ObserveMapSurface } from "../src/app/mapSurface/mount.ts";

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
  addEventListener(type: string, handler: (event: unknown) => void, options?: boolean | { capture?: boolean }) {
    const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
    this.listeners.push({ type, handler, capture });
  }
  removeEventListener(type: string, handler: (event: unknown) => void, options?: boolean | { capture?: boolean }) {
    const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.handler === handler && l.capture === capture));
  }
  getBoundingClientRect() {
    return { left: 0, top: 0 };
  }
  querySelectorAll() {
    return [];
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

describe("ObserveMapSurface（Mount）: ノードのボタン上の click", () => {
  const observe = async (surface: FakeSurface) => {
    const got: Array<{ _tag: string }> = [];
    const stream = (ObserveMapSurface() as unknown as { f: (element: unknown, viewStateChanges: unknown) => Stream.Stream<{ _tag: string }> }).f(surface, Stream.empty);
    const fiber = Effect.runFork(Stream.runForEach(stream, (m) => Effect.sync(() => { got.push(m); })));
    // 購読が始まり、リスナーが登録されるまで待つ
    for (let i = 0; i < 100 && !surface.listeners.some((l) => l.type === "click" && l.capture); i++) await new Promise((r) => setTimeout(r, 1));
    return { got, close: () => Effect.runPromise(Fiber.interrupt(fiber)) };
  };
  const tagsAfterClick = async (init: Partial<ClickInit>) => {
    const surface = new FakeSurface();
    const { got, close } = await observe(surface);
    const before = got.length;
    surface.click(new FakeButton("A"), { metaKey: false, ctrlKey: false, altKey: false, ...init });
    await new Promise((r) => setTimeout(r, 0));
    const tags = got.slice(before).map((m) => m._tag);
    await close();
    return tags;
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
