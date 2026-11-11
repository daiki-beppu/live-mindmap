import { Duration, Option, Schema } from "effect";
import { Command, given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";
import { RESUMED_NOTICE_MS } from "../src/intake.ts";
import { KeyId } from "../src/app/keys/table.ts";
import { RestartBlink } from "../src/app/mapSurface/command.ts";
import { Message as MapSurfaceMessage } from "../src/app/mapSurface/message.ts";
import { spokenFrame } from "./fixtures/captions.ts";
import { Model as MeetingModel } from "../src/app/meeting/main.ts";
import { shownText } from "../src/app/sessionLayout/toast.ts";
import {
  connectedMessage,
  disconnectedMessage,
  FIRST,
  frameMessage,
  snapshotMessage,
  HEIGHTS,
  init,
  keyMessage,
  MANUAL,
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

const names = (result: { commands?: ReadonlyArray<{ name: string }> }): string[] => (result.commands ?? []).map((c) => c.name).sort();
const measured = surfaceMessage(MapSurfaceMessage.MeasuredMapSurface({ ...SIZE, cssNodeHeights: HEIGHTS }));

const run = (messages: ReadonlyArray<MeetingMessage>, from: Model = init(false)): { model: Model; commands?: ReadonlyArray<{ name: string }> } =>
  messages.reduce<{ model: Model; commands?: ReadonlyArray<{ name: string }> }>((acc, next) => update(acc.model, next), { model: from });

describe("会議中の update: 見る mode の知らせ", () => {
  const noticeOf = (m: Model) => Option.getOrNull(shownText(Option.getOrThrow(m.session).sessionLayout.viewingToast));

  it("セッションのない画面に最初の frame が届くとセッションができ、見る mode の知らせは出ない", () => {
    story(
      update,
      given(init(false)),
      model((m) => expect(Option.isNone(m.session)).toBe(true)),
      message(snapshotMessage(FIRST)),
      settleStory,
      model((m) => {
        expect(Option.isSome(m.session)).toBe(true);
        expect(noticeOf(m)).toBeNull();
      }),
    );
  });

  it("手動の知らせを表示した後、今の議題が変わる反映で自動に戻り知らせが消える", () => {
    story(
      update,
      given(run([snapshotMessage(FIRST), measured]).model),
      message(keyMessage("=")),
      settleStory,
      model((m) => expect(noticeOf(m)).toBe(MANUAL)),
      message(snapshotMessage(SECOND)),
      settleStory,
      model((m) => {
        expect(Option.getOrThrow(m.session).mapSurface.camera.mode).toBe("auto");
        expect(noticeOf(m)).toBeNull();
      }),
    );
  });
});

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
      snapshotMessage(FIRST),
      measured,
      keyMessage("="),
      keyMessage("?"),
      snapshotMessage(SECOND),
      disconnectedMessage(),
      connectedMessage(),
    ]);
    expect(isModel(after.model)).toBe(true);
  });

  it("スナップショットが届く前の Message では、画面の元になる値を変えても同じ初期の形（受信以外の入力は空振り）", () => {
    const start = init(false);
    for (const input of [measured, keyMessage("="), keyMessage("E"), keyMessage("?"), keyMessage("Escape")]) {
      const result = update(start, input);
      expect(names(result), JSON.stringify(input)).toEqual([]);
    }
  });
});

describe("会議中の update: キー（会議中の行だけ。見返しのキーは効かない）", () => {
  const REVIEW_ONLY = ["Space", "K", "J", "L", ",", ".", "<", ">", "Home", "End"] as const satisfies ReadonlyArray<typeof KeyId.Type>;
  const shown = run([snapshotMessage(SECOND), measured]).model;

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

  it("? の開閉と Escape で一覧を閉じるたびに idleStamp が 1 進み、ほかの表示面の状態は変わらない", () => {
    let current = update(shown, keyMessage("=")).model;
    expect(Option.getOrThrow(current.session).mapSurface.camera.mode).toBe("manual");
    for (const [key, isOpen] of [["?", true], ["?", false], ["?", true], ["Escape", false]] as const) {
      const before = Option.getOrThrow(current.session).mapSurface;
      current = update(current, keyMessage(key)).model;
      const session = Option.getOrThrow(current.session);
      expect(session.keyList.isOpen, key).toBe(isOpen);
      expect(session.mapSurface, key).toEqual({ ...before, idleStamp: before.idleStamp + 1 });
    }
  });
});

