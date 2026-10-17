import { Duration, Option } from "effect";
import * as Animation from "@foldkit/ui/animation";
import * as Toast from "@foldkit/ui/toast";
import type { HtmlBuilder } from "foldkit/html";
import { attr, blur, click, Command, expect as expectScene, find, findAll, given, keydown, Mount, scene, selector, submit, Subscription, tap, textContent, type as typeInto, type SceneSimulation } from "foldkit/scene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTION_BUBBLE_WIDTH, CAPTION_PALETTE_SIZE, type DisplayBubble } from "../src/captions.ts";
import { RESUMED_NOTICE_MS } from "../src/intake.ts";
import { init, update, view } from "../src/app/sessionLayout/main.ts";
import { Message } from "../src/app/sessionLayout/message.ts";
import { FocusSpeakerNameInput, RequestSpeakerName } from "../src/app/sessionLayout/command.ts";
import { SlideCaptions } from "../src/app/sessionLayout/mount.ts";
import { SPEAKER_NAME_COLORS } from "../src/app/sessionLayout/speakerName.ts";
import { semanticClassesOf } from "./semanticClasses.ts";

// セッションの画面の部品（Issue #820）の Scene。描いた view から入り、字幕・取り込みの知らせ・共有画面の知らせ・見る状態の知らせが
// 今の画面（React の SessionView）と同じ位置・同じ要素・同じ文言で出ること、出入りで他の要素の並びが変わらないことを見る。
// Scene は座標を持たないので「位置」は、`.layout` の直下の並びと、`.map`・`.captions`・`.side` の要素と class で確かめる（実際の座標は切り替えの段の heavy IT）。
// 知らせは外（WebSocket のフレーム・見る状態の Model・C のキー）から届くので、Subscription.emit で流す。

type VNode = Parameters<typeof textContent>[0];
type Sim = SceneSimulation<ReturnType<typeof init>, Message>;

// 表示面（#814）・右の列（#821）・キーの一覧（#822）の中身は、この部品の外。差し込み口に仮の要素を渡す（キーの一覧は閉じていれば null）
const slots = (h: HtmlBuilder<Message>, keyList: boolean = false) => ({
  map: h.div([h.Class("map-surface")], []),
  keyList: keyList ? h.div([h.Class("key-list__anchor")], []) : null,
  side: h.div([h.Class("side")], [h.div([h.Class("evidence-panel")], [])]),
});
const app = { update, view: (model: ReturnType<typeof init>, h: HtmlBuilder<Message>) => view(model, h, slots(h)) };
const appWithKeyList = { update, view: (model: ReturnType<typeof init>, h: HtmlBuilder<Message>) => view(model, h, slots(h, true)) };

const INTERRUPTED = "音声の取り込みが途切れました。再開しています";
const STOPPED = "音声の取り込みが止まっています";
const RESUMED = "再開しました";
const MANUAL = "動かしています・議題が変わるか Esc で今の議題へ・? でキー一覧";
const DIFF = "変わったところを見ています・Esc で戻る・? でキー一覧";
const OVERVIEW = "全体を見ています・F で変わったところへ・Esc で戻る・? でキー一覧";
const SCREEN = "共有画面は使っていません（画面収録の許可がありません。システム設定で、起動したターミナルに許可を与え、ターミナルを開き直す）";
const TAP = "相手の音声が届いていません（出力の機器を切り替えた後に起きることがあります。cli stop の後、cli start で始め直してください）";
const PAUSED = { status: "paused", reason: "ChatGPT の利用上限" } as const;

// ---- 描いた木を読む道具 ----
const elements = (vnode: VNode): VNode[] => (vnode.children ?? []).filter((c): c is VNode => typeof c !== "string" && c.sel !== undefined);
const classOf = (vnode: VNode): string => Option.getOrElse(attr(vnode, "class"), () => "");
const hasClass = (vnode: VNode, name: string): boolean => classOf(vnode).split(" ").includes(name);
const named = (vnode: VNode): string => `${vnode.sel}.${semanticClassesOf(classOf(vnode)).join(".")}`;
const layoutOf = (html: VNode): VNode => Option.getOrThrow(find(".layout")(html));
const mapOf = (html: VNode): VNode => Option.getOrThrow(find(".map")(html));
const outline = (html: VNode): string[] => elements(layoutOf(html)).map(named);
const mapOutline = (html: VNode): string[] => elements(mapOf(html)).map(named);
const directChild = (html: VNode, name: string): VNode | undefined => elements(layoutOf(html)).find((c) => hasClass(c, name));

// マップ・字幕・右の列の「並びと class」。知らせの出入りで変わってはいけないもの
const STABLE = ["map", "captions", "side"];
const stableParts = (html: VNode) => ({
  layout: named(layoutOf(html)),
  parts: elements(layoutOf(html)).filter((c) => STABLE.some((name) => hasClass(c, name))).map(named),
  map: named(mapOf(html)),
  mapSlot: elements(mapOf(html)).filter((c) => hasClass(c, "map-surface")).map(named),
  side: elements(Option.getOrThrow(find(".side")(html))).map(named),
});

// 出入りの動き（data-enter 等）・スワイプ・ホバーで時間を止めるハンドラ・インラインの style を持たない、素の要素であること
const expectPlain = (vnode: VNode | undefined) => {
  expect(vnode).toBeDefined();
  const data = vnode!.data ?? {};
  expect(data.style ?? {}).toEqual({});
  expect(Object.keys(data.on ?? {})).toEqual([]);
  const names = [...Object.keys(data.attrs ?? {}), ...Object.keys(data.props ?? {}), ...Object.keys(data.dataset ?? {})];
  expect(names.filter((n) => n.startsWith("data-") || n === "style")).toEqual([]);
};

// ---- Toast の保留の Command を解く道具（Story と同じ）----
const settle = (simulation: Sim): Sim => {
  const pending = simulation.commands.find((c) => c.name === "WaitForPaint" || c.name === "WaitForAnimationSettled");
  if (pending === undefined) return simulation;
  const generation = pending.args?.generation as number;
  return settle(
    pending.name === "WaitForPaint"
      ? Command.resolve(Animation.WaitForPaint({ generation }), Animation.Message.CompletedWaitForPaint({ generation }))(simulation)
      : Command.resolve(Animation.WaitForAnimationSettled({ id: pending.args?.id as string, generation }), Animation.Message.EndedAnimation({ generation }))(simulation),
  );
};
const timers = (simulation: Sim) => simulation.commands.filter((c) => c.name === "WaitBeforeDismissal");
const expire = (simulation: Sim): Sim => {
  const { entryId, version, duration } = timers(simulation)[0]!.args as { entryId: string; version: number; duration: Duration.Duration };
  return Command.resolve(Toast.WaitBeforeDismissal({ entryId, version, duration }), Toast.Message.CompletedWaitBeforeDismissal({ entryId, version }))(simulation);
};

// Scene は保留の Command を残したまま次の Message を流せない（story と同じ理由で、保留のタイマーは「何も起こさない結果」で閉じ、遅れて届く本物の時間切れは別に流す）
const closeTimerQuietly = (simulation: Sim): Sim => {
  const { entryId, version, duration } = timers(simulation)[0]!.args as { entryId: string; version: number; duration: Duration.Duration };
  return Command.resolve(Toast.WaitBeforeDismissal({ entryId, version, duration }), Toast.Message.CompletedWaitBeforeDismissal({ entryId, version: version + 1000 }))(simulation);
};
const lateTimer = (n: number) => Subscription.emit(Message.GotIntakeToastMessage({ message: Toast.Message.CompletedWaitBeforeDismissal({ entryId: `${init().intakeToast.id}-entry-${n}`, version: 0 }) }));

