import { Duration, Option } from "effect";
import * as Animation from "@foldkit/ui/animation";
import * as Toast from "@foldkit/ui/toast";
import type { HtmlBuilder } from "foldkit/html";
import { attr, Command, expect as expectScene, find, findAll, given, scene, selector, Subscription, tap, textContent, type SceneSimulation } from "foldkit/scene";
import { describe, expect, it } from "vitest";
import { RESUMED_NOTICE_MS } from "../src/intake.ts";
import { init, update, view } from "../src/app/sessionLayout/main.ts";
import { Message } from "../src/app/sessionLayout/message.ts";
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
const OVERVIEW = "全体を見ています・F か Esc で戻る・? でキー一覧";
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
const viewing = (mode: "auto" | "manual" | "overview") => emit(Message.ChangedViewingMode({ mode }));
const speak = (相手: string, 自分 = "") => emit(Message.ChangedSpeaking({ speaking: { 相手, 自分 } }));

let stableBefore: ReturnType<typeof stableParts>;
const withSpeaking = { ...init(), speaking: { 相手: "議題は採用です。", 自分: "はい" } };

describe("sessionLayout の Scene: 字幕", () => {
  it("話している文字がなければ .captions を描かない", () => {
    scene(app, given(init()), expectScene(selector(".captions")).toBeAbsent());
  });

  it("文ごとに 1 行（p.captions__line）、トラックごとに 1 ブロック（相手 → 自分）で、aria-live=polite の .captions に描く", () => {
    scene(
      app,
      given({ ...init(), speaking: { 相手: "議題は採用です。まず面接の", 自分: "はい" } }),
      expectScene(selector(".captions")).toExist(),
      expectScene(selector(".captions")).toHaveAttr("aria-live", "polite"),
      tap((s) => {
        expect(findAll(".captions__block")(s.html)).toHaveLength(2);
        expect(findAll(".captions__track")(s.html).map(textContent)).toEqual(["相手", "自分"]);
        expect(findAll(".captions__lines")(s.html)).toHaveLength(2);
        expect(findAll("p.captions__line")(s.html).map(textContent)).toEqual(["議題は採用です。", "まず面接の", "はい"]);
      }),
    );
  });

  it("末尾の 2 文だけを出す。古い文は行ごと消える（captionsOf と同じ）", () => {
    scene(
      app,
      given({ ...init(), speaking: { 相手: "一つ目です。二つ目です。三つ目です。", 自分: "" } }),
      tap((s) => {
        expect(findAll(".captions__track")(s.html).map(textContent)).toEqual(["相手"]);
        expect(findAll("p.captions__line")(s.html).map(textContent)).toEqual(["二つ目です。", "三つ目です。"]);
      }),
    );
  });

  it("話す文字が変わると、同じ部品の上で行が増え、古い文は消える。空に戻ると .captions ごと消える", () => {
    scene(
      app,
      given(init()),
      expectScene(selector(".captions")).toBeAbsent(),
      speak("一つ目です。"),
      tap((s) => expect(findAll("p.captions__line")(s.html).map(textContent)).toEqual(["一つ目です。"])),
      speak("一つ目です。二つ目です。三つ目です。"),
      tap((s) => expect(findAll("p.captions__line")(s.html).map(textContent)).toEqual(["二つ目です。", "三つ目です。"])),
      speak(""),
      expectScene(selector(".captions")).toBeAbsent(),
    );
  });

  it(".captions は .layout の直下にあり、.map の中には入らない（列を出し入れしても窓の横幅の中央から動かさないため）", () => {
    scene(
      app,
      given(withSpeaking),
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
      tap((s) => {
        const captions = directChild(s.html, "captions")!;
        expect(Option.isSome(attr(captions, "id"))).toBe(true);
        expect(Option.isSome(attr(captions, "data-open"))).toBe(true);
      }),
      emit(Message.ToggledCaptions({ isOpen: false })),
      expectScene(selector(".captions")).toBeAbsent(),
      tap((s) => expect(findAll("p.captions__line")(s.html)).toHaveLength(0)),
      emit(Message.ToggledCaptions({ isOpen: true })),
      expectScene(selector(".captions")).toExist(),
      expectScene(selector("p.captions__line")).toExist(),
    );
  });

  it("隠している間も話す文字は取り込み続け、出し直すと続きが出る", () => {
    scene(
      app,
      given(withSpeaking),
      emit(Message.ToggledCaptions({ isOpen: false })),
      speak("議題は採用です。次へ進みます。"),
      expectScene(selector(".captions")).toBeAbsent(),
      emit(Message.ToggledCaptions({ isOpen: true })),
      tap((s) => expect(findAll("p.captions__line")(s.html).map(textContent)).toEqual(["議題は採用です。", "次へ進みます。"])),
    );
  });

  it("隠した状態から始めても .captions を描かない", () => {
    scene(app, given({ ...withSpeaking, captionsHidden: true }), expectScene(selector(".captions")).toBeAbsent());
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
      expect(["map", "captions", "side", "local-mode-line", "local-mode-notice", "intake-notice", "screen-notice", "tap-notice", "diff-update-notice"].some((name) => hasClass(child, name))).toBe(true);
    }
  });

  it("知らせが 0 件のときは .layout の直下は .map・.captions・.side だけ（包み要素が無い）", () => {
    scene(
      app,
      given(base),
      expectNoWrapper,
      tap((s) => expect(outline(s.html)).toEqual(["div.map", "div.captions", "div.side"])),
    );
  });

  it("取り込みの知らせ: 出る前・出ている間・消えた後で、.map・.captions・.side の並びと class が同じ", () => {
    scene(
      app,
      given(base),
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

  it("共有画面の知らせ: 出る前・出ている間・消えた後で同じ", () => {
    scene(
      app,
      given(base),
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
      remember,
      emit(Message.ToggledCaptions({ isOpen: false })),
      tap((s) => {
        const now = stableParts(s.html);
        expect({ ...now, parts: [] }).toEqual({ ...before, parts: [] });
        expect(now.parts).toEqual(before.parts.filter((p) => p !== "div.captions"));
      }),
      emit(Message.ToggledCaptions({ isOpen: true })),
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
