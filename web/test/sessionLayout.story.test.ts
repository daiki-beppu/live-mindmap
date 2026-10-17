import { Duration, Option, Schema } from "effect";
import * as Animation from "@foldkit/ui/animation";
import * as Toast from "@foldkit/ui/toast";
import { Command, given, message, model, story, type StorySimulation } from "foldkit/story";
import { describe, expect, it } from "vitest";
import { RESUMED_NOTICE_MS } from "../src/intake.ts";
import { init, Model, update } from "../src/app/sessionLayout/main.ts";
import { Message } from "../src/app/sessionLayout/message.ts";

// セッションの画面の部品（Issue #820）: 字幕・取り込みの知らせ・共有画面の知らせ・見る状態の知らせの update。
// 知らせは Toast（headless）で持ち、消えるまでの時間は Toast の duration で持つ。
// Story は update を直接動かし、Model と、update が出す Command（時間切れ）を見る。描画は sessionLayout.scene.test.ts が見る。

type SessionModel = typeof Model.Type;
type Toasts = Pick<SessionModel, "intakeToast" | "screenToast" | "tapToast" | "viewingToast">;
type Simulation = StorySimulation<Model, Message>;

const INTERRUPTED = "音声の取り込みが途切れました。再開しています";
const STOPPED = "音声の取り込みが止まっています";
const RESUMED = "再開しました";
const MANUAL = "動かしています・議題が変わるか Esc で今の議題へ・? でキー一覧";
const OVERVIEW = "全体を見ています・F で変わったところへ・Esc で戻る・? でキー一覧";
const DIFF = "変わったところを見ています・Esc で戻る・? でキー一覧";
const SCREEN = "共有画面は使っていません（画面収録の許可がありません。システム設定で、起動したターミナルに許可を与え、ターミナルを開き直す）";
const TAP = "相手の音声が届いていません（出力の機器を切り替えた後に起きることがあります。cli stop の後、cli start で始め直してください）";

// 公開されている Toast の Model（entries・animation.isShowing・payload）だけを読む。出ている文 = 消し始めていない entry の文
const shown = (toast: Toasts[keyof Toasts]): string[] => toast.entries.filter((e) => e.animation.isShowing).map((e) => e.payload.text);
const count = (toast: Toasts[keyof Toasts]): number => toast.entries.length;

// 出る・消えるときの動き（WaitForPaint / WaitForAnimationSettled）は、このテストの関心ではないので、保留の Command を全部解く。
// 時間切れ（WaitBeforeDismissal）は解かない（解く・解かないがテストの主題）
const settle = (simulation: Simulation): Simulation => {
  const pending = simulation.commands.find((c) => c.name === "WaitForPaint" || c.name === "WaitForAnimationSettled");
  if (pending === undefined) return simulation;
  const generation = pending.args?.generation as number;
  return settle(
    pending.name === "WaitForPaint"
      ? Command.resolve(Animation.WaitForPaint({ generation }), Animation.Message.CompletedWaitForPaint({ generation }))(simulation)
      : Command.resolve(Animation.WaitForAnimationSettled({ id: pending.args?.id as string, generation }), Animation.Message.EndedAnimation({ generation }))(simulation),
  );
};

const timers = (simulation: Simulation) => simulation.commands.filter((c) => c.name === "WaitBeforeDismissal");
const expectTimers = (assert: (timers: ReadonlyArray<{ entryId: string; version: number; duration: Duration.Duration }>) => void) => (simulation: Simulation): Simulation => {
  assert(timers(simulation).map((t) => t.args as { entryId: string; version: number; duration: Duration.Duration }));
  return simulation;
};
// 保留の時間切れ（先頭）を、いま来たものとして解く
const expire = (simulation: Simulation): Simulation => {
  const { entryId, version, duration } = timers(simulation)[0]!.args as { entryId: string; version: number; duration: Duration.Duration };
  return Command.resolve(Toast.WaitBeforeDismissal({ entryId, version, duration }), Toast.Message.CompletedWaitBeforeDismissal({ entryId, version }))(simulation);
};