const emit = (message: Message) => Subscription.emit(message);
const intake = (status: "running" | "interrupted" | "stopped" | "none") => emit(Message.ReceivedIntakeStatus({ status }));
const screen = (text: string | null) => emit(Message.ReceivedScreenNotice({ text: Option.fromNullishOr(text) }));
const tapNotice = (text: string | null) => emit(Message.ReceivedTapNotice({ text: Option.fromNullishOr(text) }));
const selfPause = (paused: boolean, reason: "手動" | "自動" = "手動") => emit(Message.ReceivedSelfPause({ selfPaused: paused ? reason : false }));
const viewing = (mode: "auto" | "manual" | "overview" | "diff") => emit(Message.ChangedViewingMode({ mode }));
const displayBubble = (id: string, text: string, extra: Partial<DisplayBubble> = {}): DisplayBubble => ({ id, side: "left", name: Option.some("相手 A"), label: Option.none(), nameState: "settled", colorIndex: 1, text, settledLength: text.length, ...extra });
const speak = (text: string) => emit(Message.ChangedCaptions({ captions: { _tag: "Bubbles", bubbles: text === "" ? [] : [displayBubble("a", text)] } }));

let stableBefore: ReturnType<typeof stableParts>;
const settled = Mount.resolve(SlideCaptions, Message.CompletedSlideCaptions());
const withSpeaking = { ...init(), captions: { _tag: "Bubbles" as const, bubbles: [displayBubble("a", "議題は採用です。"), displayBubble("m", "はい", { side: "right", name: Option.none(), colorIndex: 0 })] } };

describe("sessionLayout の Scene: 字幕", () => {
  it("話している文字がなければ .captions を描かない", () => {
    scene(app, given(init()), expectScene(selector(".captions")).toBeAbsent());
  });

  it("話す文字が変わると、同じ部品の上で吹き出しの文が替わる。空に戻ると .captions ごと消える", () => {
    scene(
      app,
      given(init()),
      expectScene(selector(".captions")).toBeAbsent(),
      speak("一つ目です。"),
      settled,
      tap((s) => expect(findAll(".captions__bubble")(s.html).map(textContent)).toEqual(["一つ目です。"])),
      speak("一つ目です。二つ目です。"),
      tap((s) => expect(findAll(".captions__bubble")(s.html).map(textContent)).toEqual(["一つ目です。二つ目です。"])),
      speak(""),
      Mount.expectEnded(SlideCaptions),
      expectScene(selector(".captions")).toBeAbsent(),
    );
  });

  it(".captions は .layout の直下にあり、.map の中には入らない（列を出し入れしても窓の横幅の中央から動かさないため）", () => {
    scene(
      app,
      given(withSpeaking),
      settled,
      tap((s) => {
        expect(directChild(s.html, "captions")).toBeDefined();
        expect(findAll(".captions")(mapOf(s.html))).toHaveLength(0);
      }),
    );
  });

  it("Disclosure の panel として描く（id と、開いている間の data-open が付く）。出す側から隠す側へ、同じ画面の上で切り替わる", () => {
    scene(
      app,
      given(withSpeaking),
      settled,
      tap((s) => {
        const captions = directChild(s.html, "captions")!;
        expect(Option.isSome(attr(captions, "id"))).toBe(true);
        expect(Option.isSome(attr(captions, "data-open"))).toBe(true);
      }),
      emit(Message.ToggledCaptions({ isOpen: false })),
      Mount.expectEnded(SlideCaptions),
      expectScene(selector(".captions")).toBeAbsent(),
      tap((s) => expect(findAll(".captions__bubble")(s.html)).toHaveLength(0)),
      emit(Message.ToggledCaptions({ isOpen: true })),
      settled,
      expectScene(selector(".captions")).toExist(),
      expectScene(selector(".captions__bubble")).toExist(),
    );
  });

  it("隠している間も話す文字は取り込み続け、出し直すと続きが出る", () => {
    scene(
      app,
      given(withSpeaking),
      settled,
      emit(Message.ToggledCaptions({ isOpen: false })),
      Mount.expectEnded(SlideCaptions),
      speak("議題は採用です。次へ進みます。"),
      expectScene(selector(".captions")).toBeAbsent(),
      emit(Message.ToggledCaptions({ isOpen: true })),
      settled,
      tap((s) => expect(findAll(".captions__bubble")(s.html).map(textContent)).toEqual(["議題は採用です。次へ進みます。"])),
    );
  });

  it("隠した状態から始めても .captions を描かない", () => {
    scene(app, given({ ...withSpeaking, captionsHidden: true }), expectScene(selector(".captions")).toBeAbsent());
  });
});

