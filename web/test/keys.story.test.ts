import * as Menu from "@foldkit/ui/menu";
import * as Popover from "@foldkit/ui/popover";
import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as MapSurface from "../src/app/mapSurface/main.ts";
import { Message as MapSurfaceMessage } from "../src/app/mapSurface/message.ts";
import { snapshotAt } from "../src/reviewTimeline.ts";
import { foldView } from "../src/folding.ts";
import { humanSetsOf } from "../src/viewing.ts";
import { makeContext } from "../src/app/review/context.ts";
import { init, Model, makeUpdate } from "../src/app/review/main.ts";
import { Message } from "../src/app/review/message.ts";
import { bindingsOf, type Screen } from "../src/app/keys/table.ts";
import { keyPressStream } from "../src/app/keys/subscription.ts";
import { playbackReducer } from "../src/reviewPlayback.ts";
import { argsOf, audioContext, commandNames, DURATION, plainContext, stateAt } from "./reviewHarness.ts";
import { eventOfBinding, keydown, pressEach, type KeyInit } from "./keysHarness.ts";

// 見返しの Foldkit プログラム（Issue #822）の update: 「このキーが押された」（PressedKey）の意味を update が決める。
// 各キーの結果は、同じ意味のボタン・Message を押したときと同じ Model と Command になる（ボタンのない倍率・位置・選択のキーは、表示面の Pressed*Key と同じ）。
// 日本語入力がオンのとき・押したままの繰り返しは、本物の stream の出力をそのまま update に渡して確かめる（Message を直接作らない）。
// 会議の長さは 200 秒。題材のノードは n1（議題 A）・n2（議題 B）・n3（TODO）

const NO_MODIFIERS = { metaKey: false, ctrlKey: false, altKey: false };
type Mods = Partial<typeof NO_MODIFIERS>;
const keyOf = (id: string, mods: Mods = {}) => Message.PressedKey({ key: id as never, ...NO_MODIFIERS, ...mods });
const surface = (message: MapSurfaceMessage) => Message.GotMapSurfaceMessage({ message });
const viewKey = (key: string, mods: Mods = {}) => surface(MapSurfaceMessage.PressedViewKey({ key: key as never, ...NO_MODIFIERS, ...mods }));
const arrowKey = (dir: "left" | "right" | "up" | "down", mods: Mods = {}) => surface(MapSurfaceMessage.PressedArrowKey({ dir, ...NO_MODIFIERS, ...mods }));
const enterKey = (mods: Mods = {}) => surface(MapSurfaceMessage.PressedEnterKey({ ...NO_MODIFIERS, ...mods }));
const keyList = (message: Popover.Message) => Message.GotKeyListMessage({ message });
const rateMenu = (message: Menu.Message) => Message.GotRateMenuMessage({ message });

// Command の値は実行の関数を持つので、同じ操作でも toEqual で比べられない。名前と引数で比べる
const commandsOf = (commands: ReadonlyArray<{ name: string; args?: unknown }> | undefined) => (commands ?? []).map(({ name, args }) => ({ name, args }));

type Context = typeof plainContext;
type Update = ReturnType<typeof makeUpdate>;
const updateOf = (context: Context): Update => makeUpdate(context);

// 表示面を測り終えた、時刻 time の Model
const measured = (context: Context, update: Update, time = DURATION) =>
  update(stateAt(context, time), surface(MapSurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { root: 40, n1: 40, n2: 40, n3: 40 } }))).model;
const withSelection = (update: Update, model: ReturnType<typeof stateAt>) => update(model, surface(MapSurfaceMessage.ClickedNodeButton({ nodeId: "n1", clientX: 0, clientY: 0 }))).model;
const feed = (update: Update, start: ReturnType<typeof stateAt>, messages: ReadonlyArray<Message>) => messages.reduce((model, message) => update(model, message).model, start);

const plainUpdate = updateOf(plainContext);
const audioUpdate = updateOf(audioContext);

