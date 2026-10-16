import { Slider } from "@foldkit/ui";
import { Option } from "effect";
import { given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";
import { Message as MapSurfaceMessage } from "../src/app/mapSurface/message.ts";
import { init, type Model } from "../src/app/review/main.ts";
import { Message } from "../src/app/review/message.ts";
import { shownText } from "../src/app/sessionLayout/toast.ts";
import { audioApp, audioContext, commandNames, DURATION, plainApp, plainContext, restartedBlink, settleNotice, sideHiddenOf, stateAt } from "./reviewHarness.ts";

// 見返しを 1 つのプログラムに組み上げた（Issue #826）update の Story。
// 見る状態（表示面の viewing）を、人が時刻を動かすすべての操作・右の列と字幕の操作・見る状態の知らせとつなげたことを、同じ Model の上の続きで見る。
// 会議の長さは 200 秒。反映は 10・100・160 秒

const NO_MODIFIERS = { metaKey: false, ctrlKey: false, altKey: false };
type Mods = Partial<typeof NO_MODIFIERS>;
const keyOf = (id: string, mods: Mods = {}) => Message.PressedKey({ key: id as never, ...NO_MODIFIERS, ...mods });
const surface = (message: MapSurfaceMessage) => Message.GotMapSurfaceMessage({ message });
const seekTo = (direction: "Min" | "Max", value: number) => Message.GotSeekSliderMessage({ message: Slider.Message.PressedKeyboardNavigation({ direction, value }) });
const wheel = (deltaY: number) => surface(MapSurfaceMessage.WheeledMapSurface({ x: 0, y: 0, deltaX: 0, deltaY, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false, timeStamp: 0 }));

const MANUAL = "動かしています・議題が変わるか Esc で今の議題へ・? でキー一覧";
const DIFF = "変わったところを見ています・Esc で戻る・? でキー一覧";
const OVERVIEW = "全体を見ています・F で変わったところへ・Esc で戻る・? でキー一覧";

type Context = typeof plainContext;
type App = typeof plainApp;
const appOf = (context: Context): App => (context === plainContext ? plainApp : audioApp);

// 表示面を測り終えた、時刻 time の Model
const measured = (context: Context, time: number, patch: Partial<Model["playback"]> = {}): Model =>
  appOf(context).update(stateAt(context, time, patch), surface(MapSurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { root: 40, n1: 40, n2: 40, n3: 40 } }))).model;
// = で拡大した（見る状態が manual の）Model
const manualAt = (context: Context, time: number, patch: Partial<Model["playback"]> = {}): Model => {
  const manual = appOf(context).update(measured(context, time, patch), keyOf("=")).model;
  expect(manual.mapSurface.viewing.mode).toBe("manual");
  return manual;
};

describe.each([
  ["録音なし", plainContext],
  ["録音つき", audioContext],
] as const)("人が時刻を動かすすべての操作で、止めた見る状態は自動に戻る（%s）", (_name, context) => {
  const { update } = appOf(context);
  const operations: ReadonlyArray<readonly [string, Message]> = [
    ["▶（再生・止める）のボタン", Message.ClickedToggle()],
    ["反映の前のボタン", Message.ClickedPrev()],
    ["反映の後のボタン", Message.ClickedNext()],
    ["シークバー", seekTo("Min", 150)],
    ["Space", keyOf("Space")],
    ["K", keyOf("K")],
    ["J", keyOf("J")],
    ["L", keyOf("L")],
    ["反映の前（,）", keyOf(",")],
    ["反映の後（.）", keyOf(".")],
    ["Home", keyOf("Home")],
    ["End", keyOf("End")],
  ];

  it.each(operations)("%s", (_label, operation) => {
    const manual = manualAt(context, 150);
    const result = update(manual, operation);
    expect(result.model.mapSurface.viewing.mode).toBe("auto");
  });

  it("全体を見ている間（overview）も、時刻を動かすボタンで自動に戻る", () => {
    const overview = update(measured(context, 150), keyOf("F")).model;
    expect(overview.mapSurface.viewing.mode).toBe("overview");
    expect(update(overview, Message.ClickedPrev()).model.mapSurface.viewing.mode).toBe("auto");
  });

  it("差分を見ている間（diff）も、時刻を動かすボタン・キーで自動に戻る。F → F で差分を見る状態に入るのは、最後の反映で変わったノードがあるとき", () => {
    const overview = update(measured(context, 150), keyOf("F")).model;
    const diff = update(overview, keyOf("F")).model;
    expect(diff.mapSurface.viewing.mode).toBe("diff");
    for (const operation of [Message.ClickedPrev(), Message.ClickedNext(), keyOf("J"), keyOf(","), seekTo("Min", 150)]) {
      expect(update(diff, operation).model.mapSurface.viewing.mode).toBe("auto");
    }
  });

  it("時刻を動かさない操作（速さ・ミュート・自動で進む時計・音声の時刻の通知）では、止めた見る状態のまま", () => {
    const playing = manualAt(context, 150, { playing: true });
    const untouched: ReadonlyArray<Message> = [
      keyOf(">"),
      keyOf("<"),
      Message.ClickedMute(),
      context === plainContext ? Message.TickedFrame({ ms: 1000 }) : Message.UpdatedAudioTime({ time: 151 }),
    ];
    for (const operation of untouched) expect(update(playing, operation).model.mapSurface.viewing.mode, JSON.stringify(operation)).toBe("manual");
  });
});