// Issue #1022: 会議中の字幕（話者つきの吹き出し）。名前の欄は 1 つの部品（speakerName.ts）から作る
describe("sessionLayout の Scene: 字幕の吹き出し", () => {
  const bubble = (id: string, extra: Partial<DisplayBubble> = {}): DisplayBubble => ({ id, side: "left", name: Option.some("相手 A"), label: Option.none(), nameState: "settled", colorIndex: 1, text: id, settledLength: (extra.text ?? id).length, ...extra });
  const withBubbles = (...bubbles: DisplayBubble[]) => ({ ...init(), captions: { _tag: "Bubbles" as const, bubbles } });
  const rows = (html: VNode) => findAll(".captions__row")(html);

  it("吹き出しが無ければ .captions を描かない", () => {
    scene(app, given(init()), expectScene(selector(".captions")).toBeAbsent());
  });

  it("吹き出しごとに 1 行（.captions__row）を、渡された順（話し始めの順）に描く。行は 名前の欄 + 吹き出し で、aria-live=polite の .captions の中にある", () => {
    scene(
      app,
      given(withBubbles(bubble("a", { text: "こんにちは" }), bubble("b", { side: "right", name: Option.none(), colorIndex: 0, text: "はい" }))),
      settled,
      expectScene(selector(".captions")).toHaveAttr("aria-live", "polite"),
      tap((s) => {
        expect(rows(s.html)).toHaveLength(2);
        expect(findAll(".captions__bubble")(s.html).map(textContent)).toEqual(["こんにちは", "はい"]);
        for (const row of rows(s.html)) expect(elements(row).map((c) => semanticClassesOf(classOf(c))[0])).toEqual(["captions__name", "captions__bubble"]);
      }),
    );
  });

  it("相手は左、自分は右に寄せる（行の寄せ方）", () => {
    scene(
      app,
      given(withBubbles(bubble("a"), bubble("m", { side: "right", name: Option.none() }))),
      settled,
      tap((s) => {
        const [left, right] = rows(s.html);
        expect(classOf(left!)).toContain("justify-start");
        expect(classOf(right!)).toContain("justify-end");
      }),
    );
  });

  it("名前の欄は、名前があるときだけ名前を出し、無いとき（自分・同じ人が続くとき）も欄は残す。仮は薄く、確定は通常の濃さ", () => {
    scene(
      app,
      given(withBubbles(bubble("a", { name: Option.some("相手 B"), nameState: "provisional" }), bubble("a2", { name: Option.none() }), bubble("m", { side: "right", name: Option.none() }))),
      settled,
      tap((s) => {
        const names = findAll(".captions__name")(s.html);
        expect(names.map(textContent)).toEqual(["相手 B", "", ""]);
        expect(classOf(names[0]!)).toContain("opacity-50");
        expect(classOf(names[1]!)).not.toContain("opacity");
      }),
    );
  });

  it("吹き出しの幅は定数（CAPTION_BUBBLE_WIDTH）から渡す CSS の変数で決まり、文字の量では変わらない。幅の式は styles.css", () => {
    scene(
      app,
      given(withBubbles(bubble("short", { text: "はい" }), bubble("long", { text: "これはとても長い文章です。".repeat(10) }))),
      settled,
      tap((s) => {
        const style = Option.getOrThrow(find(".captions")(s.html)).data?.style ?? {};
        expect(style["--caption-bubble-ratio"]).toBe(String(CAPTION_BUBBLE_WIDTH));
      }),
    );
  });

  it("名前の色の数は、色の番号の数（CAPTION_PALETTE_SIZE）と同じ", () => {
    expect(SPEAKER_NAME_COLORS).toHaveLength(CAPTION_PALETTE_SIZE);
  });

  it("吹き出しに塗り・枠・角丸・影・バッジを付けない。文字の色だけを話者ごとに変える", () => {
    scene(
      app,
      given(withBubbles(bubble("a", { colorIndex: 1 }), bubble("b", { colorIndex: 2 }))),
      settled,
      tap((s) => {
        const [a, b] = findAll(".captions__bubble")(s.html);
        for (const node of [...rows(s.html), a!, b!, ...findAll(".captions__name")(s.html)]) expect(classOf(node)).not.toMatch(/\b(bg-|shadow|border|rounded|badge)/);
        expect(classOf(a!)).not.toBe(classOf(b!));
      }),
    );
  });

  describe("確定の分と途中の分（settledLength）", () => {
    const bubbleOf = (html: VNode) => Option.getOrThrow(find(".captions__bubble")(html));
    const pendingOf = (html: VNode) => findAll(".captions__pending")(html);
    const cursorsOf = (html: VNode) => findAll(".captions__cursor")(html);

    it("全部確定の吹き出しは、途中の分の要素もカーソルも出さない。文字は今のまま（薄くしない）", () => {
      scene(
        app,
        given(withBubbles(bubble("a", { text: "こんにちは", settledLength: 5 }))),
        settled,
        tap((s) => {
          expect(pendingOf(s.html)).toHaveLength(0);
          expect(cursorsOf(s.html)).toHaveLength(0);
          expect(textContent(bubbleOf(s.html))).toBe("こんにちは");
          expect(classOf(bubbleOf(s.html))).not.toContain("opacity");
        }),
      );
    });

    it("途中の分は別の要素で不透明度 0.5。確定の分は薄くならず、全体の文字は変わらない", () => {
      scene(
        app,
        given(withBubbles(bubble("a", { text: "こんにちは元気", settledLength: 5 }))),
        settled,
        tap((s) => {
          const pending = pendingOf(s.html);
          expect(pending).toHaveLength(1);
          expect(classOf(pending[0]!)).toContain("opacity-50");
          expect(textContent(pending[0]!)).toBe("元気");
          expect(textContent(bubbleOf(s.html))).toBe("こんにちは元気");
          expect(classOf(bubbleOf(s.html))).not.toContain("opacity");
        }),
      );
    });

    it("途中の分は話者の色を保つ: 途中の分の要素に色の class を付けず、親の吹き出しの色を受け継ぐ", () => {
      scene(
        app,
        given(withBubbles(bubble("a", { text: "こんにちは元気", settledLength: 5, colorIndex: 2 }))),
        settled,
        tap((s) => {
          expect(classOf(pendingOf(s.html)[0]!)).not.toMatch(/\b(text-|bg-|shadow|border|rounded|badge)/);
          expect(classOf(bubbleOf(s.html))).toMatch(/\btext-/);
        }),
      );
    });

    it("確定が 0 文字（途中だけ）の吹き出しは、本文が全部途中の分になる", () => {
      scene(
        app,
        given(withBubbles(bubble("a", { text: "こんにち", settledLength: 0 }))),
        settled,
        tap((s) => {
          expect(textContent(pendingOf(s.html)[0]!)).toBe("こんにち");
          expect(textContent(bubbleOf(s.html))).toBe("こんにち");
        }),
      );
    });

    it("カーソルは、途中の分がある吹き出しだけに 1 つ。途中の分の中の末尾にあり、文字を持たない", () => {
      scene(
        app,
        given(withBubbles(bubble("a", { text: "こんにちは元気", settledLength: 5 }), bubble("b", { text: "はい", settledLength: 2 }))),
        settled,
        tap((s) => {
          const cursors = cursorsOf(s.html);
          expect(cursors).toHaveLength(1);
          expect(textContent(cursors[0]!)).toBe("");
          const pending = elements(pendingOf(s.html)[0]!);
          expect(hasClass(pending.at(-1)!, "captions__cursor")).toBe(true);
          const rowOfB = rows(s.html).find((r) => Option.getOrUndefined(attr(r, "data-caption-id")) === "b")!;
          expect(findAll(".captions__cursor")(rowOfB)).toHaveLength(0);
        }),
      );
    });

    it("途中の分が発言になると、同じ行（同じ id）のまま、途中の分の要素とカーソルが消えて普通の濃さになる", () => {
      scene(
        app,
        given(withBubbles(bubble("a", { text: "こんにちは", settledLength: 0 }))),
        settled,
        tap((s) => {
          expect(cursorsOf(s.html)).toHaveLength(1);
          expect(rows(s.html).map((r) => Option.getOrUndefined(attr(r, "data-caption-id")))).toEqual(["a"]);
        }),
        emit(Message.ChangedCaptions({ captions: { _tag: "Bubbles", bubbles: [bubble("a", { text: "こんにちは", settledLength: 5 })] } })),
        tap((s) => {
          expect(rows(s.html).map((r) => Option.getOrUndefined(attr(r, "data-caption-id")))).toEqual(["a"]);
          expect(pendingOf(s.html)).toHaveLength(0);
          expect(cursorsOf(s.html)).toHaveLength(0);
          expect(textContent(bubbleOf(s.html))).toBe("こんにちは");
        }),
      );
    });
  });

  it("吹き出しが入れ替わっても、同じ id の行は同じ行として残る（キーは id）。隠すと .captions ごと消え、出し直すと戻る", () => {
    scene(
      app,
      given(withBubbles(bubble("a"), bubble("b"))),
      settled,
      tap((s) => expect(rows(s.html).map((r) => attr(r, "data-caption-id")).map((v) => Option.getOrUndefined(v))).toEqual(["a", "b"])),
      emit(Message.ChangedCaptions({ captions: { _tag: "Bubbles", bubbles: [bubble("b"), bubble("c")] } })),
      tap((s) => expect(rows(s.html).map((r) => Option.getOrUndefined(attr(r, "data-caption-id")))).toEqual(["b", "c"])),
    );
  });
});