// Story は保留の Command を残したまま次の Message を送れない。実行時は「再開しました」のタイマーが走ったまま次の状態が届くので、
// 保留のタイマーを「何も起こさない結果」（版が違う完了）で閉じ、本物の時間切れの Message（古い版）は、次の状態を受けた後に lateTimer で別に届ける
const closeTimerQuietly = (simulation: Simulation): Simulation => {
  const { entryId, version, duration } = timers(simulation)[0]!.args as { entryId: string; version: number; duration: Duration.Duration };
  return Command.resolve(Toast.WaitBeforeDismissal({ entryId, version, duration }), Toast.Message.CompletedWaitBeforeDismissal({ entryId, version: version + 1000 }))(simulation);
};
// n 番目に出した取り込みの知らせ（0 始まり）の、古いタイマーが遅れて届く
const lateTimer = (n: number) => message(Message.GotIntakeToastMessage({ message: Toast.Message.CompletedWaitBeforeDismissal({ entryId: `${init().intakeToast.id}-entry-${n}`, version: 0 }) }));

const intake = (status: "running" | "interrupted" | "stopped" | "none") => message(Message.ReceivedIntakeStatus({ status }));
const screen = (text: string | null) => message(Message.ReceivedScreenNotice({ text: Option.fromNullishOr(text) }));
const tapNotice = (text: string | null) => message(Message.ReceivedTapNotice({ text: Option.fromNullishOr(text) }));
const viewing = (mode: "auto" | "manual" | "overview" | "diff") => message(Message.ChangedViewingMode({ mode }));

describe("sessionLayout の update: 取り込みの知らせ（Toast）", () => {
  it("接続直後の running では何も出ない。none も出ない", () => {
    story(
      update,
      given(init()),
      intake("running"),
      model((m) => expect(shown(m.intakeToast)).toEqual([])),
      intake("none"),
      model((m) => expect(count(m.intakeToast)).toBe(0)),
      Command.expectNone(),
    );
  });

  it("interrupted で途切れの文が出る。時間では消えない（時間切れの Command が出ない）", () => {
    story(
      update,
      given(init()),
      intake("interrupted"),
      settle,
      model((m) => expect(shown(m.intakeToast)).toEqual([INTERRUPTED])),
      Command.expectNone(),
    );
  });

  it("stopped で止まっている文が出る。時間では消えない", () => {
    story(
      update,
      given(init()),
      intake("stopped"),
      settle,
      model((m) => expect(shown(m.intakeToast)).toEqual([STOPPED])),
      Command.expectNone(),
    );
  });

  it("interrupted → running で「再開しました」に替わり、消えるまでの時間は RESUMED_NOTICE_MS（Toast の duration）。時間切れで消える", () => {
    story(
      update,
      given(init()),
      intake("interrupted"),
      settle,
      intake("running"),
      settle,
      model((m) => expect(shown(m.intakeToast)).toEqual([RESUMED])),
      expectTimers((t) => {
        expect(t).toHaveLength(1);
        expect(Duration.toMillis(t[0]!.duration)).toBe(RESUMED_NOTICE_MS);
      }),
      expire,
      model((m) => expect(shown(m.intakeToast)).toEqual([])),
      settle,
      model((m) => expect(count(m.intakeToast)).toBe(0)),
    );
  });

  it("stopped → running でも「再開しました」が RESUMED_NOTICE_MS で消える", () => {
    story(
      update,
      given(init()),
      intake("stopped"),
      settle,
      intake("running"),
      settle,
      model((m) => expect(shown(m.intakeToast)).toEqual([RESUMED])),
      expectTimers((t) => expect(t.map((x) => Duration.toMillis(x.duration))).toEqual([RESUMED_NOTICE_MS])),
      expire,
      settle,
      model((m) => expect(count(m.intakeToast)).toBe(0)),
    );
  });

  it("「再開しました」の間に interrupted を受けると途切れの文に替わり、前の時間切れが遅れて届いても消えない", () => {
    story(
      update,
      given(init()),
      intake("interrupted"),
      settle,
      intake("running"),
      settle,
      closeTimerQuietly,
      intake("interrupted"),
      model((m) => expect(shown(m.intakeToast)).toEqual([INTERRUPTED])),
      settle,
      lateTimer(1),
      settle,
      model((m) => expect(shown(m.intakeToast)).toEqual([INTERRUPTED])),
      Command.expectNone(),
    );
  });

  it("「再開しました」の間に stopped を受けると止まった文に替わり、前の時間切れが遅れて届いても消えない", () => {
    story(
      update,
      given(init()),
      intake("interrupted"),
      settle,
      intake("running"),
      settle,
      closeTimerQuietly,
      intake("stopped"),
      settle,
      lateTimer(1),
      settle,
      model((m) => expect(shown(m.intakeToast)).toEqual([STOPPED])),
      Command.expectNone(),
    );
  });

  it("同じ状態をもう一度受けても、文は 1 つのまま変わらず、新しい Command も出ない", () => {
    story(
      update,
      given(init()),
      intake("interrupted"),
      settle,
      intake("interrupted"),
      settle,
      model((m) => {
        expect(shown(m.intakeToast)).toEqual([INTERRUPTED]);
        expect(count(m.intakeToast)).toBe(1);
      }),
      Command.expectNone(),
    );
  });

  it("running が続いても（変化なし）、再開しましたは出し直さない", () => {
    story(
      update,
      given(init()),
      intake("interrupted"),
      settle,
      intake("running"),
      settle,
      expire,
      settle,
      intake("running"),
      settle,
      model((m) => expect(count(m.intakeToast)).toBe(0)),
      Command.expectNone(),
    );
  });

  it("interrupted → none で知らせが消える。その後の running では「再開しました」を出さない（終わったセッションは再開ではない）", () => {
    story(
      update,
      given(init()),
      intake("interrupted"),
      settle,
      intake("none"),
      model((m) => expect(shown(m.intakeToast)).toEqual([])),
      settle,
      model((m) => expect(count(m.intakeToast)).toBe(0)),
      intake("running"),
      settle,
      model((m) => expect(count(m.intakeToast)).toBe(0)),
      Command.expectNone(),
    );
  });

  it("途切れ → 再開 → 時間切れ → 再び途切れ → 再開で、2 回目の「再開しました」も出て RESUMED_NOTICE_MS で消える", () => {
    story(
      update,
      given(init()),
      intake("interrupted"),
      settle,
      intake("running"),
      settle,
      expire,
      settle,
      intake("interrupted"),
      settle,
      intake("running"),
      settle,
      model((m) => expect(shown(m.intakeToast)).toEqual([RESUMED])),
      expectTimers((t) => expect(t.map((x) => Duration.toMillis(x.duration))).toEqual([RESUMED_NOTICE_MS])),
      expire,
      settle,
      model((m) => expect(count(m.intakeToast)).toBe(0)),
    );
  });
});

