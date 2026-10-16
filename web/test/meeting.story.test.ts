import { Duration, Schema } from "effect";
import { Command, given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";
import { RESUMED_NOTICE_MS } from "../src/intake.ts";
import { KeyId } from "../src/app/keys/table.ts";
import { RestartBlink } from "../src/app/mapSurface/command.ts";
import { Message as MapSurfaceMessage } from "../src/app/mapSurface/message.ts";
import { spokenFrame } from "./fixtures/captions.ts";
import { Model as MeetingModel } from "../src/app/meeting/main.ts";
import {
  connectedMessage,
  disconnectedMessage,
  FIRST,
  frameMessage,
  HEIGHTS,
  init,
  keyMessage,
  SECOND,
  settleStory,
  SIZE,
  surfaceMessage,
  THIRD_QUIET,
  TAP,
  update,
  type MeetingMessage,
  type Model,
} from "./meetingHarness.ts";

// 会議中の Foldkit プログラム（Issue #829）の update の Story。update を直接動かし、Model が Schema に通ること・出る Command・キーの意味（会議中の行だけ）を見る。
// 描いた木に出るもの（待ち表示・並び・知らせの文言・マップ・右の列）は meeting.scene.test.ts が見る。
// Story は保留の Command を残したまま次の Message を送れない。出す・消すときの Toast の動きと点滅の再生し直しは settleStory で解く

const names = (result: { commands?: ReadonlyArray<{ name: string }> }): string[] => (result.commands ?? []).map((c) => c.name).sort();
const measured = surfaceMessage(MapSurfaceMessage.MeasuredMapSurface({ ...SIZE, nodeHeights: HEIGHTS }));

// 続けて流して、最後の update の結果を返す（途中の Command は読み捨てる。Model の組み立て用）
const run = (messages: ReadonlyArray<MeetingMessage>, from: Model = init(false)): { model: Model; commands?: ReadonlyArray<{ name: string }> } =>
  messages.reduce<{ model: Model; commands?: ReadonlyArray<{ name: string }> }>((acc, next) => update(acc.model, next), { model: from });

describe("会議中の update: Model は本物の Schema に通る", () => {
  it("初期の Model と、受信・測定・キーを続けて流した後の Model は、Model の Schema に通る", () => {
    const isModel = Schema.is(MeetingModel);
    expect(isModel(init(false))).toBe(true);
    expect(isModel(init(true))).toBe(true);
    const after = run([
      connectedMessage(),
      frameMessage(spokenFrame("字幕です。", "相手")),
      frameMessage({ type: "intake", status: "interrupted" }),
      frameMessage({ type: "screen-notice", text: "共有画面は使っていません" }),
      frameMessage({ type: "tap-notice", text: TAP }),
      frameMessage({ type: "diff-update", state: { status: "paused", reason: "ChatGPT の利用上限" } }),
      frameMessage({ type: "session-mode", local: true }),
      frameMessage(FIRST),
      measured,
      keyMessage("="),
      keyMessage("?"),
      frameMessage(SECOND),
      disconnectedMessage(),
      connectedMessage(),
    ]);
    expect(isModel(after.model)).toBe(true);
  });

  it("スナップショットが届く前の Message では、画面の元になる値を変えても同じ初期の形（受信以外の入力は空振り）", () => {
    // 表示面・キーは、スナップショットが届くまで（表示面が無い間）は何も起こさない
    const start = init(false);
    for (const input of [measured, keyMessage("="), keyMessage("E"), keyMessage("?"), keyMessage("Escape")]) {
      const result = update(start, input);
      expect(names(result), JSON.stringify(input)).toEqual([]);
    }
  });
});

describe("会議中の update: キー（会議中の行だけ。見返しのキーは効かない）", () => {
  const REVIEW_ONLY = ["Space", "K", "J", "L", ",", ".", "<", ">", "Home", "End"] as const satisfies ReadonlyArray<typeof KeyId.Type>;
  const shown = run([frameMessage(SECOND), measured]).model;

  it("見返しのキーを押しても Model は変わらず、Command も出ない（スナップショットの前でも後でも）", () => {
    for (const key of REVIEW_ONLY) {
      for (const from of [init(false), shown]) {
        const result = update(from, keyMessage(key));
        expect(result.model, key).toEqual(from);
        expect(names(result), key).toEqual([]);
      }
    }
  });

  it("どの KeyId を受けても例外にならず、Model は Schema に通る（キーの表の全部の行を update が受ける）", () => {
    for (const key of KeyId.literals) {
      const result = update(shown, keyMessage(key));
      expect(Schema.is(MeetingModel)(result.model), key).toBe(true);
    }
  });

  it("会議中のキーは Model を変える: = で拡大、E・C・? は画面の状態を変える", () => {
    for (const key of ["=", "F", "E", "C", "?"] as const) expect(update(shown, keyMessage(key)).model, key).not.toEqual(shown);
  });

  it("C・E・? は、⌘・Ctrl・Option と一緒なら何も変えない", () => {
    for (const key of ["C", "E", "?"] as const) {
      for (const mods of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
        const result = update(shown, keyMessage(key, mods));
        expect(result.model, `${key} ${JSON.stringify(mods)}`).toEqual(shown);
        expect(names(result)).toEqual([]);
      }
    }
  });

  it("C は 2 回押すと元に戻る（反転）", () => {
    for (const key of ["C"] as const) {
      const once = run([keyMessage(key)], shown);
      expect(once.model, key).not.toEqual(shown);
      expect(run([keyMessage(key)], once.model).model, key).toEqual(shown);
    }
  });
});

// 狭い幅で開いたとき（Issue #1236 の一部）: 画面の部品は最初のスナップショットで作るので、そのときに右の列と字幕を隠して始める。E・C で今までどおり出せる
describe("会議中の update: 狭い幅で開いたときの右の列と字幕", () => {
  const sessionOf = (m: Model) => {
    if (m.session._tag === "None") throw new Error("スナップショットを受けた後なのに画面の部品がありません");
    return m.session.value;
  };
  const hidden = (m: Model) => ({ side: sessionOf(m).mapSurface.viewing.sideHidden === true, captions: sessionOf(m).sessionLayout.captionsHidden });

  it("狭い幅で開くと、最初のスナップショットで右の列と字幕を隠して始め、E・C で出せる", () => {
    const opened = run([frameMessage(FIRST), measured], init(false, { startsNarrow: true })).model;
    expect(Schema.is(MeetingModel)(opened)).toBe(true);
    expect(hidden(opened)).toEqual({ side: true, captions: true });
    expect(hidden(run([keyMessage("E"), keyMessage("C")], opened).model)).toEqual({ side: false, captions: false });
  });

  it("広い幅で開くと、今までどおり両方出して始める", () => {
    expect(hidden(run([frameMessage(FIRST), measured], init(false, { startsNarrow: false })).model)).toEqual({ side: false, captions: false });
  });

  it("開いた後は、次のスナップショットでも画面の大きさが変わっても、隠す・出すは変わらない（人の操作を上書きしない）", () => {
    const resized = surfaceMessage(MapSurfaceMessage.MeasuredMapSurface({ width: 390, height: 844, nodeHeights: HEIGHTS }));
    const hiddenAtStart = run([frameMessage(FIRST), measured], init(false, { startsNarrow: true })).model;
    expect(hidden(run([frameMessage(SECOND), resized], hiddenAtStart).model)).toEqual({ side: true, captions: true });
    const shownByHand = run([keyMessage("E"), keyMessage("C")], hiddenAtStart).model;
    expect(hidden(run([frameMessage(SECOND), resized], shownByHand).model)).toEqual({ side: false, captions: false });
    const shownAtStart = run([frameMessage(FIRST), measured], init(false, { startsNarrow: false })).model;
    expect(hidden(run([resized], shownAtStart).model)).toEqual({ side: false, captions: false });
  });
});

describe("会議中の update: M（自分の休止・再開。Issue #1069）", () => {
  const shown = run([frameMessage(SECOND), measured]).model;
  const requested = (result: { commands?: ReadonlyArray<{ name: string }> }) =>
    (result.commands ?? []).filter((c) => c.name === "RequestSelfPause").map((c) => (c as unknown as { args: { paused: boolean } }).args.paused);

  it("見えている状態の逆を指示の Command に載せる。Model は変えない（状態は frame でだけ変わる）", () => {
    const first = update(shown, keyMessage("M"));
    expect(requested(first)).toEqual([true]);
    expect(first.model).toEqual(shown);

    const paused = run([frameMessage({ type: "self-pause", paused: true, reason: "自動" })], shown).model;
    const second = update(paused, keyMessage("M"));
    expect(requested(second)).toEqual([false]);
    expect(second.model).toEqual(paused);
  });

  it("休止の frame が来るたびに、次の M が送る値が追従する（休止 → 再開 → 休止）", () => {
    let current = shown;
    for (const paused of [true, false, true]) {
      current = update(current, frameMessage(paused ? { type: "self-pause", paused, reason: "手動" } : { type: "self-pause", paused })).model;
      expect(requested(update(current, keyMessage("M")))).toEqual([!paused]);
    }
  });

  it("⌘・Ctrl・Option と一緒なら何も出さない。スナップショットの前でも出さない", () => {
    for (const mods of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      const result = update(shown, keyMessage("M", mods));
      expect(result.model, JSON.stringify(mods)).toEqual(shown);
      expect(names(result), JSON.stringify(mods)).toEqual([]);
    }
    const waiting = update(init(false), keyMessage("M"));
    expect(names(waiting)).toEqual([]);
    expect(waiting.model).toEqual(init(false));
  });
});

describe("会議中の update: 反映で点滅の再生し直し（RestartBlink）を出す", () => {
  const first = run([frameMessage(FIRST), measured]).model;

  it("測定済みで、反映の番号が変わり、変わったノードがある反映のときだけ出る", () => {
    expect(names(update(first, frameMessage(SECOND)))).toEqual(["RestartBlink"]);
  });

  it("最初のスナップショット（まだ表示面が無い）・測る前の反映・変わったこと無しの反映・同じ反映の再送・字幕や知らせの frame では出ない", () => {
    expect(names(update(init(false), frameMessage(FIRST)))).not.toContain("RestartBlink");
    const unmeasured = run([frameMessage(FIRST)]).model;
    expect(names(update(unmeasured, frameMessage(SECOND)))).not.toContain("RestartBlink");
    const second = run([frameMessage(SECOND), measured]).model;
    expect(names(update(second, frameMessage(THIRD_QUIET)))).not.toContain("RestartBlink");
    expect(names(update(second, frameMessage(SECOND)))).not.toContain("RestartBlink");
    expect(names(update(first, frameMessage(spokenFrame("字幕。", "相手"))))).not.toContain("RestartBlink");
    expect(names(update(first, frameMessage({ type: "intake", status: "running" })))).not.toContain("RestartBlink");
  });

  it("同じ Model に続けて反映を流しても、反映ごとに RestartBlink を出し、解いた後の続きの反映も受ける（Command を解いて次へ進める）", () => {
    story(
      update,
      given(init(false)),
      message(frameMessage(FIRST)),
      message(measured),
      message(frameMessage(SECOND)),
      Command.expectExact(RestartBlink),
      settleStory,
      message(frameMessage({ ...SECOND, round: 3, changes: [...SECOND.changes, { round: 3, at: 40, change: "更新", node: "A", kind: "議題", text: "採用" }] })),
      Command.expectExact(RestartBlink),
      settleStory,
      model((m) => expect(Schema.is(MeetingModel)(m)).toBe(true)),
    );
  });
});

describe("会議中の update: 取り込みの知らせの時間（RESUMED_NOTICE_MS）", () => {
  it("途切れ・止まったは時間では消えない。『再開しました』だけが RESUMED_NOTICE_MS の時間切れの Command を持つ", () => {
    const interrupted = run([frameMessage(FIRST), frameMessage({ type: "intake", status: "interrupted" })]);
    expect(names(interrupted).filter((n) => n === "WaitBeforeDismissal")).toEqual([]);
    const stopped = run([frameMessage({ type: "intake", status: "stopped" })], run([frameMessage(FIRST)]).model);
    expect(names(stopped).filter((n) => n === "WaitBeforeDismissal")).toEqual([]);
    const settled = settleThrough(interrupted.model);
    const resumed = update(settled, frameMessage({ type: "intake", status: "running" }));
    const timers = (resumed.commands ?? []).filter((c) => c.name === "WaitBeforeDismissal");
    expect(timers).toHaveLength(1);
    expect(Duration.toMillis((timers[0] as unknown as { args: { duration: Duration.Duration } }).args.duration)).toBe(RESUMED_NOTICE_MS);
  });
});

// 保留の動き（Toast の出入り）を解いた後の Model を取り出す。Story の settle を Model だけに適用する
const settleThrough = (from: Model): Model => {
  let out: Model = from;
  story(
    update,
    given(from),
    settleStory,
    model((m) => {
      out = m;
    }),
  );
  return out;
};

describe("会議中の update: 受信の事実の順に依らず、画面が出た後は最新の値になる", () => {
  it("つながった・切れた を繰り返しても Model は Schema に通り、スナップショットは保たれる（切れても画面は消えない）", () => {
    const result = run([frameMessage(FIRST), connectedMessage(), disconnectedMessage(), connectedMessage(), disconnectedMessage()]);
    expect(Schema.is(MeetingModel)(result.model)).toBe(true);
    // 画面が出ている（待ち表示に戻らない）ことは、最初のスナップショットの前の Model と違うことで見る
    expect(result.model).not.toEqual(init(false));
    expect(names(result).filter((n) => n === "RestartBlink")).toEqual([]);
  });
});