describe("sessionLayout の Scene: 取り込みの知らせ（今と同じ位置・文言・消える時間）", () => {
  it("知らせが無いときは .intake-notice を描かない", () => {
    scene(app, given(init()), expectScene(selector(".intake-notice")).toBeAbsent());
  });

  it("interrupted で .layout の直下に div.intake-notice[aria-live=polite] が出て、途切れの文になる。時間切れの Command は無い", () => {
    scene(
      app,
      given(init()),
      intake("interrupted"),
      settle,
      expectScene(selector(".intake-notice")).toHaveText(INTERRUPTED),
      expectScene(selector(".intake-notice")).toHaveAttr("aria-live", "polite"),
      tap((s) => {
        const notice = directChild(s.html, "intake-notice")!;
        expect(notice.sel).toBe("div");
        expect(timers(s)).toHaveLength(0);
      }),
    );
  });

  it("stopped で止まっている文が出る", () => {
    scene(app, given(init()), intake("stopped"), settle, expectScene(selector(".intake-notice")).toHaveText(STOPPED));
  });

  it("running だけ（接続直後）と none では出ない", () => {
    scene(app, given(init()), intake("running"), expectScene(selector(".intake-notice")).toBeAbsent(), intake("none"), expectScene(selector(".intake-notice")).toBeAbsent());
  });

  it("interrupted → running で文が「再開しました」に替わり、RESUMED_NOTICE_MS（Toast の duration）の時間切れで、その場で消える", () => {
    scene(
      app,
      given(init()),
      intake("interrupted"),
      settle,
      intake("running"),
      settle,
      expectScene(selector(".intake-notice")).toHaveText(RESUMED),
      tap((s) => {
        const pending = timers(s);
        expect(pending).toHaveLength(1);
        expect(Duration.toMillis(pending[0]!.args!.duration as Duration.Duration)).toBe(RESUMED_NOTICE_MS);
      }),
      expire,
      // 時間切れの直後（消える動きの Command を解く前）に、要素が DOM から消えている
      expectScene(selector(".intake-notice")).toBeAbsent(),
      settle,
      expectScene(selector(".intake-notice")).toBeAbsent(),
    );
  });

  it("「再開しました」の間に interrupted を受けると途切れの文に替わり、前の時間切れが遅れて届いても消えない", () => {
    scene(
      app,
      given(init()),
      intake("interrupted"),
      settle,
      intake("running"),
      settle,
      closeTimerQuietly,
      intake("interrupted"),
      settle,
      expectScene(selector(".intake-notice")).toHaveText(INTERRUPTED),
      lateTimer(1),
      settle,
      expectScene(selector(".intake-notice")).toHaveText(INTERRUPTED),
      tap((s) => expect(findAll(".intake-notice")(s.html)).toHaveLength(1)),
    );
  });

  it("文が替わる間も、.intake-notice は 1 つだけ（2 つの知らせが同時に DOM に出ない）", () => {
    scene(
      app,
      given(init()),
      intake("interrupted"),
      tap((s) => expect(findAll(".intake-notice")(s.html)).toHaveLength(1)),
      settle,
      intake("running"),
      tap((s) => expect(findAll(".intake-notice")(s.html).map(textContent)).toEqual([RESUMED])),
      settle,
      expire,
      settle,
    );
  });

  it("none（セッションの終わり）で消え、その後の running では「再開しました」を出さない", () => {
    scene(
      app,
      given(init()),
      intake("interrupted"),
      settle,
      intake("none"),
      expectScene(selector(".intake-notice")).toBeAbsent(),
      settle,
      intake("running"),
      expectScene(selector(".intake-notice")).toBeAbsent(),
    );
  });
});

describe("sessionLayout の Scene: 共有画面の知らせ（今と同じ位置・文言）", () => {
  it("知らせが無いときは .screen-notice を描かない", () => {
    scene(app, given(init()), expectScene(selector(".screen-notice")).toBeAbsent());
  });

  it("文を受けると .layout の直下に div.screen-notice[aria-live=polite] が出て、取り込みの知らせとは別の class で描く。時間切れの Command は無い", () => {
    scene(
      app,
      given(init()),
      screen(SCREEN),
      settle,
      expectScene(selector(".screen-notice")).toHaveText(SCREEN),
      expectScene(selector(".screen-notice")).toHaveAttr("aria-live", "polite"),
      expectScene(selector(".intake-notice")).toBeAbsent(),
      tap((s) => {
        const notice = directChild(s.html, "screen-notice")!;
        expect(notice.sel).toBe("div");
        expect(classOf(notice)).toBe("screen-notice");
        expect(timers(s)).toHaveLength(0);
      }),
    );
  });

  it("ローカルモード（.layout--local）でも .layout の直下の子のまま（`.layout--local > .screen-notice` の位置の決めが効く）", () => {
    scene(
      app,
      given({ ...init(), local: true }),
      screen(SCREEN),
      settle,
      tap((s) => {
        expect(hasClass(layoutOf(s.html), "layout--local")).toBe(true);
        expect(directChild(s.html, "screen-notice")).toBeDefined();
      }),
    );
  });

  it("null の frame を受けると、その場で消える", () => {
    scene(
      app,
      given(init()),
      screen(SCREEN),
      settle,
      screen(null),
      expectScene(selector(".screen-notice")).toBeAbsent(),
      settle,
      expectScene(selector(".screen-notice")).toBeAbsent(),
    );
  });
});

describe("sessionLayout の Scene: 相手の音声が届いていない知らせ（Issue #863。今と同じ位置・文言）", () => {
  it("知らせが無いときは .tap-notice を描かない", () => {
    scene(app, given(init()), expectScene(selector(".tap-notice")).toBeAbsent());
  });

  it("文を受けると .layout の直下に div.tap-notice[aria-live=polite] が出て、共有画面・取り込みの知らせとは別の class で描く。時間切れの Command は無い", () => {
    scene(
      app,
      given(init()),
      tapNotice(TAP),
      settle,
      expectScene(selector(".tap-notice")).toHaveText(TAP),
      expectScene(selector(".tap-notice")).toHaveAttr("aria-live", "polite"),
      expectScene(selector(".screen-notice")).toBeAbsent(),
      expectScene(selector(".intake-notice")).toBeAbsent(),
      tap((s) => {
        const notice = directChild(s.html, "tap-notice")!;
        expect(notice.sel).toBe("div");
        expect(classOf(notice)).toBe("tap-notice");
        expect(timers(s)).toHaveLength(0);
      }),
    );
  });

  it("ローカルモード（.layout--local）でも .layout の直下の子のまま", () => {
    scene(
      app,
      given({ ...init(), local: true }),
      tapNotice(TAP),
      settle,
      tap((s) => {
        expect(hasClass(layoutOf(s.html), "layout--local")).toBe(true);
        expect(directChild(s.html, "tap-notice")).toBeDefined();
      }),
    );
  });

  it("null の frame を受けると、その場で消える", () => {
    scene(
      app,
      given(init()),
      tapNotice(TAP),
      settle,
      tapNotice(null),
      expectScene(selector(".tap-notice")).toBeAbsent(),
      settle,
      expectScene(selector(".tap-notice")).toBeAbsent(),
    );
  });

  it("共有画面の知らせと同時に出ても別の要素で、.layout の直下は 共有画面 → 相手の音声 の順。出入りで .map・.captions・.side の並びは動かない", () => {
    scene(
      app,
      given({ ...withSpeaking }),
      settled,
      tap((s) => {
        stableBefore = stableParts(s.html);
      }),
      screen(SCREEN),
      settle,
      tapNotice(TAP),
      settle,
      tap((s) => {
        expect(outline(s.html)).toEqual(["div.map", "div.captions", "div.screen-notice", "div.tap-notice", "div.side"]);
        expect(stableParts(s.html)).toEqual(stableBefore);
      }),
      tapNotice(null),
      settle,
      tap((s) => expect(outline(s.html)).toEqual(["div.map", "div.captions", "div.screen-notice", "div.side"])),
    );
  });

  it("素の要素（data-*・style・イベントのハンドラを持たない）", () => {
    scene(
      app,
      given(init()),
      tapNotice(TAP),
      settle,
      tap((s) => expectPlain(directChild(s.html, "tap-notice"))),
    );
  });
});