describe("キーの一覧の Model: Popover（モーダルでない）で、最初は閉じている", () => {
  it("最初は閉じていて、isModal: false（背景を止めない）、パネルにフォーカスを移さない（contentFocus: true）", () => {
    for (const context of [plainContext, audioContext]) {
      expect(init(context).keyList).toMatchObject({ isOpen: false, isModal: false, contentFocus: true });
    }
  });

  it("どのキーを押したあとも、Model は本物の Schema を通る（全画面のすべてのキー）", () => {
    const ids = [...new Set(bindingsOf("reviewAudio").map((b) => b.key))];
    for (const [context, update] of [[plainContext, plainUpdate], [audioContext, audioUpdate]] as const) {
      const start = withSelection(update, measured(context, update));
      for (const id of ids) {
        if (id === "M" && context === plainContext) continue;
        expect(Schema.is(Model)(update(start, keyOf(id)).model), id).toBe(true);
      }
    }
  });
});

describe("? でキーの一覧を開閉する（背景を止めない）", () => {
  it("? で開き、もう一度の ? で閉じる", () => {
    const start = measured(plainContext, plainUpdate);
    const opened = plainUpdate(start, keyOf("?")).model;
    expect(opened.keyList.isOpen).toBe(true);
    expect(plainUpdate(opened, keyOf("?")).model.keyList.isOpen).toBe(false);
  });

  it("開いても、背景を止める Command（InertOthers・LockScroll）は出ない。マップの状態も変わらない", () => {
    const start = measured(plainContext, plainUpdate);
    const result = plainUpdate(start, keyOf("?"));
    const names = commandNames(result.commands);
    expect(names).not.toContain("InertOthers");
    expect(names).not.toContain("LockScroll");
    // マップの状態は idleStamp（10 秒の計り直し）以外が変わらない
    expect(result.model.mapSurface).toEqual({ ...start.mapSurface, idleStamp: start.mapSurface.idleStamp + 1 });
    expect(result.model.playback).toEqual(start.playback);
  });

  it("開いたまま、マップの操作（wheel・ノードを押す）が効き、一覧は閉じない", () => {
    const opened = plainUpdate(measured(plainContext, plainUpdate), keyOf("?")).model;
    const wheeled = plainUpdate(opened, surface(MapSurfaceMessage.WheeledMapSurface({ x: 0, y: 0, deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false, timeStamp: 0 }))).model;
    expect(wheeled.mapSurface.viewing.mode).toBe("manual");
    expect(wheeled.keyList.isOpen).toBe(true);
    const pressed = plainUpdate(wheeled, surface(MapSurfaceMessage.PressedMapSurface({ clientX: 100, clientY: 100, button: 0, ctrlKey: false, insideNoPan: false }))).model;
    expect(pressed.keyList.isOpen).toBe(true);
  });

  it("フォーカスを移さない一覧なので、開いてもパネルへフォーカスを移す Command（FocusPanel）は出ない。パネルに blur の受け口がないことは Scene で確かめる", () => {
    const result = plainUpdate(measured(plainContext, plainUpdate), keyOf("?"));
    expect(result.model.keyList.contentFocus).toBe(true);
    expect(commandNames(result.commands)).not.toContain("FocusPanel");
  });


  it("開いたまま倍率・位置・選択のキーを押しても、一覧は開いたまま", () => {
    const opened = plainUpdate(withSelection(plainUpdate, measured(plainContext, plainUpdate)), keyOf("?")).model;
    const after = ["=", "-", "0", "F", "Z", "ArrowRight", "Shift+ArrowLeft"].reduce((model, id) => plainUpdate(model, keyOf(id)).model, opened);
    expect(after.keyList.isOpen).toBe(true);
  });
});

