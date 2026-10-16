import { Effect, Fiber, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindingsOf, type Screen } from "../src/app/keys/table.ts";
import { keyPressStream } from "../src/app/keys/subscription.ts";
import { Message as MapSurfaceMessage } from "../src/app/mapSurface/message.ts";
import { init, makeUpdate } from "../src/app/review/main.ts";
import { Message } from "../src/app/review/message.ts";
import { makeSubscriptions } from "../src/app/review/subscription.ts";
import { audioContext, plainContext } from "./reviewHarness.ts";
import { element, eventOfBinding, fakeDocument, keydown, pressEach, settleKeyEvents, type FakeKeyEvent, type KeyInit } from "./keysHarness.ts";

// キーの Subscription（Issue #822）の stream。document の keydown を、Dom.streamFromKeyBindings（普通の道）と、日本語入力がオンのときの道（halfWidthKeyOf で半角に直して同じ表で照合）で受け、
// 「このキーが押された」の Message（PressedKey）だけを出す。意味は update が決める（keys.story.test.ts）。document は偽の代役、日本語入力の道は送り直し（dispatchEvent・stopImmediatePropagation）をしない

const SCREENS: readonly Screen[] = ["live", "review", "reviewAudio"];
const NO_MODIFIERS = { metaKey: false, ctrlKey: false, altKey: false };
const pressed = (key: string) => Message.PressedKey({ key: key as never, ...NO_MODIFIERS });

// 画面ごとの stream に、イベントを順に流す。届いた Message をイベントごとに返す
const press = (screen: Screen, events: readonly FakeKeyEvent[], hasSelection = false) =>
  pressEach((target) => keyPressStream({ screen, hasSelection: () => hasSelection, target }), events);
const pressOne = async (screen: Screen, init: KeyInit, hasSelection = false) => {
  const event = keydown(init);
  const { perEvent } = await press(screen, [event], hasSelection);
  return { messages: perEvent[0]!, event };
};

describe("表のすべてのバインディングで Message が届く（押したままの繰り返しでも）", () => {
  it.each(SCREENS)("%s: 表のバインディングごとに、その key の PressedKey が 1 つだけ届く。repeat: true でも同じ", async (screen) => {
    const bindings = bindingsOf(screen);
    const plain = bindings.map((b) => eventOfBinding(b.keys));
    const held = bindings.map((b) => eventOfBinding(b.keys, { repeat: true }));
    const { perEvent: first } = await press(screen, plain);
    const { perEvent: repeated } = await press(screen, held);
    bindings.forEach((b, i) => {
      expect(first[i], b.keys).toEqual([pressed(b.key)]);
      expect(repeated[i], `${b.keys} (repeat)`).toEqual([pressed(b.key)]);
    });
  });

  it.each(SCREENS)("%s: 届いた Message に載る修飾キーは、押されていない（false）", async (screen) => {
    const { perEvent } = await press(screen, bindingsOf(screen).map((b) => eventOfBinding(b.keys)));
    for (const messages of perEvent) for (const m of messages) expect(m).toMatchObject(NO_MODIFIERS);
  });

  it("その画面の表に無い行は届かない: 会議中は見返しのキー（Space K J L , . < > Home End）、音声なしの見返しは M を受けない。会議中の M は自分の休止として届く", async () => {
    const reviewOnly = [" ", "k", "j", "l", ",", ".", "<", ">", "Home", "End"];
    const live = await press("live", reviewOnly.map((key) => keydown({ key })));
    live.perEvent.forEach((messages, i) => expect(messages, reviewOnly[i]).toEqual([]));
    const liveMute = await press("live", [keydown({ key: "m" })]);
    expect(liveMute.perEvent).toEqual([[pressed("M")]]);
    const review = await press("review", [keydown({ key: "m" }), keydown({ key: "M", shiftKey: true })]);
    expect(review.perEvent).toEqual([[], []]);
    const audio = await press("reviewAudio", [keydown({ key: "m" })]);
    expect(audio.perEvent).toEqual([[pressed("M")]]);
  });

  it("走り終えると、document の keydown の listener が残らない", async () => {
    const { listenersAfter } = await press("review", [keydown({ key: "f" })]);
    expect(listenersAfter).toBe(0);
  });
});