describe("sessionLayout の Scene: 見る状態の知らせ（今と同じ位置・文言）", () => {
  it("auto のときは .viewing-notice を描かない", () => {
    scene(app, given(init()), expectScene(selector(".viewing-notice")).toBeAbsent());
  });

  it("manual で .map の中に p.viewing-notice が出る（.layout の直下には出ない）。表示面の後ろに並ぶ", () => {
    scene(
      app,
      given(init()),
      viewing("manual"),
      settle,
      expectScene(selector(".viewing-notice")).toHaveText(MANUAL),
      tap((s) => {
        expect(findAll("p.viewing-notice")(mapOf(s.html))).toHaveLength(1);
        expect(directChild(s.html, "viewing-notice")).toBeUndefined();
        expect(mapOutline(s.html)).toEqual(["div.map-surface", "p.viewing-notice"]);
        expect(timers(s)).toHaveLength(0);
      }),
    );
  });

  it("overview → diff の順に、文が入れ替わり（1 つだけが DOM に出る）、auto で消える", () => {
    scene(
      app,
      given(init()),
      viewing("overview"),
      settle,
      viewing("diff"),
      tap((s) => expect(findAll(".viewing-notice")(s.html).map(textContent)).toEqual([DIFF])),
      settle,
      tap((s) => expect(findAll(".viewing-notice")(s.html).map(textContent)).toEqual([DIFF])),
      viewing("auto"),
      expectScene(selector(".viewing-notice")).toBeAbsent(),
      settle,
    );
  });

  it("manual → overview → auto の順に、文が入れ替わり、最後に消える（1 つだけが DOM に出る）", () => {
    scene(
      app,
      given(init()),
      viewing("manual"),
      settle,
      viewing("overview"),
      tap((s) => expect(findAll(".viewing-notice")(s.html).map(textContent)).toEqual([OVERVIEW])),
      settle,
      viewing("auto"),
      expectScene(selector(".viewing-notice")).toBeAbsent(),
      settle,
      expectScene(selector(".viewing-notice")).toBeAbsent(),
    );
  });

  it("残り秒数やバッジは出さない", () => {
    scene(
      app,
      given(init()),
      viewing("manual"),
      settle,
      tap((s) => {
        const text = textContent(Option.getOrThrow(find(".viewing-notice")(s.html)));
        expect(text).not.toMatch(/\d+\s*秒/);
        expect(text).not.toContain("badge");
      }),
    );
  });
});

describe("sessionLayout の Scene: Toast に載せない知らせ（差分更新・ローカルモード）", () => {
  it("差分更新は、ChatGPT の利用上限で止まっている間だけ div.diff-update-notice[role=status] に指定の文が出る", () => {
    scene(
      app,
      given(init()),
      expectScene(selector(".diff-update-notice")).toBeAbsent(),
      emit(Message.ReceivedDiffUpdate({ state: Option.some(PAUSED) })),
      expectScene(selector(".diff-update-notice")).toHaveText("マップの更新が止まっています（ChatGPT の利用上限）"),
      expectScene(selector(".diff-update-notice")).toHaveAttr("role", "status"),
      tap((s) => expect(directChild(s.html, "diff-update-notice")?.sel).toBe("div")),
      emit(Message.ReceivedDiffUpdate({ state: Option.some({ status: "running" }) })),
      expectScene(selector(".diff-update-notice")).toBeAbsent(),
      emit(Message.ReceivedDiffUpdate({ state: Option.some(PAUSED) })),
      expectScene(selector(".diff-update-notice")).toExist(),
      emit(Message.ReceivedDiffUpdate({ state: Option.none() })),
      expectScene(selector(".diff-update-notice")).toBeAbsent(),
    );
  });

  it("Claude の利用上限で止まっている間も、同じ形（div.diff-update-notice[role=status]）で理由に合わせた文が出る", () => {
    scene(
      app,
      given(init()),
      emit(Message.ReceivedDiffUpdate({ state: Option.some({ status: "paused", reason: "Claude の利用上限" }) })),
      expectScene(selector(".diff-update-notice")).toHaveText("マップの更新が止まっています（Claude の利用上限）"),
      expectScene(selector(".diff-update-notice")).toHaveAttr("role", "status"),
      tap((s) => expect(directChild(s.html, "diff-update-notice")?.sel).toBe("div")),
      emit(Message.ReceivedDiffUpdate({ state: Option.some(PAUSED) })),
      expectScene(selector(".diff-update-notice")).toHaveText("マップの更新が止まっています（ChatGPT の利用上限）"),
      emit(Message.ReceivedDiffUpdate({ state: Option.some({ status: "running" }) })),
      expectScene(selector(".diff-update-notice")).toBeAbsent(),
    );
  });

  it.each([{ status: "running" }, { status: "restarting" }, { status: "stopped" }] as const)("差分更新が %j のときは .diff-update-notice を描かない", (state) => {
    scene(app, given({ ...init(), diffUpdate: Option.some(state) }), expectScene(selector(".diff-update-notice")).toBeAbsent());
  });

  it("ローカルモードでないときは、線も文も描かず、.layout に layout--local も付かない", () => {
    scene(
      app,
      given(init()),
      expectScene(selector(".local-mode-line")).toBeAbsent(),
      expectScene(selector(".local-mode-notice")).toBeAbsent(),
      tap((s) => expect(semanticClassesOf(classOf(layoutOf(s.html)))).toEqual(["layout"])),
    );
  });

  it("ローカルモードでは、線（aria-hidden）と指定の文（role=status）が .layout の先頭に出て、layout--local が付く。通常へ戻すと全部消える", () => {
    scene(
      app,
      given(init()),
      emit(Message.ReceivedSessionMode({ local: true })),
      expectScene(selector(".local-mode-line")).toHaveAttr("aria-hidden", "true"),
      expectScene(selector(".local-mode-notice")).toHaveText("ローカルモード・Apple Intelligence"),
      expectScene(selector(".local-mode-notice")).toHaveAttr("role", "status"),
      tap((s) => {
        expect(semanticClassesOf(classOf(layoutOf(s.html)))).toEqual(["layout", "layout--local"]);
        expect(outline(s.html).slice(0, 3)).toEqual(["div.local-mode-line", "div.local-mode-notice", "div.map"]);
      }),
      emit(Message.ReceivedSessionMode({ local: false })),
      expectScene(selector(".local-mode-line")).toBeAbsent(),
      expectScene(selector(".local-mode-notice")).toBeAbsent(),
      tap((s) => expect(semanticClassesOf(classOf(layoutOf(s.html)))).toEqual(["layout"])),
    );
  });

  it.each([
    [Option.none(), "ローカルモード・Apple Intelligence", undefined],
    [Option.some({ status: "running" }), "ローカルモード・Apple Intelligence", "running"],
    [Option.some({ status: "restarting" }), "ローカルモード・Apple Intelligence・マップの更新を再開しています", "restarting"],
    [Option.some({ status: "stopped" }), "ローカルモード・Apple Intelligence・マップの更新が止まっています", "stopped"],
  ] as const)("ローカルモードの文と data-status は差分更新の状態 %j で決まる", (state, text, status) => {
    scene(
      app,
      given({ ...init(), local: true, diffUpdate: state }),
      expectScene(selector(".local-mode-notice")).toHaveText(text),
      tap((s) => {
        for (const name of ["local-mode-line", "local-mode-notice"]) {
          const vnode = directChild(s.html, name)!;
          expect(Option.getOrUndefined(attr(vnode, "data-status"))).toBe(status);
        }
      }),
    );
  });

  it("ローカルモードの文は、差分更新の状態が変わると同じ画面の上で追従する", () => {
    scene(
      app,
      given({ ...init(), local: true }),
      expectScene(selector(".local-mode-notice")).toHaveText("ローカルモード・Apple Intelligence"),
      emit(Message.ReceivedDiffUpdate({ state: Option.some({ status: "restarting" }) })),
      expectScene(selector(".local-mode-notice")).toHaveText("ローカルモード・Apple Intelligence・マップの更新を再開しています"),
      emit(Message.ReceivedDiffUpdate({ state: Option.some({ status: "stopped" }) })),
      expectScene(selector(".local-mode-notice")).toHaveText("ローカルモード・Apple Intelligence・マップの更新が止まっています"),
      emit(Message.ReceivedDiffUpdate({ state: Option.none() })),
      expectScene(selector(".local-mode-notice")).toHaveText("ローカルモード・Apple Intelligence"),
    );
  });
});