describe("Esc: 速さのメニュー → キーの一覧 → 見る状態 の優先で、閉じるだけ", () => {
  const menuOpened = Message.GotRateMenuMessage({ message: Menu.Message.Opened({ maybeActiveItemIndex: Option.none() }) });
  const selectedOpen = (update: Update, context: Context) => {
    const selected = withSelection(update, measured(context, update));
    expect(selected.mapSurface.viewing.selection).toBeDefined();
    const listed = update(selected, keyOf("?")).model;
    return update(listed, menuOpened).model;
  };

  it("一覧と速さのメニューが両方開いているとき、1 回目の Esc はメニューだけを閉じる。一覧も選択も残る", () => {
    const both = selectedOpen(plainUpdate, plainContext);
    expect(both.rateMenu.isOpen).toBe(true);
    expect(both.keyList.isOpen).toBe(true);
    const after = plainUpdate(both, keyOf("Escape")).model;
    expect(after.rateMenu.isOpen).toBe(false);
    expect(after.keyList.isOpen).toBe(true);
    expect(after.mapSurface.viewing.selection).toBeDefined();
  });

  it("続けた 2 回目の Esc は一覧だけを閉じる。選択は残る。3 回目で選択が外れる（同じ Model の上の続き）", () => {
    const both = selectedOpen(plainUpdate, plainContext);
    const first = plainUpdate(both, keyOf("Escape")).model;
    const second = plainUpdate(first, keyOf("Escape")).model;
    expect(second.rateMenu.isOpen).toBe(false);
    expect(second.keyList.isOpen).toBe(false);
    expect(second.mapSurface.viewing.selection).toBeDefined();
    const third = plainUpdate(second, keyOf("Escape")).model;
    expect(third.mapSurface.viewing.selection).toBeUndefined();
    expect(third.keyList.isOpen).toBe(false);
  });

  it("速さのメニューだけが開いているときは、メニューだけを閉じる（選択は残る）", () => {
    const selected = withSelection(plainUpdate, measured(plainContext, plainUpdate));
    const menuOnly = plainUpdate(selected, menuOpened).model;
    expect(menuOnly.rateMenu.isOpen).toBe(true);
    const after = plainUpdate(menuOnly, keyOf("Escape")).model;
    expect(after.rateMenu.isOpen).toBe(false);
    expect(after.mapSurface.viewing.selection).toBeDefined();
  });

  it("どちらも閉じているときは、表示面の Esc（PressedEscapeKey）と同じ結果になる", () => {
    const selected = withSelection(plainUpdate, measured(plainContext, plainUpdate));
    const expected = plainUpdate(selected, surface(MapSurfaceMessage.PressedEscapeKey({ ...NO_MODIFIERS })));
    const actual = plainUpdate(selected, keyOf("Escape"));
    expect(actual.model).toEqual(expected.model);
    expect(commandNames(actual.commands)).toEqual(commandNames(expected.commands));
    expect(actual.model.mapSurface.viewing.selection).toBeUndefined();
  });
});