describe("sessionLayout の update: 共有画面の知らせ（Toast）", () => {
  it("文を受けると出る。時間では消えない（サーバーが null の frame を送るまで残る）", () => {
    story(
      update,
      given(init()),
      screen(SCREEN),
      settle,
      model((m) => expect(shown(m.screenToast)).toEqual([SCREEN])),
      Command.expectNone(),
    );
  });

  it("null（text なし）を受けると消える", () => {
    story(
      update,
      given(init()),
      screen(SCREEN),
      settle,
      screen(null),
      model((m) => expect(shown(m.screenToast)).toEqual([])),
      settle,
      model((m) => expect(count(m.screenToast)).toBe(0)),
      Command.expectNone(),
    );
  });

  it("出ていないときの null は何もしない", () => {
    story(
      update,
      given(init()),
      screen(null),
      model((m) => expect(count(m.screenToast)).toBe(0)),
      Command.expectNone(),
    );
  });

  it("同じ文をもう一度受けても、出ている文は 1 つだけ", () => {
    story(
      update,
      given(init()),
      screen(SCREEN),
      settle,
      screen(SCREEN),
      settle,
      model((m) => {
        expect(shown(m.screenToast)).toEqual([SCREEN]);
        expect(count(m.screenToast)).toBe(1);
      }),
      Command.expectNone(),
    );
  });

  it("別の文を受けると、古い文は消えて新しい文だけが出る", () => {
    story(
      update,
      given(init()),
      screen("共有画面は使っていません"),
      settle,
      screen(SCREEN),
      model((m) => expect(shown(m.screenToast)).toEqual([SCREEN])),
      settle,
      model((m) => expect(count(m.screenToast)).toBe(1)),
    );
  });
});