describe("sessionLayout の Scene: 並び順（今の SessionView の .layout の直下と同じ）", () => {
  it("全部出したときの .layout の直下は、ローカルモード → .map → 字幕 → 取り込み → 共有画面 → 相手の音声 → 差分更新 → .side の順", () => {
    scene(
      app,
      given({ ...withSpeaking, local: true, diffUpdate: Option.some(PAUSED) }),
      settled,
      intake("interrupted"),
      settle,
      screen(SCREEN),
      settle,
      tapNotice(TAP),
      settle,
      viewing("manual"),
      settle,
      tap((s) => {
        expect(outline(s.html)).toEqual([
          "div.local-mode-line",
          "div.local-mode-notice",
          "div.map",
          "div.captions",
          "div.intake-notice",
          "div.screen-notice",
          "div.tap-notice",
          "div.diff-update-notice",
          "div.side",
        ]);
        expect(mapOutline(s.html)).toEqual(["div.map-surface", "p.viewing-notice"]);
      }),
    );
  });

  it("差し込み口の中身は .map と .side の中に入る", () => {
    scene(
      app,
      given(init()),
      tap((s) => {
        expect(mapOutline(s.html)).toEqual(["div.map-surface"]);
        expect(elements(Option.getOrThrow(find(".side")(s.html))).map(named)).toEqual(["div.evidence-panel"]);
      }),
    );
  });

  it("右の列の差し込み口が null（右の列を隠している）のときは、.side の包みを描かず、.layout の直下は .map だけ", () => {
    scene(
      { update, view: (model: ReturnType<typeof init>, h: HtmlBuilder<Message>) => view(model, h, { map: h.div([h.Class("map-surface")], []), side: null }) },
      given(init()),
      tap((s) => {
        expect(outline(s.html)).toEqual(["div.map"]);
        expect(find(".side")(s.html)).toEqual(Option.none());
      }),
    );
  });
});

describe("sessionLayout の Scene: 知らせが出る・消えるとき、マップと字幕の位置が動かない", () => {
  const base = { ...withSpeaking };
  let before: ReturnType<typeof stableParts>;
  const remember = tap<ReturnType<typeof init>, Message>((s) => {
    before = stableParts(s.html);
  });
  const expectUnchanged = tap<ReturnType<typeof init>, Message>((s) => {
    expect(stableParts(s.html)).toEqual(before);
  });
  // 知らせが 0 件のときに、知らせのための包み要素が .layout の直下にも木のどこにも無い
  const expectNoWrapper = tap<ReturnType<typeof init>, Message>((s) => {
    expect(findAll('[role="region"]')(s.html)).toHaveLength(0);
    for (const child of elements(layoutOf(s.html))) {
      expect(["map", "captions", "side", "local-mode-line", "local-mode-notice", "intake-notice", "screen-notice", "tap-notice", "diff-update-notice", "self-pause-notice"].some((name) => hasClass(child, name))).toBe(true);
    }
  });

  it("知らせが 0 件のときは .layout の直下は .map・.captions・.side だけ（包み要素が無い）", () => {
    scene(
      app,
      given(base),
      settled,
      expectNoWrapper,
      tap((s) => expect(outline(s.html)).toEqual(["div.map", "div.captions", "div.side"])),
    );
  });

  it("取り込みの知らせ: 出る前・出ている間・消えた後で、.map・.captions・.side の並びと class が同じ", () => {
    scene(
      app,
      given(base),
      settled,
      remember,
      intake("interrupted"),
      settle,
      expectUnchanged,
      tap((s) => expect(outline(s.html)).toEqual(["div.map", "div.captions", "div.intake-notice", "div.side"])),
      intake("running"),
      settle,
      expectUnchanged,
      expire,
      settle,
      expectUnchanged,
      expectNoWrapper,
      tap((s) => expect(outline(s.html)).toEqual(["div.map", "div.captions", "div.side"])),
    );
  });

  // Issue #1069: 休止中は出し続ける一言。時間では消えず、出入りしてもマップ・字幕・右の列の並びと class は動かない
  it("自分の休止の一言: 出る前・出ている間・消えた後で、.map・.captions・.side の並びと class が同じ。包み要素も増えない", () => {
    scene(
      app,
      given(base),
      settled,
      remember,
      selfPause(true),
      settle,
      expectUnchanged,
      expectNoWrapper,
      tap((s) => {
        expect(outline(s.html).filter((name) => name !== "div.self-pause-notice")).toEqual(["div.map", "div.captions", "div.side"]);
        expect(outline(s.html).filter((name) => name === "div.self-pause-notice")).toHaveLength(1);
        expect(textContent(directChild(s.html, "self-pause-notice")!)).toBe("自分を休止中（M で再開）");
        expect(attr(directChild(s.html, "self-pause-notice")!, "aria-live")).toEqual(Option.some("polite"));
        expectPlain(directChild(s.html, "self-pause-notice"));
        expect(timers(s)).toHaveLength(0);
      }),
      selfPause(true),
      settle,
      tap((s) => expect(outline(s.html).filter((name) => name === "div.self-pause-notice")).toHaveLength(1)),
      selfPause(false),
      settle,
      expectUnchanged,
      expectNoWrapper,
      tap((s) => expect(outline(s.html)).toEqual(["div.map", "div.captions", "div.side"])),
    );
  });

  it("自分の休止の一言は、取り込みの一言と同時に出ても別の要素で、片方の出入りが他方に触れない。マップ・字幕の並びも同じ", () => {
    scene(
      app,
      given(base),
      settled,
      remember,
      intake("interrupted"),
      settle,
      selfPause(true),
      settle,
      expectUnchanged,
      tap((s) => {
        expect(textContent(directChild(s.html, "intake-notice")!)).toBe(INTERRUPTED);
        expect(textContent(directChild(s.html, "self-pause-notice")!)).toBe("自分を休止中（M で再開）");
      }),
      selfPause(false),
      settle,
      tap((s) => {
        expect(directChild(s.html, "self-pause-notice")).toBeUndefined();
        expect(textContent(directChild(s.html, "intake-notice")!)).toBe(INTERRUPTED);
      }),
      expectUnchanged,
    );
  });

  // Issue #1071: 理由で文言が変わる。同じ画面の上で、手動 → 自動 → 手動 → 再開と続けて観測する
  it("自分の休止の一言: 理由が手動なら「M で再開」、自動なら「会議アプリがマイクを使っていない」。理由だけ変わっても要素は 1 つで、再開で消える", () => {
    scene(
      app,
      given(base),
      settled,
      remember,
      selfPause(true, "手動"),
      settle,
      tap((s) => expect(textContent(directChild(s.html, "self-pause-notice")!)).toBe("自分を休止中（M で再開）")),
      selfPause(true, "自動"),
      settle,
      expectUnchanged,
      tap((s) => {
        expect(textContent(directChild(s.html, "self-pause-notice")!)).toBe("自分を休止中（会議アプリがマイクを使っていない）");
        expect(outline(s.html).filter((name) => name === "div.self-pause-notice")).toHaveLength(1);
      }),
      selfPause(true, "手動"),
      settle,
      tap((s) => expect(textContent(directChild(s.html, "self-pause-notice")!)).toBe("自分を休止中（M で再開）")),
      selfPause(false),
      settle,
      tap((s) => expect(directChild(s.html, "self-pause-notice")).toBeUndefined()),
    );
  });

  it("休止の状態は init では false（休止していない）", () => {
    expect(init().selfPaused).toBe(false);
  });

  it("共有画面の知らせ: 出る前・出ている間・消えた後で同じ", () => {
    scene(
      app,
      given(base),
      settled,
      remember,
      screen(SCREEN),
      settle,
      expectUnchanged,
      tap((s) => expect(outline(s.html)).toEqual(["div.map", "div.captions", "div.screen-notice", "div.side"])),
      screen(null),
      settle,
      expectUnchanged,
      expectNoWrapper,
    );
  });

  it("見る状態の知らせ: 出る前・出ている間（manual・overview）・消えた後で同じ。.map の class も変わらない", () => {
    scene(
      app,
      given(base),
      settled,
      remember,
      viewing("manual"),
      settle,
      expectUnchanged,
      viewing("overview"),
      settle,
      expectUnchanged,
      viewing("auto"),
      settle,
      expectUnchanged,
      expectNoWrapper,
    );
  });

  it("3 つが同時に出入りしても同じ", () => {
    scene(
      app,
      given(base),
      settled,
      remember,
      intake("stopped"),
      settle,
      screen(SCREEN),
      settle,
      viewing("manual"),
      settle,
      expectUnchanged,
      intake("none"),
      settle,
      screen(null),
      settle,
      viewing("auto"),
      settle,
      expectUnchanged,
      expectNoWrapper,
    );
  });

  it("差分更新・ローカルモードの出入りでも、.map・.captions・.side の並びと class は同じ", () => {
    scene(
      app,
      given(base),
      settled,
      remember,
      emit(Message.ReceivedDiffUpdate({ state: Option.some(PAUSED) })),
      emit(Message.ReceivedSessionMode({ local: true })),
      tap((s) => {
        const now = stableParts(s.html);
        expect({ ...now, layout: "" }).toEqual({ ...before, layout: "" });
      }),
      emit(Message.ReceivedDiffUpdate({ state: Option.none() })),
      emit(Message.ReceivedSessionMode({ local: false })),
      expectUnchanged,
    );
  });

  it("字幕を隠す・出すときも、.map と .side の並びと class は同じ", () => {
    scene(
      app,
      given(base),
      settled,
      remember,
      emit(Message.ToggledCaptions({ isOpen: false })),
      Mount.expectEnded(SlideCaptions),
      tap((s) => {
        const now = stableParts(s.html);
        expect({ ...now, parts: [] }).toEqual({ ...before, parts: [] });
        expect(now.parts).toEqual(before.parts.filter((p) => p !== "div.captions"));
      }),
      emit(Message.ToggledCaptions({ isOpen: true })),
      settled,
      expectUnchanged,
    );
  });
});