describe("倍率・位置・ノードを選ぶキーは、表示面の Pressed*Key と同じ結果になる", () => {
  const VIEW_KEYS = ["=", "-", "0", "F", "Z", "Shift+ArrowLeft", "Shift+ArrowRight", "Shift+ArrowUp", "Shift+ArrowDown"];
  const ARROWS = [["ArrowLeft", "left"], ["ArrowRight", "right"], ["ArrowUp", "up"], ["ArrowDown", "down"]] as const;
  const start = withSelection(plainUpdate, measured(plainContext, plainUpdate));

  it.each(VIEW_KEYS)("%s → PressedViewKey", (id) => {
    const actual = plainUpdate(start, keyOf(id));
    const expected = plainUpdate(start, viewKey(id));
    expect(actual.model).toEqual(expected.model);
    expect(commandNames(actual.commands)).toEqual(commandNames(expected.commands));
  });

  it.each(ARROWS)("%s → PressedArrowKey(%s)", (id, dir) => {
    expect(plainUpdate(start, keyOf(id)).model).toEqual(plainUpdate(start, arrowKey(dir)).model);
  });

  // 議題 T1 の下に論点 Q1・Q2、今の議題は T2（時刻 30）。T1 を選んで Enter で開閉する
  it("Enter で選んだ議題の下の論点が見え、もう一度の Enter で見えなくなる（開閉を見えるノードで確かめる）", () => {
    const remark = (id: string, start: number, end: number) => ({ at: "x", type: "remark", remark: { id, track: "相手", start, end, text: id } });
    const add = (ref: string, parent: string, kind: string, text: string, evidence: string[]) => ({ op: "add", ref, parent, kind, text, evidence });
    const diff = (fresh: string[], ops: unknown[]) => ({ at: "x", type: "diff", input: { recent: [], fresh, nodeCount: 0 }, ops, dropped: [] });
    const local = makeContext([
      { at: "a", type: "start", title: "定例" },
      remark("r1", 0, 10),
      diff(["r1"], [add("t1", "root", "議題", "T1", ["r1"]), add("q1", "t1", "論点", "Q1", ["r1"]), add("q2", "t1", "論点", "Q2", ["r1"])]),
      remark("r2", 10, 30),
      diff(["r2"], [add("t2", "root", "議題", "T2", ["r2"])]),
      remark("r3", 30, 40),
      diff(["r3"], [{ op: "close", node: "n1" }]), // T1 を済みにして、畳まれた状態から始める
    ]);
    const localUpdate = updateOf(local);
    const idOf = (text: string) => snapshotAt(local.timeline, 40).nodes.find((n) => n.text === text)!.id;
    const shown = (model: ReturnType<typeof stateAt>) => {
      const { opened, folded, unbundled } = humanSetsOf(model.mapSurface.viewing);
      return foldView(snapshotAt(local.timeline, 40), opened, model.mapSurface.viewing.selection?.id ?? null, folded, unbundled).nodes.map((n) => n.id);
    };
    const base = localUpdate(stateAt(local, 40), surface(MapSurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: {} }))).model;
    const selected = localUpdate(base, surface(MapSurfaceMessage.ClickedNodeButton({ nodeId: idOf("T1"), clientX: 0, clientY: 0 }))).model;
    const children = [idOf("Q1"), idOf("Q2")];
    for (const id of children) expect(shown(selected)).not.toContain(id);
    const opened = localUpdate(selected, keyOf("Enter")).model;
    for (const id of children) expect(shown(opened)).toContain(id);
    const closed = localUpdate(opened, keyOf("Enter")).model;
    for (const id of children) expect(shown(closed)).not.toContain(id);
  });

  it("Enter → PressedEnterKey（修飾キーなし）", () => {
    expect(plainUpdate(start, keyOf("Enter")).model).toEqual(plainUpdate(start, enterKey()).model);
  });

  it("F で全体を見て、もう一度の F で変わったところを見る。もう一度で全体に戻る（同じ Model の上の続き）", () => {
    const overview = plainUpdate(start, keyOf("F")).model;
    expect(overview.mapSurface.viewing.mode).toBe("overview");
    const diff = plainUpdate(overview, keyOf("F")).model;
    expect(diff.mapSurface.viewing.mode).toBe("diff");
    expect(plainUpdate(diff, keyOf("F")).model.mapSurface.viewing.mode).toBe("overview");
  });

  it("修飾キーは載せたまま表示面へ渡す（⌘・Ctrl・Option 付きの = と矢印）", () => {
    for (const mods of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      expect(plainUpdate(start, keyOf("=", mods)).model).toEqual(plainUpdate(start, viewKey("=", mods)).model);
      expect(plainUpdate(start, keyOf("ArrowLeft", mods)).model).toEqual(plainUpdate(start, arrowKey("left", mods)).model);
    }
  });
});

describe("E・C: ボタンと同じ Model の変化（フォーカスを外す Command は付けない）", () => {
  const start = measured(plainContext, plainUpdate);

  it("E で右の列を隠し、もう一度の E で戻す。ClickedSide と同じ Model", () => {
    const hidden = plainUpdate(start, keyOf("E"));
    expect(hidden.model.mapSurface.viewing.sideHidden).toBe(true);
    expect(hidden.model).toEqual(plainUpdate(start, Message.ClickedSide()).model);
    expect(commandNames(hidden.commands)).toEqual([]);
    expect(plainUpdate(hidden.model, keyOf("E")).model.mapSurface.viewing.sideHidden).not.toBe(true);
  });

  it("C で字幕を隠し、もう一度の C で戻す。ToggledCaptions と同じ Model", () => {
    const hidden = plainUpdate(start, keyOf("C"));
    expect(hidden.model.captionsHidden).toBe(true);
    expect(hidden.model).toEqual(plainUpdate(start, Message.ToggledCaptions({ isOpen: false })).model);
    expect(commandNames(hidden.commands)).toEqual([]);
    const shown = plainUpdate(hidden.model, keyOf("C"));
    expect(shown.model.captionsHidden).toBe(false);
    expect(shown.model).toEqual(plainUpdate(hidden.model, Message.ToggledCaptions({ isOpen: true })).model);
  });
});

