import { Effect, Fiber, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Menu from "@foldkit/ui/menu";
import { ReleaseFocus, ReleaseFocusAfterMenuClose } from "../src/app/review/command.ts";
import { Message } from "../src/app/review/message.ts";
import { ObserveSeekPointer } from "../src/app/review/mount.ts";
import { makeSubscriptions } from "../src/app/review/subscription.ts";
import { audioContext } from "./reviewHarness.ts";

// DOM が無い unit 環境で、操作の行（Issue #825）が DOM に触れる 2 か所を偽の要素で確かめる:
// 押して離したあとにフォーカスを外す Command（ReleaseFocus）と、シークバーの上のポインタの位置を fraction にする Mount（ObserveSeekPointer）。
// 実ブラウザでの座標・フォーカスは未確認（E2E の review が名前「時刻」のスライダーを操作する）

describe("ReleaseFocus（Command）: 今フォーカスのある要素から外す", () => {
  class FakeHTMLElement {
    blurCalls = 0;
    blur() {
      this.blurCalls += 1;
    }
  }
  let active: FakeHTMLElement | null;
  beforeEach(() => {
    active = new FakeHTMLElement();
    vi.stubGlobal("HTMLElement", FakeHTMLElement);
    vi.stubGlobal("document", {
      get activeElement() {
        return active;
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const run = <A>(command: { effect: Effect.Effect<A, never, never> }) => Effect.runPromise(command.effect);

  it("フォーカスのある要素の blur() を呼び、CompletedReleaseFocus を返す", async () => {
    const element = active!;
    expect(await run(ReleaseFocus())).toEqual(Message.CompletedReleaseFocus());
    expect(element.blurCalls).toBe(1);
  });

  it("フォーカスのある要素が無くても（activeElement が null）、何もせず CompletedReleaseFocus を返す", async () => {
    active = null;
    expect(await run(ReleaseFocus())).toEqual(Message.CompletedReleaseFocus());
  });
});

describe("ObserveSeekPointer（Mount）: ポインタの位置をシークバーの左端からの割合にする", () => {
  // 幅 400・左端 100 のシークバー。root の位置と大きさを返す偽の要素（root を探すための querySelector・closest は自分を返す）
  class FakeSeekRoot extends EventTarget {
    rect = { left: 100, width: 400, right: 500, top: 0, bottom: 16, height: 16, x: 100, y: 0 };
    getBoundingClientRect() {
      return this.rect;
    }
    querySelector() {
      return this;
    }
    closest() {
      return this;
    }
  }
  const at = (type: string, clientX: number) => Object.assign(new Event(type, { bubbles: true }), { clientX, clientY: 4 });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  const observe = async (root: FakeSeekRoot) => {
    const got: Array<{ _tag: string; fraction?: number }> = [];
    const stream = (ObserveSeekPointer() as unknown as { f: (element: unknown, viewStateChanges: unknown) => Stream.Stream<{ _tag: string; fraction?: number }> }).f(root, Stream.empty);
    const fiber = Effect.runFork(Stream.runForEach(stream, (message) => Effect.sync(() => { got.push(message); })));
    await flush();
    return { got, close: () => Effect.runPromise(Fiber.interrupt(fiber)) };
  };
  // 同じ意味のイベントが pointer と mouse の両方で届いても 1 種類とみなす（どちらの系統で聞くかは実装の自由）
  const distinct = (got: Array<{ _tag: string; fraction?: number }>) => [...new Set(got.map((m) => JSON.stringify(m)))].map((json) => JSON.parse(json) as { _tag: string; fraction?: number });
  const move = async (root: FakeSeekRoot, clientX: number, got: Array<{ _tag: string; fraction?: number }>) => {
    root.dispatchEvent(at("pointermove", clientX));
    root.dispatchEvent(at("mousemove", clientX));
    await flush();
    return distinct(got.splice(0));
  };

  it("要素の上のポインタの位置を MovedSeekPointer の fraction（0〜1）にする: 左端 100・幅 400 の 300 は 0.5", async () => {
    const root = new FakeSeekRoot();
    const { got } = await observe(root);
    expect(await move(root, 300, got)).toEqual([Message.MovedSeekPointer({ fraction: 0.5 })]);
    expect(await move(root, 200, got)).toEqual([Message.MovedSeekPointer({ fraction: 0.25 })]);
  });

  it("両端の外は 0 と 1 に収める", async () => {
    const root = new FakeSeekRoot();
    const { got } = await observe(root);
    expect(await move(root, 20, got)).toEqual([Message.MovedSeekPointer({ fraction: 0 })]);
    expect(await move(root, 900, got)).toEqual([Message.MovedSeekPointer({ fraction: 1 })]);
  });

  it("幅が 0 の要素でも NaN を出さない（0〜1 の有限な値）", async () => {
    const root = new FakeSeekRoot();
    root.rect = { ...root.rect, width: 0, right: 100 };
    const { got } = await observe(root);
    const [only] = await move(root, 100, got);
    expect(only!._tag).toBe("MovedSeekPointer");
    expect(Number.isFinite(only!.fraction)).toBe(true);
    expect(only!.fraction).toBeGreaterThanOrEqual(0);
    expect(only!.fraction).toBeLessThanOrEqual(1);
  });

  it("ポインタが要素から出たら LeftSeekPointer を出す", async () => {
    const root = new FakeSeekRoot();
    const { got } = await observe(root);
    root.dispatchEvent(at("pointerleave", 0));
    root.dispatchEvent(at("mouseleave", 0));
    await flush();
    expect(distinct(got)).toEqual([Message.LeftSeekPointer()]);
  });

  it("乗せる → 離す → また乗せる、と同じ Mount の上で続けて受ける", async () => {
    const root = new FakeSeekRoot();
    const { got } = await observe(root);
    expect(await move(root, 300, got)).toEqual([Message.MovedSeekPointer({ fraction: 0.5 })]);
    root.dispatchEvent(at("pointerleave", 0));
    root.dispatchEvent(at("mouseleave", 0));
    await flush();
    expect(distinct(got.splice(0))).toEqual([Message.LeftSeekPointer()]);
    expect(await move(root, 500, got)).toEqual([Message.MovedSeekPointer({ fraction: 1 })]);
  });

  it("Mount が外れたら（release）、リスナーを外して、その後のイベントは受けない", async () => {
    const root = new FakeSeekRoot();
    const { got, close } = await observe(root);
    await close();
    root.dispatchEvent(at("pointermove", 300));
    root.dispatchEvent(at("mousemove", 300));
    root.dispatchEvent(at("pointerleave", 0));
    await flush();
    expect(got).toEqual([]);
  });
});

describe("ReleaseFocusAfterMenuClose（Command）: Menu が閉じるときの FocusButton のあとにフォーカスを外す", () => {
  class FakeHTMLElement {
    focus() {
      active = this;
    }
    blur() {
      if (active === this) active = null;
    }
  }
  let active: FakeHTMLElement | null;
  let frames: Array<() => void>;
  const button = new FakeHTMLElement();
  beforeEach(() => {
    active = null;
    frames = [];
    vi.stubGlobal("HTMLElement", FakeHTMLElement);
    vi.stubGlobal("document", {
      get activeElement() {
        return active;
      },
      querySelector: () => button,
    });
    // フレームは手で進める（RenderCommit が無い環境では、commit を 1 フレームとして数える）
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  // 保留のフレームを 1 つずつ進め、そのたびに Effect の続きを走らせる
  const drain = async () => {
    await flush();
    while (frames.length > 0) {
      frames.shift()!();
      await flush();
    }
  };
  const runBoth = async (...effects: Array<Effect.Effect<unknown, never, never>>) => {
    const fibers = effects.map((effect) => Effect.runFork(effect));
    await drain();
    await Promise.all(fibers.map((fiber) => Effect.runPromise(Fiber.await(fiber))));
  };
  const focusButton = Menu.FocusButton({ id: "rate" }).effect;

  it("FocusButton と並べて走らせると、どちらを先に起こしても、最後はボタンにフォーカスが残らない", async () => {
    await runBoth(focusButton, ReleaseFocusAfterMenuClose().effect);
    expect(active).toBeNull();
    await runBoth(ReleaseFocusAfterMenuClose().effect, focusButton);
    expect(active).toBeNull();
  });

  it("即時に外す ReleaseFocus だと、あとから FocusButton がボタンにフォーカスを戻す（この Command が必要な理由）", async () => {
    await runBoth(ReleaseFocus().effect, focusButton);
    expect(active).toBe(button);
  });

  it("結果は CompletedReleaseFocusAfterMenuClose", async () => {
    const fiber = Effect.runFork(ReleaseFocusAfterMenuClose().effect);
    await drain();
    expect(await Effect.runPromise(Fiber.join(fiber))).toEqual(Message.CompletedReleaseFocusAfterMenuClose());
  });
});

describe("sliderRelease（Subscription）: 押している間の文書のイベントを Message にする", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  let doc: EventTarget;
  const added: string[] = [];
  beforeEach(() => {
    doc = new EventTarget();
    const add = doc.addEventListener.bind(doc);
    doc.addEventListener = (type: string, ...rest: [EventListenerOrEventListenerObject | null, (boolean | AddEventListenerOptions)?]) => {
      added.push(type);
      add(type, ...rest);
    };
    vi.stubGlobal("document", doc);
  });
  afterEach(() => vi.unstubAllGlobals());

  // 購読が文書にリスナーを付け終えるまで待つ（負荷で遅れても、イベントを取りこぼさない）
  const listening = async (expected: number) => {
    for (let i = 0; i < 200 && added.length < expected; i += 1) await flush();
  };
  const collect = async (isPressing: boolean, ...types: string[]) => {
    const got: unknown[] = [];
    added.length = 0;
    const stream = makeSubscriptions(audioContext).sliderRelease.dependenciesToStream({ isPressing });
    const fiber = Effect.runFork(Stream.runForEach(stream, (message) => Effect.sync(() => { got.push(message); })));
    await listening(isPressing ? 2 : 0);
    for (const type of types) doc.dispatchEvent(new Event(type));
    await flush();
    await Effect.runPromise(Fiber.interrupt(fiber));
    return got;
  };

  it("pointerup は ReleasedSliderPointer、pointercancel は CancelledSliderPointer になる", async () => {
    expect(await collect(true, "pointerup")).toEqual([Message.ReleasedSliderPointer()]);
    expect(await collect(true, "pointercancel")).toEqual([Message.CancelledSliderPointer()]);
  });

  it("押していない間は、どちらも受けない", async () => {
    expect(await collect(false, "pointerup", "pointercancel")).toEqual([]);
  });
});