describe("sessionLayout の Scene: 出入りの動き・スワイプ・ホバーで時間が止まる仕組みを使わない", () => {
  it("取り込み・共有画面・見る状態の知らせの要素は、data-*・style・イベントのハンドラを持たない素の要素", () => {
    scene(
      app,
      given(init()),
      intake("interrupted"),
      settle,
      screen(SCREEN),
      settle,
      viewing("manual"),
      settle,
      tap((s) => {
        expectPlain(directChild(s.html, "intake-notice"));
        expectPlain(directChild(s.html, "screen-notice"));
        expectPlain(Option.getOrUndefined(find(".viewing-notice")(s.html)));
      }),
    );
  });

  it("「再開しました」の知らせも同じ（時間で消える知らせでも、動きの属性を足さない）", () => {
    scene(
      app,
      given(init()),
      intake("interrupted"),
      settle,
      intake("running"),
      settle,
      tap((s) => expectPlain(directChild(s.html, "intake-notice"))),
      expire,
      settle,
    );
  });

  it("Toast の region / status の包み要素も、出入りの動きの属性（data-closed・data-enter・data-leave・data-transition・data-swipe）も、木のどこにも無い", () => {
    scene(
      app,
      given(withSpeaking),
      settled,
      intake("interrupted"),
      settle,
      screen(SCREEN),
      settle,
      viewing("overview"),
      settle,
      tap((s) => {
        expect(findAll('[role="region"]')(s.html)).toHaveLength(0);
        for (const name of ["data-closed", "data-enter", "data-leave", "data-transition", "data-swipe"]) expect(findAll(`[${name}]`)(s.html)).toHaveLength(0);
      }),
    );
  });

  it("消す Message の直後（消える動きの Command を解く前）に、要素が DOM から消えている", () => {
    scene(
      app,
      given(init()),
      screen(SCREEN),
      settle,
      screen(null),
      expectScene(selector(".screen-notice")).toBeAbsent(),
      settle,
    );
  });
});

describe("sessionLayout の Scene: キーの一覧の差し込み口（#826）", () => {
  it("キーの一覧は .map の中で、表示面と見る状態の知らせの後ろに並ぶ（.layout の直下には出ない）", () => {
    scene(
      appWithKeyList,
      given(init()),
      tap((s) => {
        expect(mapOutline(s.html)).toEqual(["div.map-surface", "div.key-list__anchor"]);
        expect(directChild(s.html, "key-list__anchor")).toBeUndefined();
      }),
      viewing("manual"),
      settle,
      tap((s) => expect(mapOutline(s.html)).toEqual(["div.map-surface", "p.viewing-notice", "div.key-list__anchor"])),
    );
  });

  it("キーの一覧が null（閉じている）なら、何も描かず、.map の中は今のまま", () => {
    scene(
      app,
      given(init()),
      tap((s) => expect(mapOutline(s.html)).toEqual(["div.map-surface"])),
    );
  });
});