describe("倍率・位置・一覧のキーの配列ごとの形（JIS の ^・US の +・Shift 付きの ? < >）", () => {
  const cases: ReadonlyArray<readonly [label: string, init: KeyInit, id: string]> = [
    ["=", { key: "=" }, "="],
    ["JIS の Shift + -（key が =）", { key: "=", shiftKey: true }, "="],
    ["JIS の ^", { key: "^" }, "="],
    ["US の Shift + =（key が +）", { key: "+", shiftKey: true }, "="],
    ["-", { key: "-" }, "-"],
    ["0", { key: "0" }, "0"],
    ["f（小文字）", { key: "f" }, "F"],
    ["F（大文字）", { key: "F" }, "F"],
    ["z", { key: "z" }, "Z"],
    ["e", { key: "e" }, "E"],
    ["c", { key: "c" }, "C"],
    ["Escape", { key: "Escape" }, "Escape"],
    ["?（Shift なし）", { key: "?" }, "?"],
    ["Shift + ?", { key: "?", shiftKey: true }, "?"],
    ["Shift + <", { key: "<", shiftKey: true }, "<"],
    ["Shift + >", { key: ">", shiftKey: true }, ">"],
    ["ArrowLeft", { key: "ArrowLeft" }, "ArrowLeft"],
    ["ArrowDown", { key: "ArrowDown" }, "ArrowDown"],
    ["Shift + ArrowLeft", { key: "ArrowLeft", shiftKey: true }, "Shift+ArrowLeft"],
    ["Shift + ArrowUp", { key: "ArrowUp", shiftKey: true }, "Shift+ArrowUp"],
  ];

  it.each(cases)("%s → %s", async (_label, init, id) => {
    // < > は見返しの行なので、会議中の画面には無い（会議中は届かない）
    const isReviewKey = id === "<" || id === ">";
    for (const screen of SCREENS) {
      const { messages } = await pressOne(screen, init);
      expect(messages, screen).toEqual(isReviewKey && screen === "live" ? [] : [pressed(id)]);
    }
  });

  it("修飾キーは厳密に照合する: ⌘・Ctrl・Option を押していると届かない。F は Shift 付きでも届かない", async () => {
    const inits: KeyInit[] = [{ key: "=", metaKey: true }, { key: "f", ctrlKey: true }, { key: "Escape", altKey: true }, { key: "F", shiftKey: true }, { key: "ArrowLeft", metaKey: true }, { key: "j", ctrlKey: true }];
    const { perEvent } = await press("reviewAudio", inits.map((init) => keydown(init)));
    expect(perEvent).toEqual(inits.map(() => []));
  });
});