describe("sessionLayout の update: 相手の音声が届いていない知らせ（Toast。Issue #863）", () => {
  it("文を受けると出る。時間では消えない（サーバーが null の frame を送るまで残る）", () => {
    story(
      update,
      given(init()),
      tapNotice(TAP),
      settle,
      model((m) => expect(shown(m.tapToast)).toEqual([TAP])),
      Command.expectNone(),
    );
  });

  it("null（text なし）を受けると消える。出ていないときの null は何もしない", () => {
    story(
      update,
      given(init()),
      tapNotice(null),
      model((m) => expect(count(m.tapToast)).toBe(0)),
      Command.expectNone(),
      tapNotice(TAP),
      settle,
      tapNotice(null),
      model((m) => expect(shown(m.tapToast)).toEqual([])),
      settle,
      model((m) => expect(count(m.tapToast)).toBe(0)),
      Command.expectNone(),
    );
  });

  it("同じ文をもう一度受けても出ている文は 1 つだけ。別の文を受けると古い文は消えて新しい文だけが出る", () => {
    story(
      update,
      given(init()),
      tapNotice(TAP),
      settle,
      tapNotice(TAP),
      settle,
      model((m) => {
        expect(shown(m.tapToast)).toEqual([TAP]);
        expect(count(m.tapToast)).toBe(1);
      }),
      tapNotice("相手の音声を取得できていません"),
      model((m) => expect(shown(m.tapToast)).toEqual(["相手の音声を取得できていません"])),
      settle,
      model((m) => expect(count(m.tapToast)).toBe(1)),
    );
  });

  it("共有画面の知らせ・取り込みの知らせとは別の Toast。互いに影響しない", () => {
    story(
      update,
      given(init()),
      screen(SCREEN),
      settle,
      tapNotice(TAP),
      settle,
      intake("interrupted"),
      settle,
      model((m) => {
        expect(shown(m.screenToast)).toEqual([SCREEN]);
        expect(shown(m.tapToast)).toEqual([TAP]);
        expect(shown(m.intakeToast)).toEqual([INTERRUPTED]);
      }),
      tapNotice(null),
      settle,
      model((m) => {
        expect(shown(m.screenToast)).toEqual([SCREEN]);
        expect(shown(m.tapToast)).toEqual([]);
        expect(shown(m.intakeToast)).toEqual([INTERRUPTED]);
      }),
    );
  });
});

describe("sessionLayout の update: 見る状態の知らせ（Toast）", () => {
  it("auto のままなら何も出ない", () => {
    story(
      update,
      given(init()),
      viewing("auto"),
      model((m) => expect(count(m.viewingToast)).toBe(0)),
      Command.expectNone(),
    );
  });

  it("manual → overview → auto の順に、文が入れ替わり、最後に消える。時間では消えない", () => {
    story(
      update,
      given(init()),
      viewing("manual"),
      settle,
      model((m) => expect(shown(m.viewingToast)).toEqual([MANUAL])),
      Command.expectNone(),
      viewing("overview"),
      model((m) => expect(shown(m.viewingToast)).toEqual([OVERVIEW])),
      settle,
      model((m) => expect(count(m.viewingToast)).toBe(1)),
      Command.expectNone(),
      viewing("auto"),
      model((m) => expect(shown(m.viewingToast)).toEqual([])),
      settle,
      model((m) => expect(count(m.viewingToast)).toBe(0)),
      Command.expectNone(),
    );
  });

  it("overview → manual（Esc で戻るなど）でも、文が入れ替わる", () => {
    story(
      update,
      given(init()),
      viewing("overview"),
      settle,
      viewing("manual"),
      model((m) => expect(shown(m.viewingToast)).toEqual([MANUAL])),
      settle,
      model((m) => expect(count(m.viewingToast)).toBe(1)),
    );
  });

  it("同じ mode をもう一度受けても、出ている文は 1 つのまま", () => {
    story(
      update,
      given(init()),
      viewing("manual"),
      settle,
      viewing("manual"),
      settle,
      model((m) => {
        expect(shown(m.viewingToast)).toEqual([MANUAL]);
        expect(count(m.viewingToast)).toBe(1);
      }),
      Command.expectNone(),
    );
  });
});