describe.each([
  ["録音なし", plainContext, plainUpdate],
  ["録音つき", audioContext, audioUpdate],
] as const)("見返しのキー（%s）", (_name, context, update) => {
  const at100 = stateAt(context, 100);

  it("Space・K は再生の切り替え（ClickedToggle と同じ Model と Command）", () => {
    const expected = update(at100, Message.ClickedToggle());
    for (const id of ["Space", "K"]) {
      const actual = update(at100, keyOf(id));
      expect(actual.model, id).toEqual(expected.model);
      expect(commandsOf(actual.commands), id).toEqual(commandsOf(expected.commands));
    }
    expect(update(at100, keyOf("K")).model.playback.playing).toBe(true);
  });

  it(", と . は反映の時刻への移動（ClickedPrev・ClickedNext と同じ）", () => {
    for (const [id, button] of [[",", Message.ClickedPrev()], [".", Message.ClickedNext()]] as const) {
      const actual = update(at100, keyOf(id));
      const expected = update(at100, button);
      expect(actual.model, id).toEqual(expected.model);
      expect(commandsOf(actual.commands), id).toEqual(commandsOf(expected.commands));
    }
    expect(update(at100, keyOf(",")).model.playback.time).toBeLessThan(100);
    expect(update(at100, keyOf(".")).model.playback.time).toBeGreaterThan(100);
  });

  it.each([
    ["J", 90],
    ["L", 110],
    ["Home", 0],
    ["End", DURATION],
  ])("%s で時刻が %i になり、録音つきなら <audio> も同じ時刻へ（SeekAudio）", (id, time) => {
    const result = update(at100, keyOf(id));
    expect(result.model.playback.time).toBe(time);
    expect(argsOf(result.commands, "SeekAudio")).toEqual(context === audioContext ? [{ time }] : []);
  });

  it("J・L は 10 秒ごとに続けて動く（同じ Model の上の続き）", () => {
    const after = feed(update, at100, [keyOf("L"), keyOf("L"), keyOf("J")]);
    expect(after.playback.time).toBe(110);
  });

  it("< は速さを 1 段下げ、> は 1 段上げる（reducer の規則）。時刻は動かさず、録音つきなら速さを <audio> に書く", () => {
    for (const [id, action] of [["<", "slower"], [">", "faster"]] as const) {
      const result = update(at100, keyOf(id));
      expect(result.model.playback.rate, id).toBe(playbackReducer(at100.playback, { type: action }, context.playback).rate);
      expect(result.model.playback.time, id).toBe(100);
      expect(commandNames(result.commands), id).toEqual(context === audioContext ? ["WriteAudioSettings"] : []);
    }
  });

  // 時刻を動かすキーは、manual・overview から自動のカメラへ戻す（viewport は移動後の時刻のマップに対する自動の位置）
  const NODE_HEIGHTS = { root: 40, n1: 40, n2: 40, n3: 40 };
  const autoViewportAt = (time: number) =>
    MapSurface.update(
      MapSurface.update(MapSurface.init(snapshotAt(context.timeline, time), "review", context.isMac), MapSurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: NODE_HEIGHTS })).model,
      MapSurfaceMessage.TickedAnimationFrame({ deltaMs: 500 }),
    ).model.viewport;
  const wheeled = (model: ReturnType<typeof stateAt>) =>
    update(model, surface(MapSurfaceMessage.WheeledMapSurface({ x: 0, y: 0, deltaX: 40, deltaY: 100, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false, timeStamp: 0 }))).model;
  const startsOf = (time: number) => {
    const base = measured(context, update, time);
    const overview = update(base, keyOf("F")).model;
    return [["manual", wheeled(base)], ["overview", overview], ["diff", update(overview, keyOf("F")).model]] as const;
  };
  const expectAutoAt = (result: ReturnType<Update>, before: ReturnType<typeof stateAt>, label: string) => {
    const expected = autoViewportAt(result.model.playback.time);
    expect(result.model.mapSurface.viewing.mode, label).toBe("auto");
    // 全体を見る状態の viewport は、自動の位置と同じになることがある。押す前と違うことを確かめるのは manual だけ
    if (before.mapSurface.viewing.mode === "manual") expect(before.mapSurface.viewport, label).not.toEqual(expected);
    // 補間が終わった（Tick 500 の後の）viewport が、自動の位置になる
    const settled = update(result.model, surface(MapSurfaceMessage.TickedAnimationFrame({ deltaMs: 500 }))).model;
    expect(Option.isNone(settled.mapSurface.motion), label).toBe(true);
    for (const axis of ["x", "y", "zoom"] as const) expect(settled.mapSurface.viewport[axis], `${label} ${axis}`).toBeCloseTo(expected[axis], 9);
  };

  it.each(["Space", "K", "J", "L", ",", ".", "Home", "End"])("%s: manual・overview・diff から自動に戻り、viewport は移動後の時刻の自動の位置になる", (id) => {
    for (const [name, before] of startsOf(100)) {
      expect(before.mapSurface.viewing.mode).toBe(name);
      expectAutoAt(update(before, keyOf(id)), before, `${id} ${name}`);
    }
  });

  it("時刻が変わらない操作（時刻 0 の Home・終わりの End）でも自動に戻る", () => {
    for (const [id, time] of [["Home", 0], ["End", DURATION]] as const) {
      for (const [name, before] of startsOf(time)) {
        const result = update(before, keyOf(id));
        expect(result.model.playback.time).toBe(time);
        expectAutoAt(result, before, `${id} ${name}`);
      }
    }
  });

  it("<・>・M と、⌘・Ctrl・Option 付きのキーは、見る状態を変えない", () => {
    for (const [name, before] of startsOf(100)) {
      for (const id of ["<", ">", ...(context === audioContext ? ["M"] : [])]) {
        expect(update(before, keyOf(id)).model.mapSurface, `${id} ${name}`).toEqual(before.mapSurface);
      }
      for (const mods of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
        for (const id of ["J", "Space", "Home"]) expect(update(before, keyOf(id, mods)).model, `${id} ${name}`).toEqual(before);
      }
    }
  });

  it("⌘・Ctrl・Option を押した見返しのキーは、何もしない", () => {
    for (const mods of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      for (const id of ["J", "Space", "<", "Home"]) {
        const result = update(at100, keyOf(id, mods));
        expect(result.model.playback, `${id} ${JSON.stringify(mods)}`).toEqual(at100.playback);
        expect(commandNames(result.commands), id).toEqual([]);
      }
    }
  });
});