describe("入力欄の中・既に取り消されたイベント", () => {
  it("入力欄（input・textarea・select・contenteditable）の中のキーには反応しない。日本語入力の道も同じ", async () => {
    const editable = [element("input"), element("textarea"), element("select"), element("div", [], true)];
    const events = editable.flatMap((target) => [keydown({ key: "f", target }), keydown({ key: "Escape", target }), keydown({ key: "Process", code: "KeyF", isComposing: true, target })]);
    const { perEvent } = await press("reviewAudio", events);
    expect(perEvent).toEqual(events.map(() => []));
    for (const event of events) expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("既に defaultPrevented のイベントは受けない（普通の道も日本語入力の道も）", async () => {
    const { perEvent } = await press("review", [keydown({ key: "f", defaultPrevented: true }), keydown({ key: "Process", code: "KeyF", isComposing: true, defaultPrevented: true })]);
    expect(perEvent).toEqual([[], []]);
  });

  it("普通の道は、受けたキーの既定動作を取り消す。表に無いキーは取り消さない", async () => {
    const hit = keydown({ key: "f" });
    const miss = keydown({ key: "q" });
    await press("review", [hit, miss]);
    expect(hit.preventDefault).toHaveBeenCalledTimes(1);
    expect(miss.preventDefault).not.toHaveBeenCalled();
  });
});

describe("Enter: 選んだノードの開閉に使うときだけ既定動作を取り消す", () => {
  const nodeButton = () => element("button", ["map-node__button"]);

  it("ノード本体のボタンの中: 選択があれば届き、既定動作を取り消す", async () => {
    const { messages, event } = await pressOne("review", { key: "Enter", target: nodeButton() }, true);
    expect(messages).toEqual([pressed("Enter")]);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("ノード本体のボタンの中: 選択が無ければ届かず、取り消さない（ボタンの click で選べる）", async () => {
    const { messages, event } = await pressOne("review", { key: "Enter", target: nodeButton() }, false);
    expect(messages).toEqual([]);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("ほかのボタン・リンクの中: 届かず、取り消さない（そのボタンを従来どおり押せる）", async () => {
    for (const target of [element("button", ["review__button"]), element("a")]) {
      const { messages, event } = await pressOne("review", { key: "Enter", target }, true);
      expect(messages).toEqual([]);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
  });

  it("ボタンの外（フォーカスなしに当たる要素）: 選択があれば届き、取り消す。選択が無くても届く", async () => {
    for (const hasSelection of [true, false]) {
      const { messages, event } = await pressOne("review", { key: "Enter", target: element("div") }, hasSelection);
      expect(messages).toEqual([pressed("Enter")]);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    }
  });

  it("会議中の stream でも同じ（Enter は両方の画面で効く）", async () => {
    const { messages } = await pressOne("live", { key: "Enter" }, true);
    expect(messages).toEqual([pressed("Enter")]);
  });
});

// Issue #1133: 選択の有無は stream を張った時点の値で持たず、keydown のたびに読む。選択が変わった直後の Enter も、張り直しを待たずにその時点の選択で決まる
describe("Enter: 選択の有無は keydown のたびに読む（張り直さない）", () => {
  // 同じ stream を張ったまま、選択の有無を変えてはノード本体のボタンの中で Enter を押す。ステップごとに届いた Message と、既定動作を取り消したかを返す
  const pressWhile = (steps: readonly boolean[]) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const doc = fakeDocument();
        let hasSelection = false;
        const collected: Array<typeof Message.Type> = [];
        const stream = keyPressStream({ screen: "review", hasSelection: () => hasSelection, target: doc as unknown as EventTarget });
        const fiber = yield* Effect.forkChild(Stream.runForEach(stream, (m) => Effect.sync(() => void collected.push(m))));
        yield* settleKeyEvents;
        const perStep: Array<{ messages: Array<typeof Message.Type>; prevented: boolean }> = [];
        for (const selected of steps) {
          hasSelection = selected;
          const event = keydown({ key: "Enter", target: element("button", ["map-node__button"]) });
          const before = collected.length;
          doc.fire(event);
          yield* settleKeyEvents;
          perStep.push({ messages: collected.slice(before), prevented: event.preventDefault.mock.calls.length > 0 });
        }
        yield* Fiber.interrupt(fiber);
        return perStep;
      }),
    );

  it("選択なし → あり: 同じ stream のまま、ノード本体のボタンの中の Enter が届き、既定動作を取り消す", async () => {
    expect(await pressWhile([false, true])).toEqual([
      { messages: [], prevented: false },
      { messages: [pressed("Enter")], prevented: true },
    ]);
  });

  it("選択あり → なし: 同じ stream のまま、同じ Enter は譲られる（届かず、取り消さない）", async () => {
    expect(await pressWhile([true, false])).toEqual([
      { messages: [pressed("Enter")], prevented: true },
      { messages: [], prevented: false },
    ]);
  });
});

describe("Space: 開閉の丸の中では譲る", () => {
  it("開閉の丸（隠れた数の丸・畳む丸）の中: 届かず、取り消さない（ボタンの click を残す）", async () => {
    for (const cls of ["map-node__count--pressable", "map-node__fold-dot"]) {
      const { messages, event } = await pressOne("review", { key: " ", target: element("button", [cls]) });
      expect(messages, cls).toEqual([]);
      expect(event.preventDefault, cls).not.toHaveBeenCalled();
    }
  });

  it("丸の外: 届き、既定動作を取り消す", async () => {
    for (const target of [element("div"), element("button", ["map-node__button"])]) {
      const { messages, event } = await pressOne("review", { key: " ", target });
      expect(messages).toEqual([pressed("Space")]);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    }
  });

  it("K は丸の中でも届く（譲るのは Space だけ）", async () => {
    const { messages } = await pressOne("review", { key: "k", target: element("button", ["map-node__fold-dot"]) });
    expect(messages).toEqual([pressed("K")]);
  });

  it("会議中は Space を受けない", async () => {
    const { messages, event } = await pressOne("live", { key: " " });
    expect(messages).toEqual([]);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe("日本語入力がオンのとき: 半角に直して同じ表で照合し、同じ Message を出す", () => {
  it("key が Process のイベントは code から直す: KeyF → F、Slash（Shift）→ ?、Equal → =", async () => {
    const cases: ReadonlyArray<readonly [KeyInit, string]> = [
      [{ key: "Process", code: "KeyF", isComposing: true }, "F"],
      [{ key: "Process", code: "Slash", shiftKey: true, isComposing: true }, "?"],
      [{ key: "Process", code: "Equal", isComposing: true }, "="],
      [{ key: "Process", code: "Digit0", isComposing: true }, "0"],
      [{ key: "Unidentified", code: "KeyE", isComposing: true }, "E"],
    ];
    for (const [init, id] of cases) {
      const { messages, event } = await pressOne("reviewAudio", init);
      expect(messages, `${init.code}`).toEqual([pressed(id)]);
      expect(event.preventDefault, `${init.code}`).toHaveBeenCalledTimes(1);
    }
  });

  it("全角の字（ｆ ＝ ０）と、変換中の半角の字は、半角のキーとして受ける", async () => {
    const cases: ReadonlyArray<readonly [KeyInit, string]> = [
      [{ key: "ｆ", code: "KeyF", isComposing: true }, "F"],
      [{ key: "＝", code: "Equal" }, "="],
      [{ key: "０", code: "Digit0" }, "0"],
      [{ key: "f", code: "KeyF", isComposing: true }, "F"],
    ];
    for (const [init, id] of cases) {
      const { messages } = await pressOne("review", init);
      expect(messages, `${init.key}`).toEqual([pressed(id)]);
    }
  });

  it("変換中の Space は Space（丸の外）として受ける。丸の中では譲る（届かず、取り消さない）", async () => {
    const outside = await pressOne("review", { key: "Process", code: "Space", isComposing: true });
    expect(outside.messages).toEqual([pressed("Space")]);
    expect(outside.event.preventDefault).toHaveBeenCalledTimes(1);
    const inside = await pressOne("review", { key: "Process", code: "Space", isComposing: true, target: element("button", ["map-node__fold-dot"]) });
    expect(inside.messages).toEqual([]);
    expect(inside.event.preventDefault).not.toHaveBeenCalled();
  });

  it("押したままの繰り返し（repeat: true）でも届く", async () => {
    const { messages } = await pressOne("review", { key: "Process", code: "Equal", isComposing: true, repeat: true });
    expect(messages).toEqual([pressed("=")]);
  });

  it("その画面の表に無いキーは届かず、取り消さない（会議中の J・音声なしの M・表に無い X）", async () => {
    const cases: ReadonlyArray<readonly [Screen, string]> = [
      ["live", "KeyJ"],
      ["review", "KeyM"],
      ["review", "KeyX"],
    ];
    for (const [screen, code] of cases) {
      const { messages, event } = await pressOne(screen, { key: "Process", code, isComposing: true });
      expect(messages, `${screen} ${code}`).toEqual([]);
      expect(event.preventDefault, `${screen} ${code}`).not.toHaveBeenCalled();
    }
  });

  it("修飾キーは厳密に照合する: Ctrl を押した変換中の F は届かず、取り消さない", async () => {
    const { messages, event } = await pressOne("review", { key: "Process", code: "KeyF", isComposing: true, ctrlKey: true });
    expect(messages).toEqual([]);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("1 回の keydown で Message は 1 つだけ（普通の道と日本語入力の道が重ならない）", async () => {
    const events = [keydown({ key: "f" }), keydown({ key: "Process", code: "KeyF", isComposing: true }), keydown({ key: "＝", code: "Equal" })];
    const { perEvent } = await press("review", events);
    expect(perEvent.map((messages) => messages.length)).toEqual([1, 1, 1]);
  });

  it("送り直さない: dispatchEvent も stopImmediatePropagation も呼ばない（document・window・イベントの対象・イベント）", async () => {
    const events = [
      keydown({ key: "Process", code: "KeyF", isComposing: true }),
      keydown({ key: "＝", code: "Equal" }),
      keydown({ key: "Process", code: "Space", isComposing: true }),
      keydown({ key: "Process", code: "KeyX", isComposing: true }),
    ];
    const { doc } = await press("review", events);
    expect(doc.dispatchEvent).not.toHaveBeenCalled();
    expect((doc.defaultView as { dispatchEvent: ReturnType<typeof vi.fn> }).dispatchEvent).not.toHaveBeenCalled();
    for (const event of events) {
      expect(event.target.dispatchEvent).not.toHaveBeenCalled();
      expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
    }
  });

  it("走り終えると、日本語入力の道の listener も残らない", async () => {
    const { listenersAfter } = await press("review", [keydown({ key: "Process", code: "KeyF", isComposing: true })]);
    expect(listenersAfter).toBe(0);
  });
});

describe("見返しの Subscription の keys: 依存と、画面の決まり方", () => {
  const subscriptions = (context: typeof plainContext) => makeSubscriptions(context);
  afterEach(() => vi.unstubAllGlobals());

  // keys の stream は target を取らず、グローバルの document に付ける。偽の document に差し替えて走らせる
  const runKeys = (context: typeof plainContext, hasSelection: boolean, inits: readonly KeyInit[]) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const doc = fakeDocument();
        vi.stubGlobal("document", doc);
        const collected: Array<typeof Message.Type> = [];
        const fiber = yield* Effect.forkChild(Stream.runForEach(subscriptions(context).keys.dependenciesToStream({ hasSelection }, () => ({ hasSelection })), (m) => Effect.sync(() => void collected.push(m))));
        yield* settleKeyEvents;
        const perEvent: Array<Array<typeof Message.Type>> = [];
        for (const init of inits) {
          const before = collected.length;
          doc.fire(keydown(init));
          yield* settleKeyEvents;
          perEvent.push(collected.slice(before));
        }
        yield* Fiber.interrupt(fiber);
        return perEvent;
      }),
    );

  it("依存は hasSelection だけ: 選んでいなければ false、ノードを選ぶと true", () => {
    const update = makeUpdate(plainContext);
    const start = update(init(plainContext), Message.GotMapSurfaceMessage({ message: MapSurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { root: 40, n1: 40, n2: 40, n3: 40 } }) })).model;
    expect(subscriptions(plainContext).keys.modelToDependencies(start)).toEqual({ hasSelection: false });
    const selected = update(start, Message.GotMapSurfaceMessage({ message: MapSurfaceMessage.ClickedNodeButton({ nodeId: "n1", clientX: 0, clientY: 0 }) })).model;
    expect(selected.mapSurface.viewing.selection).toBeDefined();
    expect(subscriptions(plainContext).keys.modelToDependencies(selected)).toEqual({ hasSelection: true });
  });

  // Issue #1133: 選択の有無が変わっても stream を張り直さない（Enter の判定は keydown のたびに readDependencies から読む）
  it("選択の有無だけが変わっても張り直さない（keepAliveEquivalence が等しいと判定する）", () => {
    const { keepAliveEquivalence } = subscriptions(plainContext).keys;
    expect(keepAliveEquivalence?.({ hasSelection: false }, { hasSelection: true })).toBe(true);
  });

  it("録音なしの見返しは M を受けず、録音つきの見返しは M を受ける（画面は Context の音声の有無で決まる）", async () => {
    const inits: KeyInit[] = [{ key: "m" }, { key: "f" }];
    expect(await runKeys(plainContext, false, inits)).toEqual([[], [pressed("F")]]);
    expect(await runKeys(audioContext, false, inits)).toEqual([[pressed("M")], [pressed("F")]]);
  });

  it("hasSelection が Enter の可否に届く（ノード本体のボタンの中の Enter は、選択があるときだけ）", async () => {
    const inits: KeyInit[] = [{ key: "Enter", target: element("button", ["map-node__button"]) }];
    expect(await runKeys(plainContext, false, inits)).toEqual([[]]);
    expect(await runKeys(plainContext, true, inits)).toEqual([[pressed("Enter")]]);
  });
});