describe("右の列の出し入れは、表示面の見る状態（viewing.sideHidden）が 1 か所で持つ", () => {
  const { update } = plainApp;

  it("E で隠し、もう一度の E で戻す。見返しの Model に別の欄を持たない", () => {
    const start = measured(plainContext, 100);
    const hidden = update(start, keyOf("E")).model;
    expect(hidden.mapSurface.viewing.sideHidden).toBe(true);
    expect("sideHidden" in hidden).toBe(false);
    expect(update(hidden, keyOf("E")).model.mapSurface.viewing.sideHidden).not.toBe(true);
  });

  it("右の列のボタン（ClickedSide）は E と同じ見る状態の変化にして、フォーカスを外す", () => {
    const start = measured(plainContext, 100);
    const byKey = update(start, keyOf("E"));
    const byButton = update(start, Message.ClickedSide());
    expect(byButton.model).toEqual(byKey.model);
    expect(commandNames(byButton.commands)).toEqual(["ReleaseFocus"]);
    expect(commandNames(byKey.commands)).toEqual([]);
  });

  it("⌘・Ctrl・Option と一緒の E では隠さない", () => {
    const start = measured(plainContext, 100);
    for (const mods of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      expect(update(start, keyOf("E", mods)).model.mapSurface.viewing.sideHidden, JSON.stringify(mods)).not.toBe(true);
    }
  });

  it("隠していた列を E でもボタンでも出すと、列の幅だけのカメラのずらしが保留になる", () => {
    const hiddenFromStart = sideHiddenOf(measured(plainContext, 100));
    expect(update(hiddenFromStart, keyOf("E")).model.mapSurface.pendingShift).toBe(true);
    expect(update(hiddenFromStart, Message.ClickedSide()).model.mapSurface.pendingShift).toBe(true);
  });

  it("列を出し入れしても、字幕の状態は変わらない", () => {
    const start = measured(plainContext, 100);
    expect(update(update(start, keyOf("E")).model, Message.ClickedSide()).model.captionsHidden).toBe(false);
  });
});

describe("字幕の出し入れ（C・字幕のボタン）は字幕だけを変え、カメラと 10 秒の計り直しは変えない", () => {
  const { update } = plainApp;

  it("C もボタンも captionsHidden だけを替え、表示面の状態は同じまま", () => {
    const start = measured(plainContext, 100);
    const byKey = update(start, keyOf("C")).model;
    const byButton = update(start, Message.ToggledCaptions({ isOpen: false })).model;
    expect(byKey.captionsHidden).toBe(true);
    expect(byButton.captionsHidden).toBe(true);
    expect(byKey.mapSurface).toEqual(start.mapSurface);
    expect(byButton.mapSurface).toEqual(start.mapSurface);
    expect(update(byKey, keyOf("C")).model.captionsHidden).toBe(false);
  });
});