describe("M（ミュート）: 録音つきの見返しだけ", () => {
  it("M でミュートし、もう一度で戻す。録音の設定を書くが、フォーカスは外さない（ボタンの ClickedMute との違い）", () => {
    const start = stateAt(audioContext, 100);
    const muted = audioUpdate(start, keyOf("M"));
    expect(muted.model.playback.muted).toBe(true);
    expect(commandNames(muted.commands)).toEqual(["WriteAudioSettings"]);
    const unmuted = audioUpdate(muted.model, keyOf("M"));
    expect(unmuted.model.playback.muted).toBe(false);
    expect(muted.model.playback).toEqual(audioUpdate(start, Message.ClickedMute()).model.playback);
  });
});

describe("日本語入力がオンのとき・押したままの繰り返し: 本物の stream の出力を update に渡す", () => {
  const screen: Screen = "review";
  const update = plainUpdate;
  const start = withSelection(update, measured(plainContext, update));

  // イベントを stream に流して届いた Message を順に並べ、update に渡して畳んだ Model
  const viaStream = async (inits: readonly KeyInit[]) => {
    const { perEvent } = await pressEach((target) => keyPressStream({ screen, hasSelection: () => true, target }), inits.map((init) => keydown(init)));
    return { messages: perEvent.flat() as Message[], model: feed(update, start, perEvent.flat() as Message[]) };
  };
  const direct = (...messages: Message[]) => feed(update, start, messages);

  it("変換中（key が Process）の F で全体を見る状態になり、もう一度の F で変わったところを見る状態になる", async () => {
    const f = { key: "Process", code: "KeyF", isComposing: true };
    const once = await viaStream([f]);
    expect(once.model.mapSurface.viewing.mode).toBe("overview");
    expect(once.model).toEqual(direct(keyOf("F")));
    const twice = await viaStream([f, f]);
    expect(twice.model.mapSurface.viewing.mode).toBe("diff");
    expect(twice.model).toEqual(direct(keyOf("F"), keyOf("F")));
  });

  it("全角の ＝（拡大）と、変換中の Process の Equal は、半角の = と同じ結果になる", async () => {
    const expected = direct(keyOf("="));
    expect(expected.mapSurface.viewing).not.toEqual(start.mapSurface.viewing);
    expect((await viaStream([{ key: "＝", code: "Equal" }])).model).toEqual(expected);
    expect((await viaStream([{ key: "Process", code: "Equal", isComposing: true }])).model).toEqual(expected);
  });

  it("変換中の Slash（Shift）は ? として受けて、キーの一覧が開く", async () => {
    const { model } = await viaStream([{ key: "Process", code: "Slash", shiftKey: true, isComposing: true }]);
    expect(model.keyList.isOpen).toBe(true);
  });

  it("キーを押したままの繰り返し（repeat: true の keydown）でも、1 回ごとに結果が積み上がる: = を 3 回で 3 段、1 回とは違う", async () => {
    const held = { key: "=", repeat: true };
    const three = await viaStream([held, held, held]);
    expect(three.messages).toHaveLength(3);
    expect(three.model).toEqual(direct(keyOf("="), keyOf("="), keyOf("=")));
    const one = await viaStream([held]);
    expect(three.model.mapSurface.viewport).not.toEqual(one.model.mapSurface.viewport);
  });

  it("押したままの矢印も、1 回ごとに選択が動く（繰り返し 2 回 = 矢印を 2 回押した結果）", async () => {
    const held = { key: "ArrowRight", repeat: true };
    const twice = await viaStream([held, held]);
    expect(twice.model).toEqual(direct(keyOf("ArrowRight"), keyOf("ArrowRight")));
  });

  it("押したままの J（10 秒戻る）は、録音つきでも 1 回ごとに <audio> へ時刻を書く", async () => {
    const audioStart = stateAt(audioContext, 100);
    const { perEvent } = await pressEach((target) => keyPressStream({ screen: "reviewAudio", hasSelection: () => false, target }), [keydown({ key: "j", repeat: true }), keydown({ key: "j", repeat: true })]);
    const seeks: unknown[] = [];
    let model = audioStart;
    for (const message of perEvent.flat() as Message[]) {
      const result = audioUpdate(model, message);
      model = result.model;
      seeks.push(...argsOf(result.commands, "SeekAudio"));
    }
    expect(seeks).toEqual([{ time: 90 }, { time: 80 }]);
  });

  it("表のすべてのバインディングを流して update に渡しても、Model は本物の Schema を通る", async () => {
    const inits = bindingsOf("reviewAudio").map((b) => eventOfBinding(b.keys));
    const { perEvent } = await pressEach((target) => keyPressStream({ screen: "reviewAudio", hasSelection: () => true, target }), inits);
    let model = withSelection(audioUpdate, measured(audioContext, audioUpdate));
    for (const message of perEvent.flat() as Message[]) {
      model = audioUpdate(model, message).model;
      expect(Schema.is(Model)(model), JSON.stringify(message)).toBe(true);
    }
  });
});