describe("sessionLayout の update: 知らせは種類ごとに別の Toast で、互いに影響しない", () => {
  it("4 つの Toast は id が違い、スワイプでの消去は無効（maybeSwipeConfig が None）", () => {
    const m = init();
    expect(new Set([m.intakeToast.id, m.screenToast.id, m.tapToast.id, m.viewingToast.id]).size).toBe(4);
    for (const toast of [m.intakeToast, m.screenToast, m.tapToast, m.viewingToast]) expect(Option.isNone(toast.maybeSwipeConfig)).toBe(true);
  });

  it("3 種類を同時に出せる。1 つを消しても、残りは出たまま", () => {
    story(
      update,
      given(init()),
      intake("interrupted"),
      settle,
      screen(SCREEN),
      settle,
      viewing("manual"),
      settle,
      model((m) => {
        expect(shown(m.intakeToast)).toEqual([INTERRUPTED]);
        expect(shown(m.screenToast)).toEqual([SCREEN]);
        expect(shown(m.viewingToast)).toEqual([MANUAL]);
      }),
      screen(null),
      settle,
      model((m) => {
        expect(shown(m.intakeToast)).toEqual([INTERRUPTED]);
        expect(shown(m.screenToast)).toEqual([]);
        expect(shown(m.viewingToast)).toEqual([MANUAL]);
      }),
    );
  });

  it("「再開しました」の時間切れは、取り込みの知らせだけを消す（共有画面・見る状態は残る）", () => {
    story(
      update,
      given(init()),
      intake("interrupted"),
      settle,
      screen(SCREEN),
      settle,
      viewing("overview"),
      settle,
      intake("running"),
      settle,
      expire,
      settle,
      model((m) => {
        expect(count(m.intakeToast)).toBe(0);
        expect(shown(m.screenToast)).toEqual([SCREEN]);
        expect(shown(m.viewingToast)).toEqual([OVERVIEW]);
      }),
    );
  });
});

describe("sessionLayout の update: 差分を見ているときの一言", () => {
  it("overview → diff → overview → auto の順に、文が入れ替わり（全体のときの一言と同じ場所・同じ Toast）、最後に消える。時間では消えない", () => {
    story(
      update,
      given(init()),
      viewing("overview"),
      settle,
      model((m) => expect(shown(m.viewingToast)).toEqual([OVERVIEW])),
      viewing("diff"),
      model((m) => expect(shown(m.viewingToast)).toEqual([DIFF])),
      settle,
      model((m) => expect(count(m.viewingToast)).toBe(1)),
      Command.expectNone(),
      viewing("overview"),
      model((m) => expect(shown(m.viewingToast)).toEqual([OVERVIEW])),
      settle,
      viewing("diff"),
      settle,
      viewing("auto"),
      model((m) => expect(shown(m.viewingToast)).toEqual([])),
      settle,
      model((m) => expect(count(m.viewingToast)).toBe(0)),
      Command.expectNone(),
    );
  });

  it("manual → diff でも文が入れ替わる。diff の一言は、他の知らせと重ならず別の枠に出る", () => {
    story(
      update,
      given(init()),
      screen(SCREEN),
      settle,
      viewing("manual"),
      settle,
      viewing("diff"),
      settle,
      model((m) => {
        expect(shown(m.viewingToast)).toEqual([DIFF]);
        expect(shown(m.screenToast)).toEqual([SCREEN]);
      }),
    );
  });
});