describe("見る状態の知らせは、どの入口で mode が変わっても追従する", () => {
  const { update } = plainApp;

  const settle = settleNotice<Model, Message>;
  const noticeOf = (m: Model): string | null => Option.getOrNull(shownText(m.sessionLayout.viewingToast));

  it("最初は出ていない。キーで拡大すると『動かしています』、F で『全体を見ています』、時刻を動かすボタンで消える", () => {
    story(
      update,
      given(measured(plainContext, 150)),
      model((m) => expect(noticeOf(m)).toBeNull()),
      message(keyOf("=")),
      settle,
      model((m) => expect(noticeOf(m)).toBe(MANUAL)),
      message(keyOf("F")),
      settle,
      model((m) => expect(noticeOf(m)).toBe(OVERVIEW)),
      message(Message.ClickedPrev()),
      settle,
      model((m) => expect(noticeOf(m)).toBeNull()),
    );
  });

  it("F を 2 回押すと『変わったところを見ています』に入れ替わり、時刻を動かすボタンで消える。Esc でも消える", () => {
    story(
      update,
      given(measured(plainContext, 150)),
      message(keyOf("F")),
      settle,
      model((m) => expect(noticeOf(m)).toBe(OVERVIEW)),
      message(keyOf("F")),
      settle,
      model((m) => {
        expect(m.mapSurface.viewing.mode).toBe("diff");
        expect(noticeOf(m)).toBe(DIFF);
      }),
      message(Message.ClickedPrev()),
      settle,
      model((m) => expect(noticeOf(m)).toBeNull()),
      message(keyOf("F")),
      settle,
      message(keyOf("F")),
      settle,
      model((m) => expect(noticeOf(m)).toBe(DIFF)),
      message(keyOf("Escape")),
      settle,
      model((m) => {
        expect(m.mapSurface.viewing.mode).toBe("auto");
        expect(noticeOf(m)).toBeNull();
      }),
    );
  });

  it("ホイールで動かすと出て、触らずに 10 秒たって自動に戻ると消える", () => {
    story(
      update,
      given(measured(plainContext, 150)),
      message(wheel(100)),
      settle,
      model((m) => {
        expect(m.mapSurface.viewing.mode).toBe("manual");
        expect(noticeOf(m)).toBe(MANUAL);
      }),
      message(surface(MapSurfaceMessage.ElapsedIdleTime())),
      settle,
      model((m) => {
        expect(m.mapSurface.viewing.mode).toBe("auto");
        expect(noticeOf(m)).toBeNull();
      }),
    );
  });

  it("シークバーで時刻を動かしても消える。同じ mode の間は文を入れ替えない", () => {
    story(
      update,
      given(measured(plainContext, 150)),
      message(keyOf("=")),
      settle,
      message(keyOf("-")),
      settle,
      model((m) => expect(noticeOf(m)).toBe(MANUAL)),
      message(seekTo("Max", 150)),
      restartedBlink,
      settle,
      model((m) => expect(noticeOf(m)).toBeNull()),
    );
  });

  it("見返しでは取り込みの状態を受けない（取り込みの知らせの欄は空のまま）", () => {
    const m = init(plainContext);
    expect(Option.isNone(m.sessionLayout.intake)).toBe(true);
    expect(m.sessionLayout.intakeToast.entries).toEqual([]);
    expect(m.sessionLayout.screenToast.entries).toEqual([]);
    expect(m.sessionLayout.tapToast.entries).toEqual([]);
  });
});

describe("選んだノードが消える時刻へ動かすと、見る状態に関わらず選択は移り先へ移る", () => {
  const { update } = plainApp;
  const selectChangeAtEnd = (): Model => {
    const start = measured(plainContext, DURATION);
    return update(start, surface(MapSurfaceMessage.ClickedChangeItem({ nodeId: "n3" }))).model;
  };

  it("変わったことの項目を選ぶと見る状態は manual。その状態で先頭へ戻ると、選んだノードは今のマップに無いので、移り先（残っているノード）が選ばれる", () => {
    const selected = selectChangeAtEnd();
    expect(selected.mapSurface.viewing.mode).toBe("manual");
    expect(selected.mapSurface.viewing.selection?.id).toBe("n3");
    const atStart = update(selected, keyOf("Home")).model;
    expect(atStart.playback.time).toBe(0);
    expect(atStart.mapSurface.viewing.selection?.id).not.toBe("n3");
  });
});