// Issue #1026: 名前の欄を押して、その欄の中で名前を入れる。確定したラベルの相手の欄（label が Some）だけが押せる。
// 入力は同じ欄の中に出て、吹き出しの本文は変わらない（寸法は meeting.mount.heavy.test.ts が測る）
describe("sessionLayout の Scene: 名前の欄の入力", () => {
  // blur の step は relatedTarget の型を調べるのに Element を参照する（node の unit 環境には無い。review.controls.scene.test.ts と同じ）
  beforeEach(() => vi.stubGlobal("Element", class {}));
  afterEach(() => vi.unstubAllGlobals());
  const cell = (id: string, label: string | undefined, extra: Partial<DisplayBubble> = {}): DisplayBubble => ({
    id, side: "left", name: Option.some(label ?? "相手"), label: Option.fromNullishOr(label), nameState: "settled", colorIndex: 1, text: id, settledLength: id.length, ...extra,
  });
  const mineCell = (id: string): DisplayBubble => ({ id, side: "right", name: Option.none(), label: Option.none(), nameState: "settled", colorIndex: 0, text: id, settledLength: id.length });
  const withBubbles = (...bubbles: DisplayBubble[]) => ({ ...init(), captions: { _tag: "Bubbles" as const, bubbles } });
  const settled = Mount.resolve(SlideCaptions, Message.CompletedSlideCaptions());
  // 欄を押すと出るフォーカスの Command（入力へフォーカスを移す。Model は変えない）
  const focused = Command.resolveAll([FocusSpeakerNameInput, Message.CompletedFocusSpeakerNameInput()]);
  const nameCells = (html: VNode) => findAll(".captions__name")(html);
  const requests = (s: Sim) => s.commands.filter((c) => c.name === "RequestSpeakerName").map((c) => c.args);

  it("押せる欄は button、押せない欄（自分・同じ人が続く・仮・「相手」だけ）は button ではない", () => {
    scene(
      app,
      given(withBubbles(cell("a", "相手 A"), cell("a2", undefined, { name: Option.none() }), mineCell("m"), cell("p", undefined, { nameState: "provisional" }), cell("n", undefined))),
      settled,
      tap((s) => {
        const cells = nameCells(s.html);
        expect(cells.map((c) => c.sel?.split(/[.#]/)[0])).toEqual(["button", "div", "div", "div", "div"]);
      }),
    );
  });

  it("自分の欄を押しても入力は出ない（押せる要素ではなく、クリックの受け口を持たない）", () => {
    scene(
      app,
      given(withBubbles(cell("a", "相手 A"), mineCell("m"))),
      settled,
      tap((s) => {
        const mineName = nameCells(s.html)[1]!;
        expect(Object.keys(mineName.data?.on ?? {})).toEqual([]);
        expect(findAll(".captions input")(s.html)).toHaveLength(0);
      }),
    );
  });

  it("押すと、同じ欄の中に入力が出る。吹き出しの本文は押す前と同じ", () => {
    scene(
      app,
      given(withBubbles(cell("a", "相手 B", { text: "こんにちは" }), mineCell("m"))),
      settled,
      click(selector("button.captions__name")),
      focused,
      tap((s) => {
        const [first] = nameCells(s.html);
        expect(findAll("input")(first!)).toHaveLength(1);
        expect(findAll(".captions__bubble")(s.html).map(textContent)).toEqual(["こんにちは", "m"]);
        expect(requests(s)).toEqual([]);
      }),
    );
  });

  it("入力して送ると、押した欄のラベルと入力した名前で RequestSpeakerName が出て、入力は閉じる（表示は変えない）", () => {
    scene(
      app,
      given(withBubbles(cell("a", "相手 B"))),
      settled,
      click(selector("button.captions__name")),
      focused,
      typeInto(selector(".captions__name input"), "田中"),
      submit(selector(".captions form")),
      tap((s) => {
        expect(requests(s)).toEqual([{ label: "相手 B", name: "田中" }]);
        expect(findAll(".captions input")(s.html)).toHaveLength(0);
        expect(nameCells(s.html).map(textContent)).toEqual(["相手 B"]); // 名前が付いた表示は、サーバーから表が届いてから
      }),
      Command.resolveAll([RequestSpeakerName, Message.CompletedRequestSpeakerName()]),
    );
  });

  it("Esc で取り消すと、何も送らずに閉じる", () => {
    scene(
      app,
      given(withBubbles(cell("a", "相手 B"))),
      settled,
      click(selector("button.captions__name")),
      focused,
      typeInto(selector(".captions__name input"), "田中"),
      keydown(selector(".captions__name input"), "Escape"),
      tap((s) => {
        expect(requests(s)).toEqual([]);
        expect(findAll(".captions input")(s.html)).toHaveLength(0);
      }),
    );
  });

  it("フォーカスを外すと、何も送らずに閉じる", () => {
    scene(
      app,
      given(withBubbles(cell("a", "相手 B"))),
      settled,
      click(selector("button.captions__name")),
      focused,
      typeInto(selector(".captions__name input"), "田中"),
      blur(selector(".captions__name input")),
      tap((s) => {
        expect(requests(s)).toEqual([]);
        expect(findAll(".captions input")(s.html)).toHaveLength(0);
      }),
    );
  });

  it("入力中に吹き出しの並びが更新されても（同じ id が残る間は）入力は残る", () => {
    scene(
      app,
      given(withBubbles(cell("a", "相手 B"))),
      settled,
      click(selector("button.captions__name")),
      focused,
      typeInto(selector(".captions__name input"), "田"),
      Subscription.emit(Message.ChangedCaptions({ captions: { _tag: "Bubbles", bubbles: [cell("a", "相手 B", { text: "続きの文字" })] } })),
      tap((s) => expect(findAll(".captions__name input")(s.html)).toHaveLength(1)),
    );
  });

  // 押して「田」と入力したあと、字幕の更新 next を流す
  const typedThen = (next: DisplayBubble[]) => [
    click(selector("button.captions__name")),
    focused,
    typeInto(selector(".captions__name input"), "田"),
    Subscription.emit(Message.ChangedCaptions({ captions: { _tag: "Bubbles", bubbles: next } })),
  ] as const;

  it("入力中に対象の吹き出しが字幕から消えても、入力と下書きは残り、確定でラベルと下書きが送られる", () => {
    scene(
      app,
      given(withBubbles(cell("a", "相手 B"))),
      settled,
      ...typedThen([cell("b", "相手 C")]),
      tap((s) => {
        const inputs = findAll(".captions__name input")(s.html);
        expect(inputs).toHaveLength(1);
        expect(inputs[0]!.data?.props?.value).toBe("田");
        expect(findAll(".captions__row")(s.html)).toHaveLength(2);
      }),
      submit(selector(".captions form")),
      tap((s) => {
        expect(requests(s)).toEqual([{ label: "相手 B", name: "田" }]);
        expect(findAll(".captions input")(s.html)).toHaveLength(0);
        expect(findAll(".captions__row")(s.html)).toHaveLength(1);
      }),
      Command.resolveAll([RequestSpeakerName, Message.CompletedRequestSpeakerName()]),
    );
  });

  it("字幕が空になっても、入力は残る", () => {
    scene(
      app,
      given(withBubbles(cell("a", "相手 B"))),
      settled,
      ...typedThen([]),
      tap((s) => {
        expect(findAll(".captions")(s.html)).toHaveLength(1);
        expect(findAll(".captions__name input")(s.html)).toHaveLength(1);
      }),
    );
  });

  it("末尾 3 件から外れても、入力は残り、押した行が先頭に置かれる", () => {
    scene(
      app,
      given(withBubbles(cell("a", "相手 B"))),
      settled,
      ...typedThen([cell("x", "相手 C"), cell("y", "相手 D"), cell("z", "相手 E")]),
      tap((s) => {
        expect(findAll(".captions__name input")(s.html)).toHaveLength(1);
        expect(findAll(".captions__row")(s.html)).toHaveLength(4);
        expect(findAll("input")(findAll(".captions__row")(s.html)[0]!)).toHaveLength(1);
      }),
    );
  });

  it("同じ id のまま label が無くなっても、入力は残り、行は増えない", () => {
    scene(
      app,
      given(withBubbles(cell("a", "相手 B"))),
      settled,
      ...typedThen([cell("a", undefined, { name: Option.none() })]),
      tap((s) => {
        expect(findAll(".captions__name input")(s.html)).toHaveLength(1);
        expect(findAll(".captions__row")(s.html)).toHaveLength(1);
      }),
    );
  });

  it("字幕から消えたあとに Esc で取り消すと、何も送らず、押した行も消える", () => {
    scene(
      app,
      given(withBubbles(cell("a", "相手 B"))),
      settled,
      ...typedThen([cell("b", "相手 C")]),
      keydown(selector(".captions__name input"), "Escape"),
      tap((s) => {
        expect(requests(s)).toEqual([]);
        expect(findAll(".captions input")(s.html)).toHaveLength(0);
        expect(findAll(".captions__row")(s.html)).toHaveLength(1);
      }),
    );
  });
});