describe("会議中の update: 狭い幅で開いたときの右の列と字幕", () => {
  const sessionOf = (m: Model) => {
    if (m.session._tag === "None") throw new Error("スナップショットを受けた後なのに画面の部品がありません");
    return m.session.value;
  };
  const hidden = (m: Model) => ({ side: sessionOf(m).mapSurface.viewing.sideHidden === true, captions: sessionOf(m).sessionLayout.captionsHidden });

  it("狭い幅で開くと、最初のスナップショットで右の列と字幕を隠して始め、E・C で出せる", () => {
    const opened = run([snapshotMessage(FIRST), measured], init(false, { startsNarrow: true })).model;
    expect(Schema.is(MeetingModel)(opened)).toBe(true);
    expect(hidden(opened)).toEqual({ side: true, captions: true });
    expect(hidden(run([keyMessage("E"), keyMessage("C")], opened).model)).toEqual({ side: false, captions: false });
  });

  it("広い幅で開くと、今までどおり両方出して始める", () => {
    expect(hidden(run([snapshotMessage(FIRST), measured], init(false, { startsNarrow: false })).model)).toEqual({ side: false, captions: false });
  });

  it("開いた後は、次のスナップショットでも画面の大きさが変わっても、隠す・出すは変わらない（人の操作を上書きしない）", () => {
    const resized = surfaceMessage(MapSurfaceMessage.MeasuredMapSurface({ width: 390, height: 844, cssNodeHeights: HEIGHTS }));
    const hiddenAtStart = run([snapshotMessage(FIRST), measured], init(false, { startsNarrow: true })).model;
    expect(hidden(run([snapshotMessage(SECOND), resized], hiddenAtStart).model)).toEqual({ side: true, captions: true });
    const shownByHand = run([keyMessage("E"), keyMessage("C")], hiddenAtStart).model;
    expect(hidden(run([snapshotMessage(SECOND), resized], shownByHand).model)).toEqual({ side: false, captions: false });
    const shownAtStart = run([snapshotMessage(FIRST), measured], init(false, { startsNarrow: false })).model;
    expect(hidden(run([resized], shownAtStart).model)).toEqual({ side: false, captions: false });
  });
});

describe("会議中の update: M（自分の休止・再開。Issue #1069）", () => {
  const shown = run([snapshotMessage(SECOND), measured]).model;
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
  const first = run([snapshotMessage(FIRST), measured]).model;

  it("最初のスナップショット・変わったこと無しの反映・同じ反映の再送・知らせの frame では出ない", () => {
    expect(names(update(init(false), snapshotMessage(FIRST)))).not.toContain("RestartBlink");
    const second = run([snapshotMessage(SECOND), measured]).model;
    expect(names(update(second, snapshotMessage(THIRD_QUIET)))).not.toContain("RestartBlink");
    expect(names(update(second, snapshotMessage(SECOND)))).not.toContain("RestartBlink");
    expect(names(update(first, frameMessage({ type: "intake", status: "running" })))).not.toContain("RestartBlink");
  });

  it("同じ Model に続けて反映を流しても、反映ごとに RestartBlink を出し、解いた後の続きの反映も受ける（Command を解いて次へ進める）", () => {
    story(
      update,
      given(init(false)),
      message(snapshotMessage(FIRST)),
      message(measured),
      message(snapshotMessage(SECOND)),
      Command.expectExact(RestartBlink),
      settleStory,
      message(snapshotMessage({ ...SECOND, round: 3, changes: [...SECOND.changes, { round: 3, at: 40, change: "更新", node: "A", kind: "議題", text: "採用" }] })),
      Command.expectExact(RestartBlink),
      settleStory,
      model((m) => expect(Schema.is(MeetingModel)(m)).toBe(true)),
    );
  });
});

describe("会議中の update: 取り込みの知らせの時間（RESUMED_NOTICE_MS）", () => {
  it("途切れ・止まったは時間では消えない。『再開しました』だけが RESUMED_NOTICE_MS の時間切れの Command を持つ", () => {
    const interrupted = run([snapshotMessage(FIRST), frameMessage({ type: "intake", status: "interrupted" })]);
    expect(names(interrupted).filter((n) => n === "WaitBeforeDismissal")).toEqual([]);
    const stopped = run([frameMessage({ type: "intake", status: "stopped" })], run([snapshotMessage(FIRST)]).model);
    expect(names(stopped).filter((n) => n === "WaitBeforeDismissal")).toEqual([]);
    const settled = settleThrough(interrupted.model);
    const resumed = update(settled, frameMessage({ type: "intake", status: "running" }));
    const timers = (resumed.commands ?? []).filter((c) => c.name === "WaitBeforeDismissal");
    expect(timers).toHaveLength(1);
    expect(Duration.toMillis((timers[0] as unknown as { args: { duration: Duration.Duration } }).args.duration)).toBe(RESUMED_NOTICE_MS);
  });
});

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
    const result = run([snapshotMessage(FIRST), connectedMessage(), disconnectedMessage(), connectedMessage(), disconnectedMessage()]);
    expect(Schema.is(MeetingModel)(result.model)).toBe(true);
    expect(result.model).not.toEqual(init(false));
    expect(names(result).filter((n) => n === "RestartBlink")).toEqual([]);
  });
});