describe("sessionLayout の update: 字幕・Toast に載せない知らせ", () => {
  it("ChangedCaptions で字幕を置き換える。字幕は初めは出す側（隠していない）", () => {
    expect(init().captionsHidden).toBe(false);
    story(
      update,
      given(init()),
      message(Message.ChangedCaptions({ captions: { _tag: "Bubbles", bubbles: [{ id: "a", side: "left", name: Option.some("相手 A"), label: Option.none(), nameState: "settled", colorIndex: 1, text: "議題は採用です。", settledLength: 8 }] } })),
      model((m) => expect(m.captions).toEqual({ _tag: "Bubbles", bubbles: [{ id: "a", side: "left", name: Option.some("相手 A"), label: Option.none(), nameState: "settled", colorIndex: 1, text: "議題は採用です。", settledLength: 8 }] })),
      message(Message.ChangedCaptions({ captions: { _tag: "Bubbles", bubbles: [] } })),
      model((m) => expect(m.captions).toEqual({ _tag: "Bubbles", bubbles: [] })),
      Command.expectNone(),
    );
  });

  it("字幕の出す・隠すは Disclosure の onToggle が運ぶ新しい状態（isOpen）で決まる。隠す状態は captionsHidden の 1 か所だけ", () => {
    story(
      update,
      given(init()),
      message(Message.ToggledCaptions({ isOpen: false })),
      model((m) => expect(m.captionsHidden).toBe(true)),
      message(Message.ToggledCaptions({ isOpen: true })),
      model((m) => expect(m.captionsHidden).toBe(false)),
      Command.expectNone(),
    );
  });

  it("字幕を隠しても、話している文字は残る（出し直すと続きが出る）", () => {
    story(
      update,
      given(init()),
      message(Message.ChangedCaptions({ captions: { _tag: "Bubbles", bubbles: [{ id: "a", side: "left", name: Option.some("相手 A"), label: Option.none(), nameState: "settled", colorIndex: 1, text: "議題は採用です。", settledLength: 8 }] } })),
      message(Message.ToggledCaptions({ isOpen: false })),
      message(Message.ChangedCaptions({ captions: { _tag: "Bubbles", bubbles: [{ id: "a", side: "left", name: Option.some("相手 A"), label: Option.none(), nameState: "settled", colorIndex: 1, text: "議題は採用です。次へ。", settledLength: 11 }] } })),
      model((m) => expect(m.captions).toEqual({ _tag: "Bubbles", bubbles: [{ id: "a", side: "left", name: Option.some("相手 A"), label: Option.none(), nameState: "settled", colorIndex: 1, text: "議題は採用です。次へ。", settledLength: 11 }] })),
    );
  });

  it("ReceivedDiffUpdate は差分更新の状態を Option で持つ。None で消える", () => {
    story(
      update,
      given(init()),
      message(Message.ReceivedDiffUpdate({ state: Option.some({ status: "paused", reason: "ChatGPT の利用上限" }) })),
      model((m) => expect(m.diffUpdate).toEqual(Option.some({ status: "paused", reason: "ChatGPT の利用上限" }))),
      message(Message.ReceivedDiffUpdate({ state: Option.none() })),
      model((m) => expect(Option.isNone(m.diffUpdate)).toBe(true)),
      Command.expectNone(),
    );
  });

  it("ReceivedSessionMode でローカルモードかどうかを置き換える", () => {
    story(
      update,
      given(init()),
      message(Message.ReceivedSessionMode({ local: true })),
      model((m) => expect(m.local).toBe(true)),
      message(Message.ReceivedSessionMode({ local: false })),
      model((m) => expect(m.local).toBe(false)),
      Command.expectNone(),
    );
  });
});

describe("sessionLayout の Model: 本物の Schema", () => {
  it("本物の Model は通り、「無い」を null で書いた Model・知らない値は通らない", () => {
    const is = Schema.is(Model);
    expect(is(init())).toBe(true);
    expect(is({ ...init(), diffUpdate: null })).toBe(false);
    expect(is({ ...init(), intake: null })).toBe(false);
    expect(is({ ...init(), intake: Option.some("unknown") })).toBe(false);
    expect(is({ ...init(), captionsHidden: "no" })).toBe(false);
    expect(is({ ...init(), diffUpdate: Option.some({ status: "paused" }) })).toBe(false);
  });

  it("update を通った後の Model も Schema に通る（Toast の中身を含む）", () => {
    story(
      update,
      given(init()),
      intake("interrupted"),
      settle,
      screen(SCREEN),
      settle,
      viewing("manual"),
      settle,
      model((m) => expect(Schema.is(Model)(m)).toBe(true)),
    );
  });
});
